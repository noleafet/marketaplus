"""CoinMarketCal event scraping for the watchlist.

Every run scrapes each pair's coin page (``https://coinmarketcal.com/coin/<slug>``) and keeps
only upcoming events; rows whose date has passed are deleted. The page ships its event payload
as Next.js flight data, which includes the 0-10 impact score. A score of 5.0 and above counts as
high impact and 8.0 and above as critical.

The coin slug in the page URL is resolved from CoinGecko's public coin catalog, because tickers
collide across projects and CoinMarketCal uses the same coin ids.
"""

from datetime import datetime, timedelta, timezone as dt_timezone
import json
import logging
import re
import threading

import requests
from django.utils import timezone

from .models import MarketEvent, WatchlistSymbol

logger = logging.getLogger(__name__)

COINMARKETCAL_COIN_URL = "https://coinmarketcal.com/coin/{slug}"
COINMARKETCAL_EVENT_URL = "https://coinmarketcal.com/event/{slug}"
COINMARKETCAL_TIMEOUT = 20
COINMARKETCAL_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

# Coin slugs come from CoinGecko's free catalog: its coin id ("bitcoin", "shiba-inu") is the
# slug CoinMarketCal uses in its coin URLs, so no API key is needed to resolve one.
COINGECKO_COINS_URL = "https://api.coingecko.com/api/v3/coins/list"
COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets"
COINGECKO_TIMEOUT = 20
COINGECKO_CATALOG_TTL = timedelta(hours=24)
COINGECKO_PAGE_SIZE = 250
# Only the largest coins are ranked; ties outside this list fall back to the shortest id.
COINGECKO_RANK_PAGES = 1
MAX_RANK = 10 ** 9

# Scraped impact scores are 0-10; the site's own bands are re-cut here as requested.
CRITICAL_IMPACT_MIN_SCORE = 8.0
HIGH_IMPACT_MIN_SCORE = 5.0

QUOTE_ASSETS = (
    "USDT", "USDC", "FDUSD", "TUSD", "BUSD", "USDP", "DAI", "USD",
    "BTC", "ETH", "BNB", "EUR", "TRY", "BRL", "GBP", "AUD", "JPY", "RUB", "UAH", "NGN", "ZAR",
)

# Next.js server components stream their payload as escaped JSON string chunks.
_FLIGHT_CHUNK = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')
_EVENT_LIST_KEY = '"events":'

# The CoinGecko catalog and market-cap ranking are large and change slowly, so each is fetched
# at most once a day. Ranking is a single request over the largest coins.
_catalog_lock = threading.Lock()
_catalog_cache = {"fetched_at": None, "by_symbol": None}
_ranks_cache = {"fetched_at": None, "ranks": None}


class MarketEventError(Exception):
    """Raised when an event provider cannot answer with a usable payload."""


class CoinMarketCalError(MarketEventError):
    """Raised when a CoinMarketCal page cannot be scraped."""


class CoinGeckoError(MarketEventError):
    """Raised when the CoinGecko coin catalog cannot be read."""


def base_coin_symbol(symbol):
    """Turn an exchange pair such as BTCUSDT into the coin ticker BTC."""
    value = (symbol or "").strip().upper()
    for quote_asset in sorted(QUOTE_ASSETS, key=len, reverse=True):
        if value.endswith(quote_asset) and len(value) > len(quote_asset):
            return value[: -len(quote_asset)]
    return value


def coin_candidates(symbol):
    """Lowercase tickers the provider may use for a watchlist pair.

    Exchange pairs add size prefixes to some coins (1000SHIBUSDT, 1MBABYDOGEUSDT) while the
    calendar uses the underlying ticker, so both spellings are requested.
    """
    base = base_coin_symbol(symbol).lower()
    candidates = {base} if base else set()
    for prefix in ("1000000", "100000", "10000", "1000", "1m"):
        if base.startswith(prefix) and len(base) > len(prefix):
            candidates.add(base[len(prefix):])
    return candidates


def normalize_impact(raw):
    """Return (label, score) for a scraped 0-10 impact score."""
    if raw is None or raw == "":
        return MarketEvent.Impact.UNKNOWN, None
    try:
        score = float(raw)
    except (TypeError, ValueError):
        return MarketEvent.Impact.UNKNOWN, None
    if score >= CRITICAL_IMPACT_MIN_SCORE:
        return MarketEvent.Impact.CRITICAL, score
    if score >= HIGH_IMPACT_MIN_SCORE:
        return MarketEvent.Impact.HIGH, score
    return MarketEvent.Impact.LOW, score


def _utc_today():
    return timezone.now().astimezone(dt_timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0,
    )


def _parse_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        moment = value
    else:
        text = str(value).strip()
        # Flight data references serialised dates with a "$D" prefix.
        if text.startswith("$D"):
            text = text[2:]
        try:
            moment = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            try:
                moment = datetime.strptime(text, "%Y-%m-%d").replace(tzinfo=dt_timezone.utc)
            except ValueError:
                return None
    if timezone.is_naive(moment):
        moment = moment.replace(tzinfo=dt_timezone.utc)
    return moment.astimezone(dt_timezone.utc)


def _coingecko_get(url, params):
    try:
        response = requests.get(
            url,
            headers={"Accept": "application/json"},
            params=params,
            timeout=COINGECKO_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise CoinGeckoError(f"CoinGecko request failed: {exc}") from exc
    if response.status_code == 429:
        raise CoinGeckoError("CoinGecko rate limit reached.")
    try:
        response.raise_for_status()
    except requests.RequestException as exc:
        raise CoinGeckoError(f"CoinGecko request failed: {exc}") from exc
    try:
        return response.json()
    except ValueError as exc:
        raise CoinGeckoError("CoinGecko returned invalid JSON.") from exc


def _fetch_coin_catalog():
    """Build a ``ticker -> [coin id]`` index from CoinGecko's full coin list."""
    payload = _coingecko_get(COINGECKO_COINS_URL, {"include_platform": "false"})
    if not isinstance(payload, list):
        raise CoinGeckoError("CoinGecko returned an unexpected payload.")
    by_symbol = {}
    for coin in payload:
        if not isinstance(coin, dict):
            continue
        coin_id = str(coin.get("id") or "").strip()
        coin_symbol = str(coin.get("symbol") or "").strip().lower()
        if not coin_id or not coin_symbol:
            continue
        by_symbol.setdefault(coin_symbol, []).append(coin_id)
    return by_symbol


def coin_catalog():
    """Return the cached ticker index, refreshing it once a day."""
    with _catalog_lock:
        fetched_at = _catalog_cache["fetched_at"]
        if fetched_at is not None and timezone.now() - fetched_at < COINGECKO_CATALOG_TTL:
            return _catalog_cache["by_symbol"]
        by_symbol = _fetch_coin_catalog()
        _catalog_cache["by_symbol"] = by_symbol
        _catalog_cache["fetched_at"] = timezone.now()
        return by_symbol


def _fetch_market_cap_ranks():
    """Market-cap rank per coin id for the most valuable coins."""
    ranks = {}
    for page in range(1, COINGECKO_RANK_PAGES + 1):
        payload = _coingecko_get(
            COINGECKO_MARKETS_URL,
            {
                "vs_currency": "usd",
                "order": "market_cap_desc",
                "per_page": COINGECKO_PAGE_SIZE,
                "page": page,
                "sparkline": "false",
            },
        )
        if not isinstance(payload, list):
            raise CoinGeckoError("CoinGecko returned an unexpected payload.")
        for coin in payload:
            if not isinstance(coin, dict):
                continue
            coin_id = str(coin.get("id") or "").strip()
            rank = coin.get("market_cap_rank")
            if coin_id and isinstance(rank, int):
                ranks[coin_id] = rank
    return ranks


def market_cap_ranks():
    """Return the cached rank index, refreshing it once a day."""
    with _catalog_lock:
        fetched_at = _ranks_cache["fetched_at"]
        if fetched_at is not None and timezone.now() - fetched_at < COINGECKO_CATALOG_TTL:
            return _ranks_cache["ranks"]
        ranks = _fetch_market_cap_ranks()
        _ranks_cache["ranks"] = ranks
        _ranks_cache["fetched_at"] = timezone.now()
        return ranks


def clear_coin_catalog_cache():
    """Forget the cached CoinGecko data; the next lookup fetches it again."""
    with _catalog_lock:
        _catalog_cache["by_symbol"] = None
        _catalog_cache["fetched_at"] = None
        _ranks_cache["ranks"] = None
        _ranks_cache["fetched_at"] = None


def _market_cap_rank_index():
    """Best-effort rank index; ranking only refines which same-ticker coin wins."""
    try:
        return market_cap_ranks()
    except CoinGeckoError as exc:
        logger.warning("CoinGecko ranking failed: %s", exc)
        return {}


def _best_coin_id(coin_ids, ranks):
    """Pick the most prominent of several coins that share a ticker."""
    return min(
        coin_ids,
        key=lambda coin_id: (ranks.get(coin_id, MAX_RANK), len(coin_id), coin_id),
    )


def resolve_coin_slug(symbol):
    """Return the canonical coin slug for a watchlist pair.

    Slugs are CoinGecko coin ids (``bitcoin``, ``shiba-inu``), the same ids CoinMarketCal uses
    in its coin URLs. The catalog is searched by ticker and the most prominent exact match is
    chosen. Size-prefixed pairs (``1000SHIBUSDT``) map to the underlying coin unless the
    prefixed ticker is itself a bigger market. Returns ``""`` when the catalog was read
    successfully but nothing matched.
    """
    candidates = coin_candidates(symbol)
    if not candidates:
        return ""
    catalog = coin_catalog()
    matches = {
        candidate: catalog[candidate]
        for candidate in candidates
        if catalog.get(candidate)
    }
    if not matches:
        return ""
    # Ranking is only needed when a ticker is ambiguous (many coins share it) or when the pair
    # had a size prefix stripped and both spellings exist.
    ambiguous = len(matches) > 1 or sum(len(ids) for ids in matches.values()) > 1
    ranks = _market_cap_rank_index() if ambiguous else {}
    slugs = {
        candidate: _best_coin_id(coin_ids, ranks)
        for candidate, coin_ids in matches.items()
    }
    # Prefer the most prominent coin; ties go to the shorter ticker, so a size-prefixed pair
    # falls back to the underlying coin (SHIB rather than 1000SHIB).
    return min(
        slugs.items(),
        key=lambda item: (ranks.get(item[1], MAX_RANK), len(item[0]), len(item[1]), item[1]),
    )[1]


def resolve_watchlist_slug(entry, *, refresh=False):
    """Resolve and cache one watchlist pair's slug; returns the stored slug (``""`` if unknown)."""
    if entry.slug and not refresh:
        return entry.slug
    slug = resolve_coin_slug(entry.symbol)
    if slug and slug != entry.slug:
        entry.slug = slug
        entry.save(update_fields=["slug"])
    return entry.slug


def ensure_watchlist_slugs(entries):
    """Fill in missing slugs for the watchlist; failures are logged, never raised."""
    for entry in entries:
        if entry.slug:
            continue
        try:
            resolve_watchlist_slug(entry)
        except MarketEventError as exc:
            logger.warning(
                "Could not resolve a coin slug for %s: %s", entry.symbol, exc,
            )


def _fetch_coin_page(slug):
    """Download one coin's calendar page."""
    try:
        response = requests.get(
            COINMARKETCAL_COIN_URL.format(slug=slug),
            headers={
                "User-Agent": COINMARKETCAL_USER_AGENT,
                "Accept": "text/html,application/xhtml+xml",
            },
            timeout=COINMARKETCAL_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise CoinMarketCalError(f"CoinMarketCal request failed: {exc}") from exc
    if response.status_code == 404:
        raise CoinMarketCalError(f"CoinMarketCal has no coin page for {slug}.")
    if response.status_code == 429:
        raise CoinMarketCalError("CoinMarketCal rate limit reached.")
    try:
        response.raise_for_status()
    except requests.RequestException as exc:
        raise CoinMarketCalError(f"CoinMarketCal request failed: {exc}") from exc
    return response.text


def _flight_payload(html):
    """Join the escaped Next.js flight chunks into one payload string."""
    chunks = []
    for match in _FLIGHT_CHUNK.finditer(html):
        try:
            chunks.append(json.loads(match.group(1)))
        except ValueError:
            continue
    return "".join(chunks)


def _event_batches(payload):
    """Return every ``"events": [...]`` array embedded in the flight payload."""
    batches = []
    decoder = json.JSONDecoder()
    index = payload.find(_EVENT_LIST_KEY)
    while index != -1:
        start = payload.find("[", index + len(_EVENT_LIST_KEY))
        if start != -1:
            try:
                batch, _end = decoder.raw_decode(payload, start)
            except ValueError:
                batch = None
            if isinstance(batch, list):
                batches.append(batch)
        index = payload.find(_EVENT_LIST_KEY, index + len(_EVENT_LIST_KEY))
    return batches


def fetch_coin_events(slug):
    """Scrape a coin page and return its upcoming events, oldest first."""
    html = _fetch_coin_page(slug)
    batches = _event_batches(_flight_payload(html))
    if not batches:
        # A scraped page always carries its event lists, even when they are empty, so a
        # missing payload means the markup changed rather than a quiet calendar.
        raise CoinMarketCalError(f"CoinMarketCal returned no event data for {slug}.")
    today = _utc_today()
    upcoming = {}
    for batch in batches:
        for event in batch:
            if not isinstance(event, dict):
                continue
            event_date = _parse_datetime(event.get("dateEvent"))
            if event_date is None or event_date < today:
                continue
            external_id = str(event.get("id") or "").strip()
            if external_id:
                upcoming[external_id] = event
    return sorted(upcoming.values(), key=lambda event: _parse_datetime(event.get("dateEvent")))


def store_events(symbol, slug, events):
    """Persist scraped events for one watchlist pair and return how many rows were written."""
    stored = 0
    today = _utc_today()
    for event in events or []:
        if not isinstance(event, dict):
            continue
        external_id = str(event.get("id") or "").strip()
        title = str(event.get("title") or "").strip()
        event_date = _parse_datetime(event.get("dateEvent"))
        if not external_id or not title or event_date is None or event_date < today:
            continue
        impact, impact_score = normalize_impact(event.get("impactScore"))
        coin_symbol = ""
        for coin in event.get("coins") or []:
            if isinstance(coin, dict) and str(coin.get("id") or "").strip() == slug:
                coin_symbol = str(coin.get("symbol") or "").strip().lower()
                break
        categories = [
            str(category.get("name") or "").strip()
            for category in event.get("categories") or []
            if isinstance(category, dict) and str(category.get("name") or "").strip()
        ]
        source_url = str(event.get("link") or "").strip()
        if not source_url.startswith("http"):
            event_slug = str(event.get("slug") or "").strip()
            source_url = COINMARKETCAL_EVENT_URL.format(slug=event_slug) if event_slug else ""
        date_type = event.get("dateType")
        is_estimated = (
            bool(date_type) if isinstance(date_type, bool)
            else str(event.get("dateTypeSelected") or "date") != "date"
        )
        defaults = {
            "coin_symbol": coin_symbol,
            "title": title[:240],
            "description": str(event.get("description") or "")[:4000],
            "date": event_date,
            "date_end": _parse_datetime(event.get("dateEventTo")),
            "displayed_date": str(event.get("dateEventDisplayed") or "")[:80],
            "impact": impact,
            "impact_score": impact_score,
            "impact_summary": str(event.get("impactSummary") or "")[:500],
            "source_url": source_url[:500],
            "categories": categories,
            "is_estimated": is_estimated,
        }
        MarketEvent.objects.update_or_create(
            external_id=external_id, symbol=symbol, defaults=defaults,
        )
        stored += 1
    return stored


def purge_market_events(symbols=None):
    """Drop past rows, which are no longer scraped, and rows for removed pairs."""
    queryset = MarketEvent.objects.all()
    if symbols is not None:
        queryset = queryset.filter(symbol__in=list(symbols))
    past = queryset.filter(date__lt=_utc_today())
    past_count = past.count()
    past.delete()
    removed_unknown_symbols = 0
    if symbols is None:
        valid_symbols = set(WatchlistSymbol.objects.values_list("symbol", flat=True))
        stale = MarketEvent.objects.exclude(symbol__in=valid_symbols)
        removed_unknown_symbols = stale.count()
        stale.delete()
    return {
        "past": past_count,
        "removed_unknown_symbols": removed_unknown_symbols,
    }


def _watchlist_entries(symbols=None):
    entries = list(WatchlistSymbol.objects.all())
    if symbols is not None:
        wanted = {str(symbol).strip().upper() for symbol in symbols}
        entries = [entry for entry in entries if entry.symbol.upper() in wanted]
    return entries


def sync_market_events(*, symbols=None, stdout=None):
    """Scrape upcoming events for the watchlist and drop rows that are no longer live.

    ``stdout`` is the Django command output stream when called from a management command.
    The return value is a small summary used for logging and tests.
    """
    write = stdout.write if stdout is not None else (lambda _text: None)
    entries = _watchlist_entries(symbols)
    if not entries:
        return {
            "status": "no-symbols", "upcoming": 0, "synced": 0, "failed": [], "skipped": [],
            "purged": {},
        }

    # The coin page URL needs the canonical slug, not the exchange ticker.
    ensure_watchlist_slugs(entries)

    upcoming_count = 0
    synced = 0
    failed = []
    skipped = []
    for entry in entries:
        if not entry.slug:
            skipped.append(entry.symbol)
            write(f"{entry.symbol}: no coin slug, skipped.")
            continue
        page_url = COINMARKETCAL_COIN_URL.format(slug=entry.slug)
        try:
            events = fetch_coin_events(entry.slug)
        except MarketEventError as exc:
            failed.append(entry.symbol)
            logger.warning("Market event scrape failed for %s: %s", entry.symbol, exc)
            write(f"{entry.symbol}: {exc}")
            continue
        stored = store_events(entry.symbol, entry.slug, events)
        upcoming_count += stored
        synced += 1
        write(f"{entry.symbol}: {stored} upcoming event(s) from {page_url}.")

    if failed and not synced:
        status = "failed"
    elif failed:
        status = "partial"
    else:
        status = "ok"

    purged = purge_market_events()
    write(
        "Purged market events: "
        f"{purged['past']} past, {purged['removed_unknown_symbols']} for removed symbols."
    )
    return {
        "status": status,
        "upcoming": upcoming_count,
        "synced": synced,
        "failed": failed,
        "skipped": skipped,
        "purged": purged,
    }


def sync_symbol_events(symbol):
    """Populate a symbol immediately after it is added to the watchlist."""
    return sync_market_events(symbols=[symbol])
