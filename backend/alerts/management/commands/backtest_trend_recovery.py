"""Backtest the Trend Recovery alert over historical candles.

Fetches closed 1h/4h/1d candles for a symbol and runs the exact detection rules
the live monitor uses (``alerts.recovery``) once per configured 1H trigger —
SMA 3/10 and EMA 12/100 — under the same 1D EMA 19/39 and 4H EMA 12/26 filters.

For every confirmed signal the report measures the false-alert rate (the price
never moved far enough in the signal's direction within the horizon), the
detection delay (bars spent in the pullback, plus how early the warning led the
confirmation), the subsequent price movement at several horizons, and the same
metrics on an out-of-sample tail of the signal set.
"""

from datetime import datetime, timezone as dt_timezone

from django.core.management.base import BaseCommand, CommandError

from alerts import recovery
from alerts.models import Exchange
from alerts.services import BYBIT_INTERVALS, TIMEFRAME_SECONDS, _market_request

HORIZON_BARS = 24  # one day of 1h bars for the false-alert / excursion window
FORWARD_STEPS = (6, 24, 72)
TRAIN_SHARE = 0.7


def _interval_ms(timeframe):
    return TIMEFRAME_SECONDS[timeframe] * 1000


def _fetch_klines(symbol, timeframe, exchange, start_ms, end_ms):
    """All klines with open time in ``[start_ms, end_ms]``, oldest first."""
    interval_ms = _interval_ms(timeframe)
    collected = []
    cursor = start_ms
    # Exchanges cap the page size below the requested limit, so paging continues
    # until the cursor passes the end bound or a request comes back empty.
    for _page in range(100):
        if cursor > end_ms:
            break
        if exchange.exchange == Exchange.Name.BYBIT:
            result = _market_request("kline", {
                "category": "spot", "symbol": symbol,
                "interval": BYBIT_INTERVALS[timeframe], "limit": "1000",
                "start": str(cursor), "end": str(end_ms),
            }, exchange)
            rows = [
                [int(candle[0]), candle[1], candle[2], candle[3], candle[4], candle[5],
                 int(candle[0]) + interval_ms - 1]
                for candle in result.get("list", [])
            ]
            rows.sort(key=lambda candle: candle[0])
        else:
            rows = _market_request("klines", {
                "symbol": symbol, "interval": timeframe, "limit": 1500,
                "startTime": cursor, "endTime": end_ms,
            }, exchange)
        rows = [
            candle for candle in rows
            if start_ms <= int(candle[0]) <= end_ms
        ]
        if not rows:
            break
        collected.extend(rows)
        last_open = int(rows[-1][0])
        next_cursor = last_open + interval_ms
        if next_cursor <= cursor or last_open >= end_ms:
            break
        cursor = next_cursor
    collected.sort(key=lambda candle: candle[0])
    # De-duplicate pages that overlap on the boundary candle.
    deduped = []
    for candle in collected:
        if not deduped or int(candle[0]) != int(deduped[-1][0]):
            deduped.append(candle)
    return deduped


def _closed_bars_from_klines(klines):
    return [{
        "time": int(candle[0]) // 1000,
        "open": float(candle[1]),
        "high": float(candle[2]),
        "low": float(candle[3]),
        "close": float(candle[4]),
        "volume": float(candle[5]),
    } for candle in klines]


def _forward_stats(hour_bars, index_by_time, event):
    """Signed forward returns, excursion and false-alert flag for one signal."""
    index = index_by_time.get(event["bar_time"])
    if index is None:
        return None
    direction = 1 if event["direction"] == "bullish" else -1
    entry = hour_bars[index]["close"]
    stats = {"direction": event["direction"], "stage": event["stage"],
             "bar_time": event["bar_time"], "pullback_bars": event["pullback_bars"]}
    for step in FORWARD_STEPS:
        target = index + step
        if target < len(hour_bars):
            stats[f"ret_{step}h"] = (
                (hour_bars[target]["close"] / entry - 1) * 100 * direction
            )
    window = hour_bars[index + 1:index + 1 + HORIZON_BARS]
    if window:
        if direction == 1:
            favorable = max(bar["high"] for bar in window) / entry - 1
            adverse = min(bar["low"] for bar in window) / entry - 1
        else:
            favorable = entry / min(bar["low"] for bar in window) - 1
            adverse = entry / max(bar["high"] for bar in window) - 1
        stats["mfe_pct"] = favorable * 100
        stats["mae_pct"] = adverse * 100
        # False alert: price never traded meaningfully in the signal's direction.
        stats["false"] = favorable <= 0.002
    return stats


def _summarize(stats):
    confirmed = [s for s in stats if s["stage"] == "confirmed" and "ret_24h" in s]
    if not confirmed:
        return {"signals": 0}
    false_count = sum(1 for s in confirmed if s["false"])
    summary = {
        "signals": len(confirmed),
        "early_warnings": sum(1 for s in stats if s["stage"] == "early"),
        "false_rate": false_count / len(confirmed) * 100,
        "avg_pullback_bars": sum(s["pullback_bars"] for s in confirmed) / len(confirmed),
        "avg_mfe_pct": sum(s["mfe_pct"] for s in confirmed if "mfe_pct" in s)
        / max(1, sum(1 for s in confirmed if "mfe_pct" in s)),
    }
    for step in FORWARD_STEPS:
        key = f"ret_{step}h"
        values = [s[key] for s in confirmed if key in s]
        if values:
            summary[f"avg_{key}"] = sum(values) / len(values)
            summary[f"win_{key}"] = sum(1 for v in values if v > 0) / len(values) * 100
    return summary


def _split_out_of_sample(stats):
    """Split every event at the same time boundary: the first
    ``TRAIN_SHARE`` of confirmed signals stays in-sample, the tail is
    out-of-sample. Early warnings ride along so their counts split too."""
    confirmed = sorted(
        (s for s in stats if s["stage"] == "confirmed"),
        key=lambda s: s["bar_time"],
    )
    if not confirmed:
        return [], []
    cut = int(len(confirmed) * TRAIN_SHARE)
    if cut <= 0:
        return [], list(stats)
    boundary = confirmed[cut - 1]["bar_time"]
    train = [s for s in stats if s["bar_time"] <= boundary]
    test = [s for s in stats if s["bar_time"] > boundary]
    return train, test


class Command(BaseCommand):
    help = "Backtest and compare the SMA 3/10 vs EMA 12/100 trend recovery triggers."

    def add_arguments(self, parser):
        parser.add_argument("--symbol", default="BTCUSDT",
                            help="Market symbol to backtest (default: BTCUSDT).")
        parser.add_argument("--days", type=int, default=365,
                            help="Days of 1h history to fetch (default: 365).")
        parser.add_argument("--output", default="",
                            help="Optional file path to write the report to.")

    def handle(self, *args, **options):
        symbol = options["symbol"].strip().upper()
        days = options["days"]
        if days < 30:
            raise CommandError("--days must be at least 30 so the MACD warmup fits.")
        exchange = Exchange.load()
        end_ms = int(datetime.now(tz=dt_timezone.utc).timestamp() * 1000)
        start_ms = end_ms - days * 24 * 3600 * 1000

        bars = {}
        for timeframe in ("1h", "4h", "1d"):
            klines = _fetch_klines(symbol, timeframe, exchange, start_ms, end_ms)
            bars[timeframe] = _closed_bars_from_klines(klines)
            self.stdout.write(
                f"Fetched {len(klines)} {timeframe} candles for {symbol}."
            )
        if len(bars["1h"]) < 150:
            raise CommandError("Not enough 1h history for a meaningful backtest.")

        hour_bars = bars["1h"]
        daily_signs = recovery.trend_signs(
            bars["1d"], TIMEFRAME_SECONDS["1d"], "1d",
        )
        h4_signs = recovery.trend_signs(
            bars["4h"], TIMEFRAME_SECONDS["4h"], "4h",
        )
        index_by_time = {
            bar["time"] + TIMEFRAME_SECONDS["1h"]: index
            for index, bar in enumerate(hour_bars)
        }

        lines = [
            f"# Trend Recovery backtest — {symbol}",
            "",
            f"Exchange: {exchange.get_exchange_display()} · "
            f"Period: {days} days of 1h candles ({len(hour_bars)} bars) · "
            f"Generated {datetime.now(tz=dt_timezone.utc):%Y-%m-%d %H:%M} UTC",
            "",
            "Filters (identical for both triggers): 1D MACD EMA 19/39 and "
            "4H MACD EMA 12/26 must both sit on the same side of zero.",
            "A pullback needs 3+ consecutive closed 1h bars on the opposite "
            "side of zero; the early warning needs 2 consecutive improves "
            "toward zero; the confirmation is the zero-line cross.",
            "",
        ]
        report_rows = []
        for trigger in ("sma", "ema"):
            events = recovery.detect_events(
                hour_bars, trigger, daily_signs, h4_signs,
            )
            stats = [
                stat for stat in
                (_forward_stats(hour_bars, index_by_time, event) for event in events)
                if stat is not None
            ]
            train, test = _split_out_of_sample(stats)
            summary = _summarize(stats)
            train_summary = _summarize(train)
            test_summary = _summarize(test)
            for direction in ("bullish", "bearish"):
                dir_stats = [
                    s for s in stats
                    if s["stage"] == "confirmed" and s["direction"] == direction
                ]
                dir_summary = _summarize(
                    [dict(s, stage="confirmed") for s in dir_stats]
                )
                report_rows.append((trigger, direction, dir_summary))
            lines.extend(self._section(
                recovery.TRIGGER_LABELS[trigger], summary, train_summary, test_summary,
            ))

        lines.extend(["", "## Confirmed signals by direction", "",
                      "| Trigger | Direction | Signals | False % | Avg pullback bars | "
                      "Avg MFE % | Avg +24h % | Win +24h % |",
                      "|---|---|---|---|---|---|---|---|"])
        for trigger, direction, summary in report_rows:
            lines.append(
                f"| {recovery.TRIGGER_LABELS[trigger]} | {direction} | "
                f"{summary.get('signals', 0)} | "
                f"{summary.get('false_rate', 0):.1f} | "
                f"{summary.get('avg_pullback_bars', 0):.1f} | "
                f"{summary.get('avg_mfe_pct', 0):.2f} | "
                f"{summary.get('avg_ret_24h', 0):.2f} | "
                f"{summary.get('win_ret_24h', 0):.1f} |"
            )

        # Early-warning lead: bars between each warning and the next confirmed
        # cross of the same direction.
        lines.extend(["", "## Early warning lead time", ""])
        for trigger in ("sma", "ema"):
            events = recovery.detect_events(
                hour_bars, trigger, daily_signs, h4_signs,
            )
            leads = []
            pending = {}
            for event in events:
                key = event["direction"]
                if event["stage"] == "early":
                    pending[key] = event["bar_time"]
                elif event["stage"] == "confirmed" and key in pending:
                    leads.append(
                        (event["bar_time"] - pending.pop(key)) / TIMEFRAME_SECONDS["1h"]
                    )
            avg = sum(leads) / len(leads) if leads else 0
            lines.append(
                f"- {recovery.TRIGGER_LABELS[trigger]}: {len(leads)} warnings led a "
                f"confirmation by {avg:.1f} bars on average"
            )

        text = "\n".join(lines) + "\n"
        self.stdout.write(text)
        if options["output"]:
            import os
            os.makedirs(os.path.dirname(options["output"]) or ".", exist_ok=True)
            with open(options["output"], "w", encoding="utf-8") as handle:
                handle.write(text)
            self.stdout.write(f"Report written to {options['output']}")

    def _section(self, label, summary, train_summary, test_summary):
        def fmt(value, suffix=""):
            if value is None:
                return "–"
            if isinstance(value, float):
                return f"{value:.1f}{suffix}"
            return f"{value}{suffix}"

        lines = [
            f"## {label}",
            "",
            "| Metric | All signals | In-sample (70%) | Out-of-sample (30%) |",
            "|---|---|---|---|",
        ]
        rows = [
            ("Confirmed signals", "signals", ""),
            ("Early warnings", "early_warnings", ""),
            ("False-alert rate", "false_rate", "%"),
            ("Avg pullback bars", "avg_pullback_bars", ""),
            ("Avg max favorable excursion", "avg_mfe_pct", "%"),
            ("Avg +6h return", "avg_ret_6h", "%"),
            ("Avg +24h return", "avg_ret_24h", "%"),
            ("Avg +72h return", "avg_ret_72h", "%"),
            ("Win rate +24h", "win_ret_24h", "%"),
        ]
        for name, key, suffix in rows:
            lines.append(
                f"| {name} | {fmt(summary.get(key), suffix)} | "
                f"{fmt(train_summary.get(key), suffix)} | "
                f"{fmt(test_summary.get(key), suffix)} |"
            )
        lines.append("")
        return lines
