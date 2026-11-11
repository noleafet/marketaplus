"""Backend port of the chart's Trend Bias swing-line detector.

The rules mirror ``frontend/src/lib/market/trend-bias.ts``: strict five-bar swing
pivots, same-side pivot pairs that may not be cut by a candle body, a current leg
through the newest active anchors, and a prior leg that stops on the close that
broke it. ``find_trend_bias`` is pure so the alert job and tests share the chart's
reading instead of approximating it.

The leg search is vectorised with NumPy: each candle constraint is rewritten as a
slope bound, so pair checks stay cheap even when the pivot count is high.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone as dt_timezone
from typing import Any

import numpy as np


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


def _timestamp(value: Any) -> float:
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=dt_timezone.utc)
        return moment.timestamp()
    return float(value)


def _normalise_bars(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = [
        {
            "time": _timestamp(row["time"]),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
        }
        for row in bars
    ]
    rows.sort(key=lambda row: row["time"])
    return rows


def _closed_bars(bars, timeframe, now_seconds):
    """Trailing bars only, matching the chart's ``closedBars`` helper."""
    interval = TIMEFRAME_SECONDS[timeframe]
    end = len(bars)
    while end > 0 and bars[end - 1]["time"] + interval > now_seconds:
        end -= 1
    return bars[:end][-MAX_BARS:]


def _price_at(left, slope, timestamp):
    return left.price + slope * (timestamp - left.time)


def line_price(line: dict[str, Any], timestamp: float) -> float:
    """Price on a trend-bias line at an epoch-second timestamp."""
    return float(line["p1"]) + float(line["slope"]) * (float(timestamp) - float(line["t1"]))


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


class _Frame:
    """Column arrays for one timeframe's closed bars.

    The leg search is O(pivots^2) pair checks; ``_SideSearch`` rewrites each
    candle scan as per-bar slope bounds so queries stay cheap while preserving
    the same pierce/break rules.
    """

    __slots__ = ("n", "times", "opens", "highs", "lows", "closes", "body_hi", "body_lo")

    def __init__(self, bars: list[dict[str, Any]]) -> None:
        n = len(bars)
        self.n = n
        self.times = np.fromiter((bar["time"] for bar in bars), dtype=float, count=n)
        self.opens = np.fromiter((bar["open"] for bar in bars), dtype=float, count=n)
        self.highs = np.fromiter((bar["high"] for bar in bars), dtype=float, count=n)
        self.lows = np.fromiter((bar["low"] for bar in bars), dtype=float, count=n)
        self.closes = np.fromiter((bar["close"] for bar in bars), dtype=float, count=n)
        self.body_hi = np.maximum(self.opens, self.closes)
        self.body_lo = np.minimum(self.opens, self.closes)


def _anchor_bounds(frame, left, kind):
    """Per-bar slope bounds for one anchor pivot.

    For ``high`` lines every candle constraint is a lower bound on the slope:
    ``v_i = p1 + slope*dt_i`` must satisfy ``v_i >= M_i`` and ``v_i > 0``, so a
    range check reduces to ``slope >= max_i (M_i - p1)/dt_i`` plus one strict
    positivity bound at the range end. ``low`` lines are symmetric. The break
    scan reduces the same way: a close beyond the line is a per-bar slope
    threshold, and ``v_i <= 0`` is ``slope <= -p1/dt_i``. ``rest_prefix`` is the
    running extremum of ``rest`` so span checks starting at the anchor are O(1).
    """
    n = frame.n
    i0 = left.index + 1
    if kind == "high":
        rest = np.full(n, -np.inf)
        brk = np.full(n, -np.inf)
    else:
        rest = np.full(n, np.inf)
        brk = np.full(n, np.inf)
    inv = np.full(n, -np.inf)
    if i0 < n:
        dt = frame.times[i0:] - left.time
        if kind == "high":
            level = np.maximum(
                frame.highs[i0:] / (1.0 + MAX_WICK_PIERCING),
                frame.body_hi[i0:] / (1.0 + MAX_BODY_PIERCING),
            )
            brk[i0:] = (frame.closes[i0:] / (1.0 + MAX_BODY_PIERCING) - left.price) / dt
        else:
            level = np.minimum(
                frame.lows[i0:] / (1.0 - MAX_WICK_PIERCING),
                frame.body_lo[i0:] / (1.0 - MAX_BODY_PIERCING),
            )
            brk[i0:] = (frame.closes[i0:] / (1.0 - MAX_BODY_PIERCING) - left.price) / dt
        rest[i0:] = (level - left.price) / dt
        inv[i0:] = -left.price / dt
    rest_prefix = (
        np.maximum.accumulate(rest) if kind == "high" else np.minimum.accumulate(rest)
    )
    return rest, rest_prefix, brk, inv


class _SideSearch:
    """Slope-bound leg search for one pivot side (``high`` or ``low``).

    Equivalent to scanning every candle against the fitted line, but each
    ``rests_on_side``/``find_break`` query evaluates precomputed per-bar slope
    bounds instead of re-scanning the price span.
    """

    def __init__(self, frame, pivots, kind):
        self.frame = frame
        self.kind = kind
        self.is_high = kind == "high"
        self._tables = {pivot.index: _anchor_bounds(frame, pivot, kind) for pivot in pivots}

    def rests_on_side(self, left, slope, from_index=None, to_index=None):
        """Every candle in the range stays on the correct side of the line."""
        frame = self.frame
        start = left.index if from_index is None else from_index
        end = frame.n - 1 if to_index is None else to_index
        start = max(start, left.index + 1)
        if start > end:
            return True
        rest, rest_prefix, _, _ = self._tables[left.index]
        if start == left.index + 1:
            bound = float(rest_prefix[end])
        else:
            seg = rest[start : end + 1]
            bound = float(seg.max() if self.is_high else seg.min())
        if self.is_high:
            if not slope >= bound:
                return False
        elif not slope <= bound:
            return False
        dt_end = frame.times[end] - left.time
        return dt_end <= 0 or slope > -left.price / dt_end

    def find_break(self, left, slope, after_index):
        """First close beyond the line, or -1 while the line still holds."""
        frame = self.frame
        start = after_index + 1
        if start >= frame.n:
            return -1
        _, _, brk, inv = self._tables[left.index]
        b = brk[start:]
        c = inv[start:]
        bad = (slope < b) | (slope <= c) if self.is_high else (slope > b) | (slope <= c)
        first = int(np.argmax(bad))
        if not bad[first]:
            return -1
        index = start + first
        return -1 if slope <= float(inv[index]) else index

    def collect_legs(self, pivots):
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
                if not self.rests_on_side(left, slope, left.index, right.index):
                    continue
                legs.append(
                    _Leg(
                        left=left,
                        right=right,
                        slope=slope,
                        span=right.index - left.index,
                        touches=_count_touches(pivots, left, right, slope),
                        break_index=self.find_break(left, slope, right.index),
                    )
                )
        return legs

    def choose_current(self, legs):
        """The still-respected leg anchored in the newest fifth of the window."""
        active_from = (self.frame.n - 1) * ACTIVE_START
        best = None
        for leg in legs:
            if leg.break_index != -1 or leg.right.index < active_from:
                continue
            if not self.rests_on_side(leg.left, leg.slope, leg.right.index, self.frame.n - 1):
                continue
            if (
                best is None
                or leg.right.index > best.right.index
                or (leg.right.index == best.right.index and leg.touches > best.touches)
                or (leg.right.index == best.right.index and leg.touches == best.touches and leg.span > best.span)
            ):
                best = leg
        return best

    def choose_prior(self, legs, current):
        """The most recently broken leg that ended before the current leg began."""
        best = None
        for leg in legs:
            if leg.break_index == -1:
                continue
            if current and (leg.right.index >= current.left.index or leg.break_index > current.left.index):
                continue
            if not self.rests_on_side(leg.left, leg.slope, leg.right.index, leg.break_index - 1):
                continue
            if (
                best is None
                or leg.break_index > best.break_index
                or (leg.break_index == best.break_index and leg.touches > best.touches)
                or (leg.break_index == best.break_index and leg.touches == best.touches and leg.span > best.span)
            ):
                best = leg
        return best


def _count_touches(pivots, left, right, slope):
    touches = 0
    for pivot in pivots:
        if pivot.index <= left.index or pivot.index >= right.index:
            continue
        value = _price_at(left, slope, pivot.time)
        if abs(pivot.price - value) <= value * TOUCH_TOLERANCE:
            touches += 1
    return touches


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
    pivots and leg checks, matching the chart overlay. Bar ``time`` values may be
    epoch seconds or datetimes; they are normalised internally.
    """
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported trend-bias timeframe: {timeframe}")
    now = time.time() if now_seconds is None else float(now_seconds)
    closed = _closed_bars(_normalise_bars(list(bars)), timeframe, now)
    if len(closed) < REQUIRED_BARS:
        return None

    end_time = now + TREND_BIAS_EXTEND_SECONDS
    bar_seconds = TIMEFRAME_SECONDS[timeframe]
    frame = _Frame(closed)
    lines = []
    current_lines = []
    for kind in ("high", "low"):
        pivots = _find_pivots(closed, kind)
        search = _SideSearch(frame, pivots, kind)
        legs = search.collect_legs(pivots)
        current = search.choose_current(legs)
        prior = search.choose_prior(legs, current)
        if prior is not None:
            lines.append(
                _build_line(
                    kind, prior, "prior", closed[prior.break_index]["time"], bar_seconds
                )
            )
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
