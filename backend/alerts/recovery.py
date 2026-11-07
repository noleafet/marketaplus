"""MACD zero-line pullback-recovery detection for the Trend Recovery alert.

The strategy watches three timeframes at once and only reads where the MACD line
sits relative to zero — no signal line is needed for that:

- 1D MACD (EMA 19/39) is the major trend anchor.
- 4H MACD (EMA 12/26) confirms the trend.
- 1H MACD is the trigger. Two interchangeable configurations are supported:
  SMA 3/10 (default) and the slower EMA 12/100 variation.

Bullish pullback recovery: both higher timeframes are above zero, the 1H MACD
spent a meaningful run below zero (the pullback), starts rising back toward
zero (early warning), then crosses above zero on a closed candle (confirmed).
Bearish bounce reversal is the mirror image. A setup is cancelled whenever the
1D or 4H alignment is lost, each opposite-side excursion is its own cycle, and
a cross only counts after the pullback ran long enough to not be a one-candle
fluctuation.

Everything here is pure: callers hand in normalized closed bars
(``{"time": open_seconds, "close": price}``) and get events back, so the live
checker and the backtest share exactly the same rules.
"""

import bisect

# Higher-timeframe trend filters, as (fast, slow) moving-average specs.
TREND_SPECS = {
    "1d": (("ema", 19), ("ema", 39)),
    "4h": (("ema", 12), ("ema", 26)),
}

# 1H trigger configurations. ``sma`` is the default; ``ema`` is the slower
# alternative kept independent so the two can be compared, never combined.
TRIGGER_SPECS = {
    "sma": (("sma", 3), ("sma", 10)),
    "ema": (("ema", 12), ("ema", 100)),
}

TRIGGER_LABELS = {
    "sma": "SMA 3/10",
    "ema": "EMA 12/100",
}

# A pullback or bounce must hold the opposite side of zero for this many
# consecutive closed 1H bars before it counts as a real excursion.
PULLBACK_MIN_BARS = 3
# The MACD line must improve toward zero for this many consecutive bars while
# still on the pullback side before the early warning fires.
RECOVERY_RISE_BARS = 2

_HOUR_SECONDS = 3600


def _sma_series(values, period):
    result = [None] * len(values)
    if len(values) < period:
        return result
    window = sum(values[:period])
    result[period - 1] = window / period
    for index in range(period, len(values)):
        window += values[index] - values[index - period]
        result[index] = window / period
    return result


def _ema_series(values, period):
    """EMA seeded with the SMA of the first ``period`` values."""
    result = [None] * len(values)
    if len(values) < period:
        return result
    ema = sum(values[:period]) / period
    result[period - 1] = ema
    alpha = 2 / (period + 1)
    for index in range(period, len(values)):
        ema = values[index] * alpha + ema * (1 - alpha)
        result[index] = ema
    return result


def _ma_series(values, spec):
    kind, period = spec
    if kind == "ema":
        return _ema_series(values, period)
    if kind == "sma":
        return _sma_series(values, period)
    raise ValueError(f"Unsupported moving average kind: {kind}")


def macd_series(closes, fast_spec, slow_spec):
    """MACD line (fast MA minus slow MA); ``None`` until both averages exist."""
    fast = _ma_series(closes, fast_spec)
    slow = _ma_series(closes, slow_spec)
    return [
        f - s if f is not None and s is not None else None
        for f, s in zip(fast, slow)
    ]


def zero_line_signs(bars, interval_seconds, fast_spec, slow_spec):
    """``(available_time, macd_value)`` pairs for a timeframe's closed bars.

    ``available_time`` is the bar's close, so a higher timeframe only speaks
    for lower-timeframe bars that had already finished when they closed.
    """
    closes = [bar["close"] for bar in bars]
    macd = macd_series(closes, fast_spec, slow_spec)
    return [
        (bar["time"] + interval_seconds, value)
        for bar, value in zip(bars, macd)
        if value is not None
    ]


def trend_signs(bars, interval_seconds, timeframe):
    """Zero-line MACD signs for one of the configured trend timeframes."""
    fast, slow = TREND_SPECS[timeframe]
    return zero_line_signs(bars, interval_seconds, fast, slow)


def _lookup(signs, available_time):
    """Latest MACD value whose bar had closed by ``available_time``."""
    times = [entry[0] for entry in signs]
    index = bisect.bisect_right(times, available_time) - 1
    if index < 0:
        return None
    return signs[index][1]


def _signs_index(signs):
    return [entry[0] for entry in signs], [entry[1] for entry in signs]


def _value_at(times, values, available_time):
    index = bisect.bisect_right(times, available_time) - 1
    return values[index] if index >= 0 else None


def detect_events(hour_bars, trigger_key, daily_signs, four_hour_signs,
                  interval_seconds=_HOUR_SECONDS):
    """Walk closed 1H bars and return recovery events in chronological order.

    Each event is a dict with ``bar_time`` (the 1H bar's close, epoch seconds),
    ``direction`` (``"bullish"``/``"bearish"``), ``stage`` (``"early"`` or
    ``"confirmed"``), the 1H trigger ``macd`` value, the aligned ``daily_macd``
    and ``h4_macd`` filter values, ``close`` and ``pullback_bars`` (the length
    of the opposite-side excursion that set the cycle up).
    """
    if trigger_key not in TRIGGER_SPECS:
        raise ValueError(f"Unsupported recovery trigger: {trigger_key}")
    fast, slow = TRIGGER_SPECS[trigger_key]
    closes = [bar["close"] for bar in hour_bars]
    macd = macd_series(closes, fast, slow)
    daily_times, daily_values = _signs_index(daily_signs)
    h4_times, h4_values = _signs_index(four_hour_signs)

    events = []
    # Per-direction cycle state: the run of consecutive opposite-side bars, the
    # consecutive improves toward zero, whether the early warning already fired,
    # and the run length seen on the previous bar (the pullback depth at confirm).
    states = {
        "bullish": {"run": 0, "rise": 0, "warned": False, "prev_run": 0},
        "bearish": {"run": 0, "rise": 0, "warned": False, "prev_run": 0},
    }
    previous_macd = None

    for index, bar in enumerate(hour_bars):
        value = macd[index]
        available = bar["time"] + interval_seconds
        daily_macd = _value_at(daily_times, daily_values, available)
        h4_macd = _value_at(h4_times, h4_values, available)
        for direction in ("bullish", "bearish"):
            state = states[direction]
            aligned = (
                daily_macd is not None and h4_macd is not None
                and ((daily_macd > 0 and h4_macd > 0) if direction == "bullish"
                     else (daily_macd < 0 and h4_macd < 0))
            )
            if not aligned or value is None:
                state.update(run=0, rise=0, warned=False, prev_run=0)
                continue
            opposite = value < 0 if direction == "bullish" else value > 0
            state["prev_run"] = state["run"]
            state["run"] = state["run"] + 1 if opposite else 0
            pullback_active = state["run"] >= PULLBACK_MIN_BARS
            if not opposite:
                state["rise"] = 0
                if previous_macd is not None:
                    # Crossed back through zero: a confirmed recovery, but only
                    # when the excursion ran long enough to be a real pullback.
                    crossed = (
                        previous_macd < 0 <= value if direction == "bullish"
                        else previous_macd > 0 >= value
                    )
                    if crossed and state["prev_run"] >= PULLBACK_MIN_BARS:
                        events.append({
                            "bar_time": available,
                            "direction": direction,
                            "stage": "confirmed",
                            "macd": value,
                            "close": bar["close"],
                            "daily_macd": daily_macd,
                            "h4_macd": h4_macd,
                            "pullback_bars": state["prev_run"],
                        })
                if state["run"] == 0:
                    state["warned"] = False
                continue
            improving = (
                value > previous_macd if direction == "bullish"
                else value < previous_macd
            ) if previous_macd is not None else False
            state["rise"] = state["rise"] + 1 if improving else 0
            if (pullback_active and not state["warned"]
                    and state["rise"] >= RECOVERY_RISE_BARS):
                state["warned"] = True
                events.append({
                    "bar_time": available,
                    "direction": direction,
                    "stage": "early",
                    "macd": value,
                    "close": bar["close"],
                    "daily_macd": daily_macd,
                    "h4_macd": h4_macd,
                    "pullback_bars": state["run"],
                })
        previous_macd = value

    return events
