"""Backend port of the chart's Trend Bias swing-line detector.

The rules mirror ``frontend/src/lib/market/trend-bias.ts``: strict five-bar swing
pivots, same-side pivot pairs that may not be cut by a candle body, a current leg
through the newest active anchors, and a prior leg that stops on the close that
broke it. ``find_trend_bias`` is pure so the alert job and tests share the chart's
reading instead of approximating it.
"""

import math
import time
from dataclasses import dataclass


TREND_BIAS_TIMEFRAMES = ("1h", "4h", "1d")
TIMEFRAME_SECONDS = {"1h": 3600, "4h": 14400, "1d": 86400}

SWING_SPAN = 5
MAX_BARS = 320
MIN_SPAN_BARS = 12
ACTIVE_START = 0.8
MAX_BODY_PIERCING = 0.0015
MAX_WICK_PIERCING = 0.01
TOUCH_TOLERANCE = 0.005
FLAT_SLOPE_PCT = 0.01
TREND_BIAS_EXTEND_SECONDS = 86400

REQUIRED_BARS = SWING_SPAN * 2 + MIN_SPAN_BARS


@dataclass
class _Pivot:
    time: float
    price: float
    index: int


@dataclass
class _Leg:
    left: _Pivot
    right: _Pivot
    slope: float
    span: int
    touches: int
    break_index: int


def _closed_bars(bars, timeframe, now_seconds):
    """Trailing bars only, matching the chart's ``closedBars`` helper."""
    interval = TIMEFRAME_SECONDS[timeframe]
    end = len(bars)
    while end > 0 and bars[end - 1]["time"] + interval > now_seconds:
        end -= 1
    return bars[:end][-MAX_BARS:]


def _price_at(left, slope, timestamp):
    return left.price + slope * (timestamp - left.time)


def _find_pivots(bars, kind):
    """Local swing highs or lows: strictly beyond every bar in the span either side."""
    pivots = []
    for index in range(SWING_SPAN, len(bars) - SWING_SPAN):
        price = bars[index]["high" if kind == "high" else "low"]
        pivot = True
        for offset in range(1, SWING_SPAN + 1):
            before = bars[index - offset]
            after = bars[index + offset]
            if kind == "high":
                disqualified = before["high"] >= price or after["high"] >= price
            else:
                disqualified = before["low"] <= price or after["low"] <= price
            if disqualified:
                pivot = False
                break
        if pivot:
            pivots.append(_Pivot(float(bars[index]["time"]), float(price), index))
    return pivots


def _rests_on_side(bars, left, slope, kind, from_index=None, to_index=None):
    """Every candle in the range stays on the correct side of the fitted line."""
    from_index = left.index if from_index is None else from_index
    to_index = len(bars) - 1 if to_index is None else to_index
    for index in range(from_index, to_index + 1):
        bar = bars[index]
        value = _price_at(left, slope, bar["time"])
        if not value > 0:
            return False
        if kind == "high":
            if bar["high"] - value > value * MAX_WICK_PIERCING:
                return False
            if max(bar["open"], bar["close"]) - value > value * MAX_BODY_PIERCING:
                return False
        else:
            if value - bar["low"] > value * MAX_WICK_PIERCING:
                return False
            if value - min(bar["open"], bar["close"]) > value * MAX_BODY_PIERCING:
                return False
    return True


def _find_break(bars, left, slope, kind, after_index):
    """First close beyond the line, or -1 while the line still holds."""
    for index in range(after_index + 1, len(bars)):
        bar = bars[index]
        value = _price_at(left, slope, bar["time"])
        if not value > 0:
            return -1
        beyond = bar["close"] - value if kind == "high" else value - bar["close"]
        if beyond > value * MAX_BODY_PIERCING:
            return index
    return -1


def _count_touches(pivots, left, right, slope):
    touches = 0
    for pivot in pivots:
        if pivot.index <= left.index or pivot.index >= right.index:
            continue
        value = _price_at(left, slope, pivot.time)
        if abs(pivot.price - value) <= value * TOUCH_TOLERANCE:
            touches += 1
    return touches


def _collect_legs(bars, pivots, kind):
    legs = []
    for first in range(len(pivots)):
        for second in range(first + 1, len(pivots)):
            left = pivots[first]
            right = pivots[second]
            if right.index - left.index < MIN_SPAN_BARS:
                continue
            denominator = right.time - left.time
            if denominator == 0:
                continue
            slope = (right.price - left.price) / denominator
            if not math.isfinite(slope):
                continue
            if not _rests_on_side(bars, left, slope, kind, left.index, right.index):
                continue
            legs.append(_Leg(
                left=left,
                right=right,
                slope=slope,
                span=right.index - left.index,
                touches=_count_touches(pivots, left, right, slope),
                break_index=_find_break(bars, left, slope, kind, right.index),
            ))
    return legs


def _choose_current(bars, legs, kind):
    """The still-respected leg anchored in the newest fifth of the window."""
    active_from = (len(bars) - 1) * ACTIVE_START
    best = None
    for leg in legs:
        if leg.break_index != -1 or leg.right.index < active_from:
            continue
        if not _rests_on_side(bars, leg.left, leg.slope, kind, leg.right.index, len(bars) - 1):
            continue
        if (
            best is None
            or leg.right.index > best.right.index
            or (leg.right.index == best.right.index and leg.touches > best.touches)
            or (leg.right.index == best.right.index and leg.touches == best.touches and leg.span > best.span)
        ):
            best = leg
    return best


def _choose_prior(bars, legs, kind, current):
    """The most recently broken leg that ended before the current leg began."""
    best = None
    for leg in legs:
        if leg.break_index == -1:
            continue
        if current and (leg.right.index >= current.left.index or leg.break_index > current.left.index):
            continue
        if not _rests_on_side(bars, leg.left, leg.slope, kind, leg.right.index, leg.break_index - 1):
            continue
        if (
            best is None
            or leg.break_index > best.break_index
            or (leg.break_index == best.break_index and leg.touches > best.touches)
            or (leg.break_index == best.break_index and leg.touches == best.touches and leg.span > best.span)
        ):
            best = leg
    return best


def _build_line(kind, leg, segment, end_time, bar_seconds):
    left = leg.left
    p1 = left.price
    p2 = _price_at(left, leg.slope, end_time)
    slope_pct_per_bar = (leg.slope * bar_seconds * 100) / abs(p1) if p1 else 0.0
    return {
        "kind": kind,
        "segment": segment,
        "t1": left.time,
        "p1": p1,
        "t2": end_time,
        "p2": p2,
        "slope": leg.slope,
        "slope_pct_per_bar": slope_pct_per_bar,
        "pivots": leg.touches + 2,
    }


def _direction_of(lines):
    if not lines:
        return "neutral"
    signs = [
        0 if abs(line["slope_pct_per_bar"]) < FLAT_SLOPE_PCT else math.copysign(1, line["slope_pct_per_bar"])
        for line in lines
    ]
    if all(sign > 0 for sign in signs):
        return "bullish"
    if all(sign < 0 for sign in signs):
        return "bearish"
    return "neutral"


def find_trend_bias(bars, timeframe, now_seconds=None):
    """Read the trend bias for one higher timeframe.

    ``bars`` may include the still-forming candle; only completed candles feed the
    pivots and leg checks, matching the chart overlay. The returned lines use the
    same fields the browser paints, with prices per second on ``slope``.
    """
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported trend-bias timeframe: {timeframe}")
    now = time.time() if now_seconds is None else float(now_seconds)
    closed = _closed_bars(bars, timeframe, now)
    if len(closed) < REQUIRED_BARS:
        return None

    end_time = now + TREND_BIAS_EXTEND_SECONDS
    bar_seconds = TIMEFRAME_SECONDS[timeframe]
    lines = []
    current_lines = []
    for kind in ("high", "low"):
        legs = _collect_legs(closed, _find_pivots(closed, kind), kind)
        current = _choose_current(closed, legs, kind)
        prior = _choose_prior(closed, legs, kind, current)
        if prior is not None:
            lines.append(_build_line(
                kind, prior, "prior", closed[prior.break_index]["time"], bar_seconds,
            ))
        if current is not None:
            line = _build_line(kind, current, "current", end_time, bar_seconds)
            lines.append(line)
            current_lines.append(line)
    if not lines:
        return None

    return {
        "timeframe": timeframe,
        "direction": _direction_of(current_lines),
        "lines": lines,
    }
