from datetime import datetime, timezone as dt_timezone
import html
import logging
import math
import re
import time
from urllib.parse import quote

import requests
from django.conf import settings
from django.db import transaction
from django.utils import timezone

from . import recovery
from .models import Alert, AppConfiguration, Exchange, Notification, TriggerEvent
from .patterns import DETECTED_PATTERN_KEYS as PATTERN_SCAN_KEYS
from .patterns import (
    PATTERN_LABELS, RECENT_BARS as PATTERN_RECENT_BARS, best_pattern, detect_patterns,
    pattern_evaluate,
)
from .swing import (
    SWING_BIAS_BARS, SWING_BIAS_TIMEFRAMES, SWING_DETECTION_BARS, touches_for_bar,
)
from .trend_bias import find_trend_bias

logger = logging.getLogger(__name__)
TIMEFRAME_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}
BYBIT_INTERVALS = {"1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W"}
VOLUME_AVERAGE_BARS = 20


def _market_request(path, params, exchange):
    if exchange.exchange == Exchange.Name.BYBIT:
        url = f"https://api.bybit.com/v5/market/{path}"
    else:
        url = f"{exchange.exchange_url.rstrip('/')}/{path}"
    response = requests.get(
        url,
        params=params,
        timeout=exchange.exchange_timeout,
    )
    response.raise_for_status()
    payload = response.json()
    if exchange.exchange == Exchange.Name.BYBIT:
        if payload.get("retCode") != 0:
            raise ValueError(payload.get("retMsg") or "Bybit market data request failed.")
        return payload.get("result", {})
    if isinstance(payload, dict) and "code" in payload and "msg" in payload:
        raise ValueError(payload["msg"])
    return payload


def get_market_quote(symbol, exchange):
    if exchange.exchange == Exchange.Name.BYBIT:
        result = _market_request("tickers", {"category": "spot", "symbol": symbol}, exchange)
        item = next(iter(result.get("list", [])), None)
        if item is None:
            raise ValueError(f"{symbol} is not a supported Bybit spot pair.")
        return {"price": float(item["lastPrice"]), "change": float(item["price24hPcnt"]) * 100}
    item = _market_request("ticker/24hr", {"type": "MINI", "symbol": symbol}, exchange)
    price, opening = float(item["lastPrice"]), float(item["openPrice"])
    return {"price": price, "change": (price - opening) / opening * 100 if opening else 0.0}


def _price_for(symbol, exchange):
    return get_market_quote(symbol, exchange)["price"]


def _candles_for(symbol, timeframe, exchange, limit):
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError("Unsupported market timeframe.")
    if exchange.exchange == Exchange.Name.BYBIT:
        result = _market_request("kline", {
            "category": "spot", "symbol": symbol,
            "interval": BYBIT_INTERVALS[timeframe], "limit": str(limit),
        }, exchange)
        duration_ms = TIMEFRAME_SECONDS[timeframe] * 1000
        return [
            [int(candle[0]), candle[1], candle[2], candle[3], candle[4], candle[5], int(candle[0]) + duration_ms - 1]
            for candle in reversed(result.get("list", []))
        ]
    return _market_request("klines", {
        "symbol": symbol, "interval": timeframe, "limit": limit,
    }, exchange)


def get_market_candles(symbol, timeframe, exchange, limit=500):
    candles = _candles_for(symbol, timeframe, exchange, limit)
    return [{
        "time": int(candle[0]) // 1000,
        "open": float(candle[1]),
        "high": float(candle[2]),
        "low": float(candle[3]),
        "close": float(candle[4]),
        "volume": float(candle[5]),
    } for candle in candles]


def _closed_bars(symbol, timeframe, exchange, limit=500):
    """Normalized bars with the still-forming candle removed.

    Breakout and pattern rules act on completed candles, so the exchange's newest
    kline is discarded until its close time has passed.
    """
    candles = _candles_for(symbol, timeframe, exchange, limit)
    now_ms = int(time.time() * 1000)
    return [{
        "time": int(candle[0]) // 1000,
        "open": float(candle[1]),
        "high": float(candle[2]),
        "low": float(candle[3]),
        "close": float(candle[4]),
        "volume": float(candle[5]),
    } for candle in candles if int(candle[6]) < now_ms]


def _volume_percent(closed):
    """Latest closed candle's volume as a percentage of the previous 20 candles."""
    if len(closed) < VOLUME_AVERAGE_BARS + 1:
        return None
    baseline = [float(candle[5]) for candle in closed[-VOLUME_AVERAGE_BARS - 1:-1]]
    average = sum(baseline) / len(baseline)
    if average <= 0:
        return None
    return float(closed[-1][5]) / average * 100


def _ema_series(values, length):
    result = [None] * len(values)
    seed = []
    start = None
    alpha = 2 / (length + 1)
    for index, value in enumerate(values):
        if value is None:
            continue
        if start is None:
            start = index
        offset = index - start
        if offset < length:
            seed.append(value)
            if offset == length - 1:
                result[index] = sum(seed) / length
        else:
            result[index] = value * alpha + result[index - 1] * (1 - alpha)
    return result


def _macd_signal(symbol, timeframe, exchange):
    candles = _candles_for(symbol, timeframe, exchange, 300)
    now_ms = int(time.time() * 1000)
    closed = [candle for candle in candles if int(candle[6]) < now_ms]
    if len(closed) < 37:
        return None
    closes = [float(candle[4]) for candle in closed]
    fast, slow = _ema_series(closes, 12), _ema_series(closes, 26)
    macd_line = [f - s if f is not None and s is not None else None for f, s in zip(fast, slow)]
    signal = _ema_series(macd_line, 9)
    index = len(closed) - 1
    if any(value is None for value in (macd_line[index - 1], signal[index - 1], macd_line[index], signal[index])):
        return None
    true_ranges = []
    for candle_index in range(len(closed)):
        candle = closed[candle_index]
        high, low = float(candle[2]), float(candle[3])
        previous_close = float(closed[candle_index - 1][4]) if candle_index else closes[candle_index]
        true_ranges.append(max(high - low, abs(high - previous_close), abs(low - previous_close)))
    atr = sum(true_ranges[:14]) / 14
    for true_range in true_ranges[14:]:
        atr = (atr * 13 + true_range) / 14
    return {
        "bar_time": datetime.fromtimestamp(int(closed[index][0]) / 1000, tz=dt_timezone.utc),
        "previous_diff": macd_line[index - 1] - signal[index - 1],
        "current_diff": macd_line[index] - signal[index],
        "close": closes[index],
        "macd": macd_line[index],
        "signal": signal[index],
        "atr": atr,
        "volume_percent": _volume_percent(closed),
    }


def _rsi_signal(symbol, timeframe, exchange, period=14):
    candles = _candles_for(symbol, timeframe, exchange, 500)
    now_ms = int(time.time() * 1000)
    closed = [candle for candle in candles if int(candle[6]) < now_ms]
    if len(closed) < period + 1:
        return None
    closes = [float(candle[4]) for candle in closed]

    gains = []
    losses = []
    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gains.append(change if change > 0 else 0)
        losses.append(-change if change < 0 else 0)

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        rsi = 100
    else:
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))

    index = len(closed) - 1
    return {
        "bar_time": datetime.fromtimestamp(int(closed[index][0]) / 1000, tz=dt_timezone.utc),
        "rsi": rsi,
        "close": closes[index],
    }


def _ema(values, period):
    """Exponential moving average seeded with the SMA of the first `period` values."""
    ema = sum(values[:period]) / period
    multiplier = 2 / (period + 1)
    for value in values[period:]:
        ema = (value - ema) * multiplier + ema
    return ema


def _trend_signal(symbol, timeframe, exchange, period=100):
    candles = _candles_for(symbol, timeframe, exchange, max(period + 100, 500))
    now_ms = int(time.time() * 1000)
    closed = [candle for candle in candles if int(candle[6]) < now_ms]
    if len(closed) < period:
        return None
    closes = [float(candle[4]) for candle in closed]
    ema = _ema(closes, period)
    index = len(closed) - 1
    return {
        "bar_time": datetime.fromtimestamp(int(closed[index][0]) / 1000, tz=dt_timezone.utc),
        "ema": ema,
        "close": closes[index],
        "trend": "uptrend" if closes[index] >= ema else "downtrend",
    }


def _rsi_classification(alert, rsi):
    """Classify RSI momentum as bullish or bearish, adding a balanced qualifier near the middle. Informational only."""
    value = rsi["rsi"]
    if value >= (70 if alert.rsi_overbought is None else alert.rsi_overbought):
        return "bullish"
    if value <= (30 if alert.rsi_oversold is None else alert.rsi_oversold):
        return "bearish"
    return "bullish-balanced" if value >= 50 else "bearish-balanced"


def _trend_classification(alert, trend):
    """Classify price relative to the EMA as bullish or bearish, adding a balanced qualifier near the EMA. Informational only — never blocks a MACD alert."""
    close, ema = trend["close"], trend["ema"]
    tolerance = ema * 0.001  # within 0.1% of the EMA counts as balanced
    if close > ema + tolerance:
        return "bullish"
    if close < ema - tolerance:
        return "bearish"
    return "bullish-balanced" if close >= ema else "bearish-balanced"


def _format_number(value, decimals=2):
    if value is None or not math.isfinite(value):
        return "–"
    return f"{value:,.{decimals}f}"


def _format_price(value):
    """Current prices are shown with a dollar sign and enough decimals for the pair."""
    if value is None or not math.isfinite(value):
        return "–"
    magnitude = abs(value)
    decimals = 3 if magnitude >= 1 else 5 if magnitude >= 0.01 else 8
    return f"${_format_number(value, decimals)}"


def _format_indicator(value):
    if value is None or not math.isfinite(value):
        return "–"
    magnitude = abs(value)
    decimals = 2 if magnitude >= 1 else 5 if magnitude >= 0.01 else 8
    return _format_number(value, decimals)


def _report_url(alert, bar_time, *, subject=None):
    interval = alert.timeframe
    stamp = bar_time.strftime("%m/%d/%YT%H:%M")
    url = (
        f"{settings.FRONTEND_URL}/report/?token={alert.symbol}"
        f"&interval={interval}&time={stamp}"
    )
    if subject:
        url += f"&subject={quote(subject)}"
    return url


def _rsi_line(alert, rsi):
    timeframe = alert.effective_rsi_timeframe
    if not rsi:
        return f"RSI ({timeframe}): –"
    state = _rsi_classification(alert, rsi).title()
    return f"RSI ({timeframe}): {rsi['rsi']:.0f} {state}"


def _trend_line(alert, trend):
    period = alert.trend_period or 100
    timeframe = alert.effective_trend_timeframe
    if not trend:
        return f"EMA {period} ({timeframe}): –"
    state = _trend_classification(alert, trend).title()
    return f"EMA {period} ({timeframe}): {_format_indicator(trend['ema'])} {state}"


def _volume_line(volume_percent):
    if volume_percent is None or not math.isfinite(volume_percent):
        return "Volume: –"
    return f"Volume: {volume_percent:.0f}%"


def _macd_alert_message(alert, macd, *, status, rsi, trend, distance=None, subject=None):
    lines = [f"Status: {status.capitalize()}"]
    if distance is not None:
        lines.append(f"Distance: {distance:.2f}%")
    lines.extend([
        f"Current Price: {_format_price(macd['close'])}",
        _rsi_line(alert, rsi),
        _trend_line(alert, trend),
        _volume_line(macd.get("volume_percent")),
        f"Report: {_report_url(alert, macd['bar_time'], subject=subject)}",
    ])
    return "\n".join(lines)


def _line_level(alert, at):
    if not alert.line_type or alert.line_price1 is None:
        return float(alert.price) if alert.price is not None else None
    t1 = alert.line_t1.timestamp() if alert.line_t1 else at
    p1 = float(alert.line_price1)
    if alert.line_type in {Alert.LineType.HLINE, Alert.LineType.HRAY}:
        if alert.line_type == Alert.LineType.HRAY and at < t1:
            return None
        return p1
    if not alert.line_t2 or alert.line_price2 is None or at < t1:
        return None
    t2, p2 = alert.line_t2.timestamp(), float(alert.line_price2)
    if t2 == t1:
        return None
    if alert.line_type == Alert.LineType.TREND and not alert.line_extend and at > t2:
        return None
    return p1 + (p2 - p1) * (at - t1) / (t2 - t1)


def _crossed(condition, previous, current):
    if previous is None:
        return False
    up = previous < 0 <= current
    down = previous > 0 >= current
    if condition == Alert.Condition.CROSS_UP:
        return up
    if condition == Alert.Condition.CROSS_DOWN:
        return down
    return up or down


MACD_APPROACH_REARM_PERCENT = 15


def _macd_approach_thresholds(previous, current, previous_gap_percent, current_gap_percent, condition, previous_threshold):
    """Return newly reached proximity bands and the current approach state."""
    if previous is None or current == 0 or previous_gap_percent is None or current_gap_percent is None:
        return [], None
    if previous * current <= 0:
        # The lines crossed, so the next approach starts fresh.
        return [], None
    if current_gap_percent >= previous_gap_percent:
        # A widening bar keeps the bands already reported, so a wobble around a band does not
        # repeat its warning. Drifting well clear of every band re-arms them.
        return [], (None if current_gap_percent > MACD_APPROACH_REARM_PERCENT else previous_threshold)
    if (current < 0 and condition == Alert.Condition.CROSS_DOWN) or (
        current > 0 and condition == Alert.Condition.CROSS_UP
    ):
        return [], None

    reached = [
        threshold for threshold in (10, 5)
        if current_gap_percent <= threshold and (previous_threshold is None or threshold < previous_threshold)
    ]
    current_threshold = min(reached) if reached else previous_threshold
    return reached, current_threshold


def _may_fire(alert, now):
    if alert.frequency == Alert.Frequency.ONCE:
        return True
    if alert.last_triggered_at is None:
        return True
    return (now - alert.last_triggered_at).total_seconds() >= alert.cooldown_seconds


def telegram_request(notification, method, data=None, *, token=None):
    token = token or notification.telegram_bot_token
    if not token:
        raise ValueError("Configure the Telegram bot token in Django admin first.")
    response = requests.post(
        f"https://api.telegram.org/bot{token}/{method}",
        data=data or {},
        timeout=Exchange.load().exchange_timeout,
    )
    try:
        payload = response.json()
    except ValueError:
        response.raise_for_status()
        raise ValueError("Telegram returned an invalid response.")
    if not payload.get("ok"):
        raise ValueError(payload.get("description") or "Telegram request failed.")
    response.raise_for_status()
    return payload.get("result")


def find_telegram_chat(notification, *, token=None):
    updates = telegram_request(notification, "getUpdates", {"limit": "100"}, token=token)
    for update in reversed(updates or []):
        message = (
            update.get("message") or update.get("edited_message")
            or update.get("channel_post") or update.get("my_chat_member")
        )
        if message and message.get("chat"):
            return message["chat"]
    raise ValueError("No Telegram messages found. Open your bot and press Start, then try again.")


def send_telegram_test(notification, *, token=None, chat_id=None):
    token = token or notification.telegram_bot_token
    chat_id = chat_id or notification.telegram_chat_id
    if not token:
        raise ValueError("Enter a Telegram bot token.")
    if not chat_id:
        raise ValueError("Enter a Telegram chat ID.")
    return telegram_request(notification, "sendMessage", {
        "chat_id": chat_id,
        "text": "Marketa+ is connected. Your alerts will arrive here.",
    }, token=token)


_TELEGRAM_LABEL = re.compile(r"^([A-Za-z][A-Za-z0-9 ()/.%×_+\-]{0,30}):\s*(.+)$")


def _telegram_text(title, message):
    """Format a stored event for Telegram without changing its wording.

    Labels are bolded, each line becomes a bullet, and every dynamic value is escaped so a
    symbol or note can never break Telegram's HTML mode. The report URL is replaced with a
    closing "See full report" link instead of showing the raw address.
    """
    lines = [f"🔔 <b>{html.escape(title)}</b>"]
    for raw in message.splitlines():
        line = raw.strip()
        if not line:
            continue
        match = _TELEGRAM_LABEL.match(line)
        if match is None:
            lines.append(f"• {html.escape(line)}")
            continue
        label, value = match.groups()
        if label.lower() == "report" and value.startswith(("http://", "https://")):
            href = html.escape(value, quote=True)
            lines.append(f'See <a href="{href}">full report</a>')
            continue
        escaped = html.escape(value)
        if value.startswith(("http://", "https://")):
            escaped = f'<a href="{html.escape(value, quote=True)}">{escaped}</a>'
        lines.append(f"• <b>{html.escape(label)}:</b> {escaped}")
    return "\n".join(lines)


def _notify(event, configuration):
    logger.info("ALERT %s | %s", event.title, event.message)
    if not configuration.notification_enabled:
        return

    for notification in Notification.objects.order_by("id").iterator():
        token = notification.telegram_bot_token
        chat_id = notification.telegram_chat_id

        if not token or not chat_id:
            continue

        try:
            telegram_request(
                notification,
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": _telegram_text(event.title, event.message),
                    "parse_mode": "HTML",
                },
            )
        except (requests.RequestException, ValueError):
            logger.exception("Telegram alert delivery failed for chat_id: %s", chat_id)

def check_alerts(*, stdout=None):
    """Fetch current market values, persist alert state/events, and notify on hits."""
    configuration = AppConfiguration.load()
    exchange = Exchange.load()
    # Pattern and trend-recovery alerts run on their own scheduler jobs
    # (check_pattern_alerts, check_recovery_alerts).
    alerts = list(
        Alert.objects.filter(active=True)
        .exclude(kind__in=[
            Alert.Kind.PATTERN, Alert.Kind.TREND_RECOVERY, Alert.Kind.SWING_DETECTION,
        ])
        .order_by("id")
    )
    price_symbols = {a.symbol for a in alerts if a.kind == Alert.Kind.PRICE}
    macd_keys = {(a.symbol, a.timeframe) for a in alerts if a.kind == Alert.Kind.MACD}
    # MACD alerts always report RSI and the EMA trend in their message, even when the
    # separate confirmation toggles are off.
    rsi_keys = {
        (a.symbol, a.effective_rsi_timeframe, a.rsi_period or 14)
        for a in alerts if a.kind in {Alert.Kind.RSI, Alert.Kind.MACD}
    }
    trend_keys = {
        (a.symbol, a.effective_trend_timeframe, a.trend_period or 100)
        for a in alerts if a.kind == Alert.Kind.MACD
    }
    prices, macd_values, rsi_values, trend_values = {}, {}, {}, {}
    for symbol in sorted(price_symbols):
        try:
            prices[symbol] = _price_for(symbol, exchange)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s price: %s", symbol, exc)
    for symbol, timeframe in sorted(macd_keys):
        try:
            macd_values[(symbol, timeframe)] = _macd_signal(symbol, timeframe, exchange)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s %s MACD: %s", symbol, timeframe, exc)
    for symbol, timeframe, period in sorted(rsi_keys):
        try:
            rsi_values[(symbol, timeframe, period)] = _rsi_signal(symbol, timeframe, exchange, period)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s %s RSI: %s", symbol, timeframe, exc)
    for symbol, timeframe, period in sorted(trend_keys):
        try:
            trend_values[(symbol, timeframe, period)] = _trend_signal(symbol, timeframe, exchange, period)
        except (requests.RequestException, KeyError, ValueError) as exc:
            logger.warning("Could not fetch %s %s trend: %s", symbol, timeframe, exc)

    fired = []
    now = timezone.now()
    for snapshot in alerts:
        value = prices.get(snapshot.symbol) if snapshot.kind == Alert.Kind.PRICE else None
        macd = macd_values.get((snapshot.symbol, snapshot.timeframe)) if snapshot.kind == Alert.Kind.MACD else None
        rsi = rsi_values.get((
            snapshot.symbol, snapshot.effective_rsi_timeframe, snapshot.rsi_period or 14,
        )) if snapshot.kind in {Alert.Kind.RSI, Alert.Kind.MACD} else None
        trend = trend_values.get((
            snapshot.symbol, snapshot.effective_trend_timeframe, snapshot.trend_period or 100,
        )) if snapshot.kind == Alert.Kind.MACD else None
        if snapshot.kind == Alert.Kind.PRICE and value is None:
            continue
        if snapshot.kind == Alert.Kind.RSI and rsi is None:
            continue
        if snapshot.kind == Alert.Kind.MACD and macd is None:
            continue
        alert_fired = []
        try:
            with transaction.atomic():
                alert = Alert.objects.select_for_update().filter(pk=snapshot.pk, active=True).first()
                if alert is None:
                    continue
                event = None
                if alert.kind == Alert.Kind.PRICE:
                    level = _line_level(alert, now.timestamp())
                    if level is None:
                        continue
                    previous_diff = None if alert.last_observed_value is None else alert.last_observed_value - level
                    current_diff = value - level
                    hit = (
                        value >= level if alert.condition == Alert.Condition.ABOVE else
                        value <= level if alert.condition == Alert.Condition.BELOW else
                        _crossed(alert.condition, previous_diff, current_diff)
                    )
                    alert.last_observed_value = value
                    if hit and _may_fire(alert, now):
                        direction = alert.get_condition_display().lower()
                        event = TriggerEvent.objects.create(
                            alert=alert,
                            symbol=alert.symbol,
                            title=f"{alert.symbol} {direction} {level:g}",
                            message=f"Last price {value:g}; target {level:g}" + (f" — {alert.note}" if alert.note else ""),
                            observed_value=value,
                        )
                elif alert.kind == Alert.Kind.MACD:
                    bar_time = macd["bar_time"]
                    if alert.last_bar_open_time is None:
                        # Arm at the latest closed candle; never report an old cross on first startup.
                        alert.last_bar_open_time = bar_time
                        alert.last_macd_diff = macd["current_diff"]
                        atr = macd.get("atr")
                        alert.last_macd_gap_percent = abs(macd["current_diff"]) / atr * 100 if atr and atr > 0 else None
                    elif bar_time > alert.last_bar_open_time:
                        previous_diff = alert.last_macd_diff
                        if previous_diff is None:
                            previous_diff = macd["previous_diff"]
                        current_diff = macd["current_diff"]
                        atr = macd.get("atr")
                        current_gap_percent = abs(current_diff) / atr * 100 if atr and atr > 0 else None
                        previous_gap_percent = alert.last_macd_gap_percent
                        if previous_gap_percent is None and previous_diff is not None and atr and atr > 0:
                            previous_gap_percent = abs(previous_diff) / atr * 100
                        hit = _crossed(alert.condition, previous_diff, current_diff)
                        alert.last_bar_open_time = bar_time
                        alert.last_observed_value = macd["close"]
                        thresholds, warning_state = _macd_approach_thresholds(
                            previous_diff, current_diff, previous_gap_percent, current_gap_percent, alert.condition,
                            alert.last_macd_warning_threshold,
                        )
                        alert.last_macd_warning_threshold = warning_state
                        alert.last_macd_diff = current_diff
                        alert.last_macd_gap_percent = current_gap_percent
                        # Filter thresholds based on enabled flags
                        enabled_thresholds = []
                        if alert.macd_threshold_5 and 5 in thresholds:
                            enabled_thresholds.append(5)
                        if alert.macd_threshold_10 and 10 in thresholds:
                            enabled_thresholds.append(10)
                        for threshold in enabled_thresholds:
                            status = "bullish" if current_diff < 0 else "bearish"
                            title = f"{alert.symbol}({alert.timeframe}) MACD {threshold}% Approach"
                            alert_fired.append(TriggerEvent.objects.create(
                                alert=alert,
                                symbol=alert.symbol,
                                title=title,
                                message=_macd_alert_message(
                                    alert, macd, status=status, rsi=rsi, trend=trend,
                                    distance=current_gap_percent, subject=title,
                                ),
                                observed_value=macd["close"],
                            ))
                        if hit and _may_fire(alert, now):
                            status = "bullish" if macd["current_diff"] > 0 else "bearish"
                            title = f"{alert.symbol}({alert.timeframe}) MACD Crossed"
                            event = TriggerEvent.objects.create(
                                alert=alert,
                                symbol=alert.symbol,
                                title=title,
                                message=_macd_alert_message(
                                    alert, macd, status=status, rsi=rsi, trend=trend, subject=title,
                                ),
                                observed_value=macd["close"],
                            )
                elif alert.kind == Alert.Kind.RSI:
                    bar_time = rsi["bar_time"]
                    rsi_value = rsi["rsi"]
                    rsi_oversold = 30 if alert.rsi_oversold is None else alert.rsi_oversold
                    rsi_overbought = 70 if alert.rsi_overbought is None else alert.rsi_overbought
                    previous_rsi = alert.last_rsi_value
                    hit = False
                    level = None

                    if alert.condition == Alert.Condition.ABOVE:
                        level = rsi_overbought
                        hit = rsi_value >= level
                    elif alert.condition == Alert.Condition.BELOW:
                        level = rsi_oversold
                        hit = rsi_value <= level
                    elif alert.condition == Alert.Condition.CROSS_UP:
                        level = rsi_overbought
                        hit = previous_rsi is not None and previous_rsi < level <= rsi_value
                    elif alert.condition == Alert.Condition.CROSS_DOWN:
                        level = rsi_oversold
                        hit = previous_rsi is not None and previous_rsi > level >= rsi_value
                    elif alert.condition == Alert.Condition.CROSS:
                        level = f"{rsi_oversold:g}/{rsi_overbought:g}"
                        if previous_rsi is not None:
                            hit = (previous_rsi < rsi_oversold <= rsi_value) or (previous_rsi > rsi_overbought >= rsi_value)

                    alert.last_rsi_value = rsi_value
                    alert.last_observed_value = rsi["close"]

                    if hit and _may_fire(alert, now):
                        direction = alert.get_condition_display().lower()
                        event = TriggerEvent.objects.create(
                            alert=alert,
                            symbol=alert.symbol,
                            title=f"{alert.symbol} RSI {alert.timeframe} {direction} {level if isinstance(level, str) else f'{level:g}'}",
                            message=f"RSI {rsi_value:.2f}, close {rsi['close']:g}" + (f" — {alert.note}" if alert.note else ""),
                            observed_value=rsi["close"],
                        )
                if event is not None:
                    alert.last_triggered_at = now
                    if alert.frequency == Alert.Frequency.ONCE:
                        alert.active = False
                    alert_fired.append(event)
                alert.save(update_fields=[
                    "active", "last_triggered_at", "last_observed_value", "last_bar_open_time",
                    "last_macd_diff", "last_macd_gap_percent", "last_macd_warning_threshold",
                    "last_rsi_value", "updated_at"
                ])
        except Exception:
            # One broken alert must not stop the others or hold back their notifications.
            logger.exception("Alert %s check failed", snapshot.pk)
            continue
        fired.extend(alert_fired)

    for event in fired:
        _notify(event, configuration)
        if stdout is not None:
            stdout.write(f"Triggered: {event.title} — {event.message}")
    return fired


# Trend-recovery alerts need enough closed candles per timeframe for the MACD
# warmup: the 1H trigger can be EMA 12/100, the 4H filter EMA 12/26 and the 1D
# anchor EMA 19/39.
RECOVERY_CANDLE_LIMITS = {"1h": 500, "4h": 300, "1d": 400}


def _recovery_event_title(alert, event):
    bullish = event["direction"] == "bullish"
    bias = "Bullish" if bullish else "Bearish"
    if event["stage"] == "early":
        return f"{alert.symbol} Trend Recovery - {bias} Early Warning"
    setup = "Pullback Recovery" if bullish else "Bounce Reversal"
    return f"{alert.symbol} Trend Recovery - {bias} {setup}"


def _recovery_alert_message(alert, event):
    bullish = event["direction"] == "bullish"
    bias = "Bullish" if bullish else "Bearish"
    status = "Early warning" if event["stage"] == "early" else "Confirmed"
    setup = "pullback recovery" if bullish else "bounce reversal"
    trigger = recovery.TRIGGER_LABELS.get(alert.recovery_trigger, alert.recovery_trigger)
    bar_time = datetime.fromtimestamp(event["bar_time"], tz=dt_timezone.utc)
    lines = [
        f"Status: {status} - {bias} {setup}",
        f"Trigger: {trigger} ({alert.timeframe})",
        f"Current Price: {_format_price(event['close'])}",
        f"MACD 1h: {_format_indicator(event['macd'])}",
        f"MACD 4h (EMA 12/26): {_format_indicator(event['h4_macd'])}",
        f"MACD 1d (EMA 19/39): {_format_indicator(event['daily_macd'])}",
        f"Pullback: {event['pullback_bars']} 1h bars",
        f"Report: {_report_url(alert, bar_time, subject=_recovery_event_title(alert, event))}",
    ]
    if alert.note:
        lines.insert(-1, f"Note: {alert.note}")
    return "\n".join(lines)


def check_recovery_alerts(*, stdout=None):
    """Advance trend-recovery alerts over closed 1H bars.

    The 1D and 4H MACD filters and the configured 1H trigger are recomputed from
    closed candles on every poll; ``alerts.recovery`` decides which bars produced
    an early warning or a confirmed cross, and ``recovery_last_bar_time`` keeps
    each cycle from being reported twice. The first poll only arms the alert at
    the newest closed bar, matching how MACD alerts treat their first reading.
    """
    configuration = AppConfiguration.load()
    exchange = Exchange.load()
    candidates = list(
        Alert.objects.filter(active=True, kind=Alert.Kind.TREND_RECOVERY).order_by("id")
    )
    if not candidates:
        return []

    bars_cache = {}

    def closed_bars(symbol, timeframe):
        key = (symbol, timeframe)
        if key not in bars_cache:
            try:
                bars_cache[key] = _closed_bars(
                    symbol, timeframe, exchange, RECOVERY_CANDLE_LIMITS[timeframe],
                )
            except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
                logger.warning(
                    "Could not fetch %s %s candles for trend recovery: %s",
                    symbol, timeframe, exc,
                )
                bars_cache[key] = None
        return bars_cache[key]

    fired = []
    now = timezone.now()
    for candidate in candidates:
        try:
            with transaction.atomic():
                alert = Alert.objects.select_for_update().filter(
                    pk=candidate.pk, active=True, kind=Alert.Kind.TREND_RECOVERY,
                ).first()
                if alert is None:
                    continue
                hour_bars = closed_bars(alert.symbol, "1h")
                daily_bars = closed_bars(alert.symbol, "1d")
                h4_bars = closed_bars(alert.symbol, "4h")
                if not hour_bars or not daily_bars or not h4_bars:
                    continue
                daily_signs = recovery.trend_signs(
                    daily_bars, TIMEFRAME_SECONDS["1d"], "1d",
                )
                h4_signs = recovery.trend_signs(
                    h4_bars, TIMEFRAME_SECONDS["4h"], "4h",
                )
                events = recovery.detect_events(
                    hour_bars, alert.recovery_trigger, daily_signs, h4_signs,
                )
                latest_close = hour_bars[-1]["time"] + TIMEFRAME_SECONDS["1h"]
                latest_bar_time = datetime.fromtimestamp(latest_close, tz=dt_timezone.utc)
                if alert.recovery_last_bar_time is None:
                    # Arm at the latest closed 1H bar; never replay history.
                    alert.recovery_last_bar_time = latest_bar_time
                    alert.last_observed_value = hour_bars[-1]["close"]
                    alert.save(update_fields=[
                        "recovery_last_bar_time", "last_observed_value", "updated_at",
                    ])
                    continue
                last_seen = int(alert.recovery_last_bar_time.timestamp())
                new_events = [event for event in events if event["bar_time"] > last_seen]
                created = []
                for event in new_events:
                    title = _recovery_event_title(alert, event)
                    created.append(TriggerEvent.objects.create(
                        alert=alert,
                        symbol=alert.symbol,
                        title=title,
                        message=_recovery_alert_message(alert, event),
                        observed_value=event["close"],
                    ))
                alert.recovery_last_bar_time = latest_bar_time
                alert.last_observed_value = hour_bars[-1]["close"]
                update_fields = [
                    "recovery_last_bar_time", "last_observed_value", "updated_at",
                ]
                # Confirmed crosses respect frequency and cooldown; early
                # warnings are once-per-cycle by construction and always land.
                if any(event["stage"] == "confirmed" for event in new_events) \
                        and _may_fire(alert, now):
                    alert.last_triggered_at = now
                    update_fields.append("last_triggered_at")
                    if alert.frequency == Alert.Frequency.ONCE:
                        alert.active = False
                        update_fields.append("active")
                if created:
                    fired.extend(created)
                alert.save(update_fields=update_fields)
        except Exception:
            logger.exception("Trend recovery alert %s check failed", candidate.pk)
            continue

    for event in fired:
        _notify(event, configuration)
        if stdout is not None:
            stdout.write(f"Triggered: {event.title} — {event.message}")
    return fired


def _swing_bar_time(seconds):
    return datetime.fromtimestamp(seconds, tz=dt_timezone.utc)


def _swing_event_title(alert, bar):
    return f"{alert.symbol}({alert.timeframe}) Swing Detection - Touch"


def _swing_touch_text(touch):
    direction = touch["direction"].title() if touch.get("direction") else "Neutral"
    slope = touch.get("slope_pct_per_bar")
    slope_text = f", {slope:+.2f}%/bar" if slope is not None else ""
    pivots = touch.get("pivots")
    pivot_text = f", {pivots} pivots" if pivots is not None else ""
    return (
        f"{touch['bias_timeframe'].upper()} {touch['kind_label']} "
        f"{_format_price(touch['level'])} ({direction}{slope_text}{pivot_text})"
    )


def _swing_alert_message(alert, bar, touches):
    title = _swing_event_title(alert, bar)
    lines = [
        "Status: Swing touch",
        f"Current Price: {_format_price(bar['close'])}",
        "Touched: " + "; ".join(_swing_touch_text(touch) for touch in touches),
    ]
    if alert.note:
        lines.append(f"Note: {alert.note}")
    lines.append(
        f"Report: {_report_url(alert, _swing_bar_time(bar['time']), subject=title)}"
    )
    return "\n".join(lines)


def check_swing_alerts(*, stdout=None):
    """Advance swing-detection alerts over newly closed candles.

    Each alert candle timeframe is checked against the current projected
    trend-bias diagonals from the 1H, 4H and 1D readings. The first poll only
    arms at the newest closed candle; later polls evaluate every closed candle
    since the stored bar once, so a touch cannot be replayed by the next poll.
    """
    configuration = AppConfiguration.load()
    exchange = Exchange.load()
    candidates = list(
        Alert.objects.filter(active=True, kind=Alert.Kind.SWING_DETECTION).order_by("id")
    )
    if not candidates:
        return []

    bars_cache = {}
    bias_cache = {}
    now_seconds = time.time()
    now = timezone.now()

    def closed_bars(symbol, timeframe, limit):
        key = (symbol, timeframe, limit)
        if key not in bars_cache:
            try:
                bars_cache[key] = _closed_bars(symbol, timeframe, exchange, limit)
            except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
                logger.warning(
                    "Could not fetch %s %s candles for swing detection: %s",
                    symbol, timeframe, exc,
                )
                bars_cache[key] = None
        return bars_cache[key]

    def biases_for(symbol):
        """All three trend-bias readings for a symbol, or None when a feed failed."""
        if symbol in bias_cache:
            return bias_cache[symbol]
        biases = {}
        for timeframe in SWING_BIAS_TIMEFRAMES:
            bars = closed_bars(symbol, timeframe, SWING_BIAS_BARS)
            if bars is None:
                bias_cache[symbol] = None
                return None
            biases[timeframe] = find_trend_bias(bars, timeframe, now_seconds)
        bias_cache[symbol] = biases
        return biases

    fired = []
    for candidate in candidates:
        try:
            with transaction.atomic():
                alert = Alert.objects.select_for_update().filter(
                    pk=candidate.pk, active=True, kind=Alert.Kind.SWING_DETECTION,
                ).first()
                if alert is None:
                    continue
                bars = closed_bars(alert.symbol, alert.timeframe, SWING_DETECTION_BARS)
                if bars is None or not bars:
                    continue
                biases = biases_for(alert.symbol)
                if biases is None:
                    continue

                if alert.last_bar_open_time is None:
                    # Arm at the latest closed candle; never replay history.
                    latest = bars[-1]
                    alert.last_bar_open_time = _swing_bar_time(latest["time"])
                    alert.last_observed_value = latest["close"]
                    alert.save(update_fields=[
                        "last_bar_open_time", "last_observed_value", "updated_at",
                    ])
                    continue

                last_seen = int(alert.last_bar_open_time.timestamp())
                new_bars = [bar for bar in bars if bar["time"] > last_seen]
                if not new_bars:
                    continue

                created = []
                evaluated_bar = None
                deactivate = False
                for bar in new_bars:
                    touches = touches_for_bar(bar, biases)
                    if not touches or not _may_fire(alert, now):
                        continue
                    title = _swing_event_title(alert, bar)
                    created.append(TriggerEvent.objects.create(
                        alert=alert,
                        symbol=alert.symbol,
                        title=title,
                        message=_swing_alert_message(alert, bar, touches),
                        observed_value=bar["close"],
                    ))
                    alert.last_triggered_at = now
                    evaluated_bar = bar
                    if alert.frequency == Alert.Frequency.ONCE:
                        alert.active = False
                        deactivate = True
                        break
                if evaluated_bar is None:
                    evaluated_bar = new_bars[-1]

                alert.last_bar_open_time = _swing_bar_time(evaluated_bar["time"])
                alert.last_observed_value = evaluated_bar["close"]
                update_fields = [
                    "last_bar_open_time", "last_observed_value", "updated_at",
                ]
                if created:
                    update_fields.append("last_triggered_at")
                if deactivate:
                    update_fields.append("active")
                alert.save(update_fields=update_fields)
                fired.extend(created)
        except Exception:
            # One broken alert must not stop the others or hold back their notifications.
            logger.exception("Swing detection alert %s check failed", candidate.pk)
            continue

    for event in fired:
        _notify(event, configuration)
        if stdout is not None:
            stdout.write(f"Triggered: {event.title} — {event.message}")
    return fired


def _pattern_bias_word(bias):
    return "Bullish" if bias == "bullish" else "Bearish"


def _pattern_bar_time(seconds):
    return datetime.fromtimestamp(seconds, tz=dt_timezone.utc)


def _pattern_event_title(alert, signal, state):
    label = PATTERN_LABELS.get(state["key"], state["key"])
    status = "Forming" if signal["event"] == "forming" else "Breakout"
    return (
        f"{alert.symbol}({alert.timeframe}) Pattern - {status} - {label} "
        f"- {_pattern_bias_word(state['bias'])}"
    )


def _pattern_alert_message(alert, signal, state):
    """Forming and breakout copy for a chart-pattern alert.

    Both events quote the same measured move: on a flat line that is the same ``Target:`` number,
    on a sloped one the breakout re-applies it from where the line was broken. Every line
    is ``Label: value`` so Telegram bolds the label and folds the report into a link.
    """
    label = PATTERN_LABELS.get(state["key"], state["key"])
    forming = signal["event"] == "forming"
    entry = state.get("entry") or {}
    invalidation = state.get("invalidation") or {}
    lines = [
        f"Status: {'Forming' if forming else 'Breakout'} "
        f"- {_pattern_bias_word(state['bias'])}",
        f"Pattern: {label} ({alert.timeframe})",
        f"Current Price: {_format_price(signal['close'])}",
    ]
    if forming:
        lines.append(
            f"Entry: close {'above' if entry['side'] == 'up' else 'below'} "
            f"{_format_price(entry['price'])}"
        )
        if invalidation:
            lines.append(
                f"Invalidation: close {'above' if invalidation['side'] == 'up' else 'below'} "
                f"{_format_price(invalidation['price'])}"
            )
    else:
        lines.append(f"Breakout: {_format_price(signal['level'])}")
    if state.get("target") is not None:
        lines.append(f"Target: {_format_price(state['target'])}")
    if alert.note:
        lines.append(f"Note: {alert.note}")
    lines.append(
        f"Report: {_report_url(alert, _pattern_bar_time(signal['bar_time']), subject=_pattern_event_title(alert, signal, state))}"
    )
    return "\n".join(lines)


def check_pattern_alerts(*, stdout=None):
    """Advance chart-pattern alerts over the candles the chart itself would have drawn.

    The shapes are found by ``alerts.patterns``, the backend's own copy of the chart rules, so
    an alert never asks the browser what it sees. Candles are fetched once per symbol and
    timeframe per poll, and an alert only moves on a newly closed bar, so the 60-second cadence
    buys responsiveness rather than extra detections.
    """
    configuration = AppConfiguration.load()
    exchange = Exchange.load()
    alerts = list(
        Alert.objects.filter(active=True, kind=Alert.Kind.PATTERN).order_by("id")
    )
    if not alerts:
        return []

    bars_cache = {}

    def recent_bars(symbol, timeframe):
        """The newest slice of closed candles, with failures remembered for this poll."""
        key = (symbol, timeframe)
        if key not in bars_cache:
            try:
                # One extra candle, because the still-forming one is dropped before the
                # detector sees the window.
                closed = _closed_bars(symbol, timeframe, exchange, PATTERN_RECENT_BARS + 1)
                bars_cache[key] = closed[-PATTERN_RECENT_BARS:]
            except (requests.RequestException, KeyError, IndexError, ValueError) as exc:
                logger.warning(
                    "Could not fetch %s %s candles for pattern alerts: %s", symbol, timeframe, exc,
                )
                bars_cache[key] = None
        return bars_cache[key]

    fired = []
    now = timezone.now()
    for candidate in alerts:
        try:
            with transaction.atomic():
                alert = Alert.objects.select_for_update().filter(
                    pk=candidate.pk, active=True, kind=Alert.Kind.PATTERN,
                ).first()
                if alert is None:
                    continue
                bars = recent_bars(alert.symbol, alert.timeframe)
                if not bars:
                    continue
                bar_time = _pattern_bar_time(bars[-1]["time"])
                if alert.pattern_last_bar_time is not None and bar_time <= alert.pattern_last_bar_time:
                    continue
                state = {
                    "state": alert.pattern_state,
                    "key": alert.pattern_key,
                    "bias": alert.pattern_bias,
                    "signature": alert.pattern_signature,
                    "entry": alert.pattern_entry or {},
                    "target": alert.pattern_target,
                    "invalidation": alert.pattern_invalidation or {},
                    "end_time": (
                        int(alert.pattern_end_time.timestamp()) if alert.pattern_end_time else None
                    ),
                }
                signals, state = pattern_evaluate(
                    bars,
                    best_pattern(detect_patterns(list(PATTERN_SCAN_KEYS), bars)),
                    state,
                    symbol=alert.symbol,
                    timeframe=alert.timeframe,
                    first_poll=alert.pattern_last_bar_time is None,
                )
                events = [
                    TriggerEvent.objects.create(
                        alert=alert,
                        symbol=alert.symbol,
                        title=_pattern_event_title(alert, signal, state),
                        message=_pattern_alert_message(alert, signal, state),
                        observed_value=signal["close"],
                    )
                    for signal in signals
                ]
                alert.pattern_state = state["state"]
                alert.pattern_key = state["key"]
                alert.pattern_bias = state["bias"]
                alert.pattern_signature = state["signature"]
                alert.pattern_entry = state["entry"]
                alert.pattern_target = state["target"]
                alert.pattern_invalidation = state["invalidation"]
                alert.pattern_end_time = (
                    _pattern_bar_time(state["end_time"]) if state["end_time"] else None
                )
                alert.pattern_last_bar_time = bar_time
                alert.last_observed_value = bars[-1]["close"]
                if events:
                    alert.last_triggered_at = now
                    fired.extend(events)
                # A once alert has said everything it can about this formation once the pair is
                # complete; an every alert stays live and waits for the next shape to form.
                completed = any(signal["event"] == "breakout" for signal in signals)
                finished = completed and alert.frequency == Alert.Frequency.ONCE
                if finished:
                    alert.active = False
                alert.save(update_fields=[
                    "pattern_state", "pattern_key", "pattern_bias", "pattern_signature",
                    "pattern_entry", "pattern_target", "pattern_invalidation",
                    "pattern_end_time", "pattern_last_bar_time", "last_observed_value",
                    "last_triggered_at", "updated_at",
                ] + (["active"] if finished else []))
        except Exception:
            # One broken alert must not stop the others or hold back their notifications.
            logger.exception("Pattern alert %s check failed", candidate.pk)
            continue

    for event in fired:
        _notify(event, configuration)
        if stdout is not None:
            stdout.write(f"Triggered: {event.title} — {event.message}")
    return fired
