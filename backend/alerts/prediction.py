"""Pure prediction calculations for the two-stage volatility/breakout alerts.

The chart and this module deliberately use the same key-level recipe: three-bar
swings, an ATR-scaled cluster, a four-times higher-timeframe confluence check, and
the five weighted factors shown in the chart tooltip. Keeping the arithmetic pure
makes the rules testable without an exchange connection.

Stage A is a multi-timeframe breakout detector. The 4-hour chart supplies the major
support/resistance levels and the trend baseline, the 1-hour chart is the only
breakout trigger, and the 15-minute chart is an optional retest refinement. Every
function consumes completed candles only; ``stage_a_snapshot`` additionally clips
the 4H and 15M series to candles that had closed by the end of the selected 1H bar,
so a signal can never be built from information that did not exist yet.
"""

from datetime import datetime, timezone as dt_timezone
import math


KEY_LEVEL_WEIGHTS = {
    "reactions": 30,
    "rejection": 25,
    "confluence": 20,
    "volume": 15,
    "recency": 10,
}
SWING_SPAN = 3
HTF_MULTIPLIER = 4
HTF_SWING_SPAN = 2
MAX_BARS = 420
RECENCY_BARS = 180
MIN_REACTIONS = 1
BOLLINGER_LENGTH = 20
BOLLINGER_MULTIPLIER = 2
BB_HISTORY = 100
BB_SQUEEZE_PERCENTILE = 0.15
ATR_PERIOD = 14
RSI_PERIOD = 14
VOLUME_AVERAGE_BARS = 20
BREAKOUT_ATR_FRACTION = 0.10
VOLUME_BREAKOUT_MULTIPLE = 1.5

# Stage A timeframes. The 1H chart is always the trigger; the higher timeframe gives
# context and the lower one is an optional retest refinement.
STAGE_A_CONTEXT_TIMEFRAME = "4h"
STAGE_A_MAIN_TIMEFRAME = "1h"
STAGE_A_REFINEMENT_TIMEFRAME = "15m"
STAGE_A_MAIN_SECONDS = 3600
STAGE_A_CONTEXT_SECONDS = 4 * 3600
STAGE_A_REFINEMENT_SECONDS = 15 * 60

# Stage A thresholds. The approach band is deliberately wider than the breakout
# buffer: the early warning is supposed to arrive before price touches the level.
STAGE_A_APPROACH_ATR = 0.75
STAGE_A_APPROACH_MIN_STRENGTH = 60
STAGE_A_BREAKOUT_ATR = 0.25
STAGE_A_BREAKOUT_MIN_STRENGTH = 40
STAGE_A_ROOM_ATR_TARGET = 2.0
STAGE_A_ROOM_ATR_MIN = 1.5

# Weights sum to 100. They are intentionally exposed as a dictionary so a caller can
# tune the score without changing the detection rules. The breakout component is only
# ever awarded for a real completed-candle trigger, so a high score can never stand in
# for a missing breakout.
STAGE_A_SCORE_WEIGHTS = {
    "squeeze": 15,
    "key_level": 15,
    "breakout": 25,
    "volume": 20,
    "trend": 10,
    "rsi": 5,
    "atr_expansion": 5,
    "room": 5,
}
STAGE_A_HIGH_CONFLUENCE_SCORE = 80


def _clamp01(value):
    return min(1.0, max(0.0, value))


def _average(values):
    return sum(values) / len(values) if values else 0.0


def _find_pivots(bars, span):
    """Local swing highs/lows, strictly beyond every bar in the span either side."""
    pivots = []
    for index in range(span, len(bars) - span):
        bar = bars[index]
        high = True
        low = True
        for offset in range(1, span + 1):
            if bars[index - offset]["high"] >= bar["high"] or bars[index + offset]["high"] >= bar["high"]:
                high = False
            if bars[index - offset]["low"] <= bar["low"] or bars[index + offset]["low"] <= bar["low"]:
                low = False
        if high:
            pivots.append({"index": index, "price": bar["high"], "kind": "high", "bar": bar})
        if low:
            pivots.append({"index": index, "price": bar["low"], "kind": "low", "bar": bar})
    return pivots


def _aggregate_bars(bars, factor):
    """Four selected-timeframe bars become one higher-timeframe bar."""
    result = []
    for index in range(0, len(bars), factor):
        group = bars[index:index + factor]
        if not group:
            continue
        result.append({
            "time": group[-1]["time"],
            "open": group[0]["open"],
            "high": max(bar["high"] for bar in group),
            "low": min(bar["low"] for bar in group),
            "close": group[-1]["close"],
            "volume": sum(bar["volume"] for bar in group),
        })
    return result


def _independent_pivots(pivots, min_gap):
    """Two swings a few bars apart are one reaction, keeping the more extreme one."""
    ordered = sorted(pivots, key=lambda item: item["index"])
    kept = []
    for pivot in ordered:
        nearby_index = next(
            (index for index, item in enumerate(kept) if abs(item["index"] - pivot["index"]) < min_gap),
            None,
        )
        if nearby_index is None:
            kept.append(pivot)
            continue
        nearby = kept[nearby_index]
        more_extreme = (
            pivot["price"] > nearby["price"]
            if pivot["kind"] == "high"
            else pivot["price"] < nearby["price"]
        )
        if more_extreme:
            kept[nearby_index] = pivot
    return kept


def _cluster_pivots(pivots, tolerance):
    """Group prices that sit within one ATR-scaled tolerance of the running cluster mean."""
    ordered = sorted(pivots, key=lambda item: item["price"])
    clusters = []
    for pivot in ordered:
        if not clusters:
            clusters.append([pivot])
            continue
        cluster = clusters[-1]
        mean = _average([item["price"] for item in cluster])
        if abs(pivot["price"] - mean) <= tolerance:
            cluster.append(pivot)
        else:
            clusters.append([pivot])
    return clusters


def _rejection_score(pivots, kind):
    scores = []
    for pivot in pivots:
        bar = pivot["bar"]
        span = bar["high"] - bar["low"]
        if span <= 0:
            scores.append(0.0)
            continue
        wick = (
            (bar["high"] - max(bar["open"], bar["close"])) / span
            if kind == "resistance"
            else (min(bar["open"], bar["close"]) - bar["low"]) / span
        )
        close_away = (
            (bar["open"] - bar["close"]) / span
            if kind == "resistance"
            else (bar["close"] - bar["open"]) / span
        )
        scores.append(_clamp01(0.65 * wick + 0.35 * max(0.0, close_away)))
    return _average(scores)


def _volume_score(pivots, baseline):
    if baseline <= 0:
        return 0.0
    reaction_volume = _average([pivot["bar"]["volume"] for pivot in pivots])
    return _clamp01((reaction_volume / baseline - 0.75) / 0.75)


def _recency_score(pivots, last_index):
    newest = max(pivot["index"] for pivot in pivots)
    return _clamp01(1 - (last_index - newest) / RECENCY_BARS)


def _confluence_score(center, half_width, kind, htf_pivots):
    matching = [
        pivot for pivot in htf_pivots
        if pivot["kind"] == ("high" if kind == "resistance" else "low")
    ]
    if not matching:
        return 0.0
    falloff = max(half_width * 2.5, center * 0.0001)
    return max(
        (_clamp01(1 - abs(pivot["price"] - center) / falloff) for pivot in matching),
        default=0.0,
    )


def _build_level(kind, pivots, atr_value, baseline_volume, last_index, htf_pivots):
    prices = [pivot["price"] for pivot in pivots]
    center = _average(prices)
    spread = max(prices) - min(prices)
    atr_band = atr_value if atr_value is not None and atr_value > 0 else center * 0.002
    half_width = max(
        atr_band * 0.25,
        spread / 2 + center * 0.00015,
        center * 0.0004,
    )
    factors = {
        "reactions": _clamp01(len(pivots) / 4),
        "rejection": _rejection_score(pivots, kind),
        "confluence": _confluence_score(center, half_width, kind, htf_pivots),
        "volume": _volume_score(pivots, baseline_volume),
        "recency": _recency_score(pivots, last_index),
    }
    # JavaScript's Math.round rounds .5 up; Python's round uses banker's rounding, which
    # would make the backend score occasionally differ from the label drawn on the chart.
    strength = int(math.floor(sum(
        KEY_LEVEL_WEIGHTS[name] * factors[name] for name in KEY_LEVEL_WEIGHTS
    ) + 0.5))
    return {
        "kind": kind,
        "price": center,
        "low": center - half_width,
        "high": center + half_width,
        "strength": strength,
        "reactions": len(pivots),
        "factors": factors,
    }


def find_key_levels(bars, atr_value=None):
    """Return the two closest levels per side, plus every level for breakout checks.

    The chart shows only the closest two supports and two resistances. Alert B must
    still be able to see the level that was just broken even when it has moved to
    the other side of the current close, so ``all`` keeps the unfiltered list.
    """
    empty = {"supports": [], "resistances": [], "all": []}
    if len(bars) < 20:
        return empty

    bars = bars[-MAX_BARS:]
    last_index = len(bars) - 1
    close = bars[last_index]["close"]
    if atr_value is None:
        atr_value = atr_last(bars)
    baseline_volume = _average([bar["volume"] for bar in bars])
    pivots = _find_pivots(bars, SWING_SPAN)
    if not pivots:
        return empty

    htf_bars = _aggregate_bars(bars, HTF_MULTIPLIER)
    htf_pivots = _find_pivots(htf_bars, HTF_SWING_SPAN) if len(htf_bars) > HTF_SWING_SPAN * 2 else []
    tolerance = max(
        (atr_value if atr_value is not None and atr_value > 0 else close * 0.002) * 0.35,
        close * 0.0008,
    )

    levels = []
    for kind in ("support", "resistance"):
        matching = [
            pivot for pivot in pivots
            if pivot["kind"] == ("high" if kind == "resistance" else "low")
        ]
        for cluster in _cluster_pivots(matching, tolerance):
            independent = _independent_pivots(cluster, SWING_SPAN * 2 + 1)
            if len(independent) < MIN_REACTIONS:
                continue
            levels.append(_build_level(
                kind, independent, atr_value, baseline_volume, last_index, htf_pivots,
            ))

    supports = sorted(
        (level for level in levels if level["kind"] == "support" and level["price"] <= close),
        key=lambda level: close - level["price"],
    )[:2]
    resistances = sorted(
        (level for level in levels if level["kind"] == "resistance" and level["price"] >= close),
        key=lambda level: level["price"] - close,
    )[:2]
    return {"supports": supports, "resistances": resistances, "all": levels}


def bollinger_widths(bars, length=BOLLINGER_LENGTH, multiplier=BOLLINGER_MULTIPLIER):
    """Bollinger Band width as ``(upper - lower) / middle`` for every completed bar."""
    result = [None] * len(bars)
    closes = [bar["close"] for bar in bars]
    for index in range(length - 1, len(bars)):
        window = closes[index - length + 1:index + 1]
        mean = _average(window)
        if mean == 0:
            continue
        variance = sum((value - mean) ** 2 for value in window) / length
        deviation = math.sqrt(max(0.0, variance))
        result[index] = (2 * multiplier * deviation) / abs(mean)
    return result


def atr_series(bars, period=ATR_PERIOD):
    result = [None] * len(bars)
    if len(bars) <= period:
        return result
    true_ranges = []
    for index, bar in enumerate(bars):
        previous_close = bars[index - 1]["close"] if index else bar["open"]
        true_ranges.append(max(
            bar["high"] - bar["low"],
            abs(bar["high"] - previous_close),
            abs(bar["low"] - previous_close),
        ))
    value = sum(true_ranges[:period]) / period
    result[period - 1] = value
    for index in range(period, len(bars)):
        value = (value * (period - 1) + true_ranges[index]) / period
        result[index] = value
    return result


def atr_last(bars, period=ATR_PERIOD):
    values = atr_series(bars, period)
    return values[-1] if values else None


def rsi_last(closes, period=RSI_PERIOD):
    if len(closes) <= period:
        return None
    gains = []
    losses = []
    for index in range(1, len(closes)):
        change = closes[index] - closes[index - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))
    average_gain = sum(gains[:period]) / period
    average_loss = sum(losses[:period]) / period
    for index in range(period, len(gains)):
        average_gain = (average_gain * (period - 1) + gains[index]) / period
        average_loss = (average_loss * (period - 1) + losses[index]) / period
    if average_loss == 0:
        return 100.0
    return 100 - 100 / (1 + average_gain / average_loss)


def ema_last(values, period):
    if len(values) < period:
        return None
    ema = sum(values[:period]) / period
    multiplier = 2 / (period + 1)
    for value in values[period:]:
        ema = (value - ema) * multiplier + ema
    return ema


def prediction_snapshot(bars, ema_period=100):
    """Build one closed-bar indicator snapshot.

    ``bars`` must contain closed candles only, in chronological order. Stage B uses
    the newest bar directly; Stage A calls this once for 1H and once for 4H context.
    """
    if len(bars) < BB_HISTORY + BOLLINGER_LENGTH:
        return None
    bars = bars[-500:]
    closes = [bar["close"] for bar in bars]
    widths = bollinger_widths(bars)
    valid_widths = [value for value in widths if value is not None]
    if len(valid_widths) < BB_HISTORY or widths[-1] is None or widths[-2] is None:
        return None
    current_width = widths[-1]
    history = valid_widths[-BB_HISTORY:]
    percentile = sum(1 for value in history if value <= current_width) / len(history)
    atr_value = atr_last(bars)
    if atr_value is None or atr_value <= 0 or len(bars) < VOLUME_AVERAGE_BARS + 1:
        return None
    rsi_value = rsi_last(closes)
    ema_value = ema_last(closes, ema_period)
    if rsi_value is None or ema_value is None:
        return None
    previous_volume = _average([bar["volume"] for bar in bars[-VOLUME_AVERAGE_BARS - 1:-1]])
    volume_ratio = bars[-1]["volume"] / previous_volume if previous_volume > 0 else None
    levels = find_key_levels(bars, atr_value)
    return {
        "bar_time": datetime.fromtimestamp(int(bars[-1]["time"]), tz=dt_timezone.utc),
        "close": closes[-1],
        "previous_close": closes[-2],
        "atr": atr_value,
        "bb_width": current_width,
        "bb_width_previous": widths[-2],
        "bb_percentile": percentile,
        "bb_expanding": current_width > widths[-2],
        "volume_ratio": volume_ratio,
        "rsi": rsi_value,
        "ema": ema_value,
        "ema_period": ema_period,
        "levels": levels,
    }


def _clamp_score(value):
    return max(0.0, min(100.0, value))


def _score_weights(weights=None):
    resolved = dict(STAGE_A_SCORE_WEIGHTS)
    for name, value in (weights or {}).items():
        if name in resolved:
            resolved[name] = max(0.0, float(value))
    return resolved


def _trend_aligned(part, direction):
    """Price is on the expected side of its EMA; ties are not aligned."""
    if not part or part.get("ema") is None:
        return False
    if direction == "long":
        return part["close"] > part["ema"]
    return part["close"] < part["ema"]


def _rsi_aligned(rsi_value, direction):
    if rsi_value is None:
        return False
    return rsi_value > 50 if direction == "long" else rsi_value < 50


def _next_opposing_level(levels, close, direction):
    """Closest level that still has to be crossed in the direction of the trade."""
    if direction == "long":
        candidates = [
            level for level in levels
            if level["kind"] == "resistance" and level["price"] > close
        ]
        return min(candidates, key=lambda item: item["price"]) if candidates else None
    candidates = [
        level for level in levels
        if level["kind"] == "support" and level["price"] < close
    ]
    return max(candidates, key=lambda item: item["price"]) if candidates else None


def _retest(snapshot, level, direction):
    """Whether a completed 15M candle retested and held the broken level.

    ``None`` means the optional 15M feed was unavailable, which must never block a 1H
    breakout. The refinement bars were already clipped to the trigger bar's close.
    """
    refinement = snapshot.get("refinement")
    if not refinement:
        return None
    recent = refinement.get("recent") or []
    if not recent:
        return None
    level_high = level.get("high", level["price"])
    level_low = level.get("low", level["price"])
    for bar in recent:
        if direction == "long":
            if bar["low"] <= level_high and bar["close"] > level_high:
                return True
        elif bar["high"] >= level_low and bar["close"] < level_low:
            return True
    return False


def _score_components(snapshot, level, direction, *, breakout_confirmed, weights=None):
    """Score a setup from 0 to 100 using the configurable Stage A weights.

    The breakout component is only awarded when ``breakout_confirmed`` is true. A
    caller therefore cannot reach a high-confluence label from trend, RSI or volume
    alone: the trigger has to exist before the event is produced.
    """
    atr_value = snapshot["atr"]
    details = {
        "squeeze": 1.0 if snapshot.get("bb_squeeze") else 0.0,
        "key_level": _clamp01(float(level.get("strength") or 0) / 100.0),
        "breakout": 1.0 if breakout_confirmed else 0.0,
        "volume": _clamp01(((snapshot.get("volume_ratio") or 0.0) - 1.0) / 1.0),
        "trend": 0.0,
        "rsi": 1.0 if _rsi_aligned(snapshot.get("rsi"), direction) else 0.0,
        "atr_expansion": 0.0,
        "room": 0.0,
    }

    main_part = snapshot.get("main") or snapshot
    context_part = snapshot.get("context") or snapshot
    main_trend_aligned = _trend_aligned(main_part, direction)
    context_trend_aligned = _trend_aligned(context_part, direction)
    details["trend"] = 0.5 * main_trend_aligned + 0.5 * context_trend_aligned

    previous_atr = snapshot.get("atr_previous")
    atr_expanding = previous_atr is not None and atr_value > previous_atr
    details["atr_expansion"] = 1.0 if atr_expanding else 0.0

    next_level = _next_opposing_level(snapshot["levels"]["all"], snapshot["close"], direction)
    room_atr = (
        abs(next_level["price"] - snapshot["close"]) / atr_value
        if next_level is not None and atr_value > 0 else None
    )
    if room_atr is None:
        # No opposing level overhead/underneath means the move has open room.
        details["room"] = 1.0
    else:
        details["room"] = _clamp01(room_atr / STAGE_A_ROOM_ATR_TARGET)

    resolved = _score_weights(weights)
    points = {name: resolved[name] * ratio for name, ratio in details.items()}
    score = int(math.floor(_clamp_score(sum(points.values())) + 0.5))
    return {
        "score": score,
        "score_breakdown": {
            name: {"ratio": details[name], "points": points[name]}
            for name in STAGE_A_SCORE_WEIGHTS
        },
        "main_trend_aligned": main_trend_aligned,
        "context_trend_aligned": context_trend_aligned,
        "trend_aligned": main_trend_aligned and context_trend_aligned,
        "rsi_aligned": bool(details["rsi"]),
        "atr_expanding": atr_expanding,
        "next_level": next_level,
        "room_atr": room_atr,
        "room_ok": room_atr is None or room_atr >= STAGE_A_ROOM_ATR_MIN,
    }


def _refinement_snapshot(bars):
    if not bars:
        return None
    recent = bars[-3:]
    latest = recent[-1]
    return {
        "bar_time": datetime.fromtimestamp(int(latest["time"]), tz=dt_timezone.utc),
        "close": latest["close"],
        "high": latest["high"],
        "low": latest["low"],
        "recent": recent,
    }


def stage_a_snapshot(context_bars, main_bars, refinement_bars=None, ema_period=100):
    """Build the multi-timeframe Stage A snapshot from completed candles.

    ``context_bars`` are 4H candles, ``main_bars`` are 1H candles, and
    ``refinement_bars`` are optional 15M candles. The 4H and 15M series are clipped to
    candles that had closed no later than the trigger bar. That keeps both series free
    of future information and also protects against an exchange returning a newer
    partial higher-timeframe candle.
    """
    if not main_bars or not context_bars:
        return None

    main_open = int(main_bars[-1]["time"])
    main_close = main_open + STAGE_A_MAIN_SECONDS
    context_bars = [
        bar for bar in context_bars
        if int(bar["time"]) + STAGE_A_CONTEXT_SECONDS <= main_close
    ]
    refinement_bars = [
        bar for bar in (refinement_bars or [])
        if int(bar["time"]) + STAGE_A_REFINEMENT_SECONDS <= main_close
    ]

    main = prediction_snapshot(main_bars, ema_period)
    context = prediction_snapshot(context_bars, ema_period)
    if main is None or context is None:
        return None

    atr_values = atr_series(main_bars)
    previous_atr = atr_values[-2] if len(atr_values) >= 2 else None
    return {
        "timeframe": STAGE_A_MAIN_TIMEFRAME,
        "context_timeframe": STAGE_A_CONTEXT_TIMEFRAME,
        "refinement_timeframe": STAGE_A_REFINEMENT_TIMEFRAME,
        "bar_time": main["bar_time"],
        "close": main["close"],
        "previous_close": main["previous_close"],
        "atr": main["atr"],
        "atr_previous": previous_atr,
        "atr_expanding": previous_atr is not None and main["atr"] > previous_atr,
        "bb_width": main["bb_width"],
        "bb_width_previous": main["bb_width_previous"],
        "bb_percentile": main["bb_percentile"],
        "bb_squeeze": main["bb_percentile"] <= BB_SQUEEZE_PERCENTILE,
        "bb_expanding": main["bb_expanding"],
        "volume_ratio": main["volume_ratio"],
        "rsi": main["rsi"],
        "ema": main["ema"],
        "ema_period": main["ema_period"],
        # 4H levels are the major zones Stage A trades around; the 1H series supplies
        # the trigger, volume, squeeze and momentum readings.
        "levels": context["levels"],
        "main_levels": main["levels"],
        "main": main,
        "context": context,
        "refinement": _refinement_snapshot(refinement_bars),
    }


def stage_a_setup(snapshot, *, weights=None, max_distance_atr=STAGE_A_APPROACH_ATR,
                  min_strength=STAGE_A_APPROACH_MIN_STRENGTH):
    """Early warning: a squeeze while price approaches a major 4H level.

    This is deliberately only a setup event. The score can never rise to the
    high-confluence band here because the 25-point breakout component is withheld.
    """
    if snapshot is None or not snapshot.get("bb_squeeze"):
        return None
    atr_value = snapshot["atr"]
    close = snapshot["close"]
    if atr_value <= 0:
        return None

    candidates = []
    for level in snapshot["levels"]["all"]:
        if level["strength"] < min_strength:
            continue
        if level["kind"] == "support" and level["price"] > close:
            continue
        if level["kind"] == "resistance" and level["price"] < close:
            continue
        candidates.append((abs(close - level["price"]), level))
    if not candidates:
        return None
    distance, level = min(candidates, key=lambda item: item[0])
    if distance > max_distance_atr * atr_value:
        return None

    direction = "long" if level["kind"] == "support" else "short"
    signal = {
        "event": "early",
        "direction": direction,
        "level": level,
        "distance": distance,
        "distance_atr": distance / atr_value,
        "breakout_atr": None,
        "high_confluence": False,
        "retest": _retest(snapshot, level, direction),
    }
    signal.update(_score_components(
        snapshot, level, direction, breakout_confirmed=False, weights=weights,
    ))
    return signal


def stage_a_breakout(snapshot, *, weights=None,
                     high_confluence_threshold=STAGE_A_HIGH_CONFLUENCE_SCORE,
                     min_strength=STAGE_A_BREAKOUT_MIN_STRENGTH):
    """Breakout: a completed 1H candle closes through a 4H level by the ATR buffer.

    Relative volume of at least 1.5× the 20-candle average is required. Trend, RSI and
    ATR expansion are optional confirmations that lift the quality score; they are not
    allowed to create a breakout on their own.
    """
    if snapshot is None:
        return None
    volume_ratio = snapshot.get("volume_ratio")
    if volume_ratio is None or volume_ratio < VOLUME_BREAKOUT_MULTIPLE:
        return None
    atr_value = snapshot["atr"]
    close = snapshot["close"]
    previous_close = snapshot["previous_close"]
    if atr_value <= 0:
        return None
    buffer_distance = STAGE_A_BREAKOUT_ATR * atr_value

    long_candidates = []
    short_candidates = []
    for level in snapshot["levels"]["all"]:
        if level["strength"] < min_strength:
            continue
        if level["kind"] == "resistance":
            threshold = level["price"] + buffer_distance
            # A fresh crossing only: a level that has been above for several completed
            # candles must not keep producing the same alert.
            if previous_close < threshold <= close:
                long_candidates.append(level)
        elif level["kind"] == "support":
            threshold = level["price"] - buffer_distance
            if previous_close > threshold >= close:
                short_candidates.append(level)

    if long_candidates:
        level = max(long_candidates, key=lambda item: item["price"])
        direction = "long"
        breakout_atr = (close - level["price"]) / atr_value
    elif short_candidates:
        level = min(short_candidates, key=lambda item: item["price"])
        direction = "short"
        breakout_atr = (level["price"] - close) / atr_value
    else:
        return None

    signal = {
        "event": "breakout",
        "direction": direction,
        "level": level,
        "distance": abs(close - level["price"]),
        "distance_atr": abs(close - level["price"]) / atr_value,
        "breakout_atr": breakout_atr,
        "high_confluence": False,
        "retest": _retest(snapshot, level, direction),
    }
    signal.update(_score_components(
        snapshot, level, direction, breakout_confirmed=True, weights=weights,
    ))
    signal["high_confluence"] = bool(
        signal["score"] >= high_confluence_threshold
        and signal["trend_aligned"]
        and signal["rsi_aligned"]
        and signal["atr_expanding"]
        and signal["room_ok"]
    )
    return signal


def stage_a_failed(snapshot, state):
    """Failed breakout: price closes back inside the range that was broken."""
    if snapshot is None or not state or state.get("state") != "breakout":
        return None
    direction = state.get("direction")
    level = state.get("level") or {}
    level_price = level.get("price")
    if direction not in {"long", "short"} or level_price is None:
        return None

    close = snapshot["close"]
    if direction == "long":
        boundary = level.get("high", level_price)
        if close > boundary:
            return None
    else:
        boundary = level.get("low", level_price)
        if close < boundary:
            return None

    atr_value = snapshot["atr"]
    failed_atr = abs(close - level_price) / atr_value if atr_value > 0 else None
    return {
        "event": "failed",
        "direction": direction,
        "level": level,
        "close_back_inside": True,
        "failed_atr": failed_atr,
        "breakout_atr": None,
        "distance": abs(close - level_price),
        "distance_atr": failed_atr,
        "score": state.get("score"),
        "high_confluence": bool(state.get("high_confluence")),
        "retest": None,
    }


def _same_level(left, right):
    """True when two level dictionaries describe the same price zone."""
    if not left or not right or left.get("kind") != right.get("kind"):
        return False
    left_price, right_price = left.get("price"), right.get("price")
    if left_price is None or right_price is None:
        return False
    return abs(left_price - right_price) <= max(1e-9, abs(right_price) * 0.0001)


def _idle_state():
    return {
        "state": "idle",
        "direction": "",
        "level": {},
        "score": None,
        "high_confluence": False,
    }


def _signal_state(signal):
    return {
        "state": signal["event"],
        "direction": signal["direction"],
        "level": signal["level"],
        "score": signal.get("score"),
        "high_confluence": bool(signal.get("high_confluence")),
    }


def stage_a_evaluate(snapshot, state=None, *, weights=None,
                     high_confluence_threshold=STAGE_A_HIGH_CONFLUENCE_SCORE):
    """Advance the Stage A state machine by one completed 1H bar.

    Returns ``(event_or_none, new_state)``. A breakout supersedes an early warning,
    an early warning fires once per squeeze episode, and a confirmed breakout can
    produce one failed-breakout event before the state returns to idle.
    """
    state = state or _idle_state()
    current = state.get("state") or "idle"
    if snapshot is None:
        return None, state

    if current == "breakout":
        failed = stage_a_failed(snapshot, state)
        if failed is not None:
            return failed, _idle_state()
        # A break of a different level is a new market event, not a duplicate. The
        # same level cannot re-fire while its breakout remains active.
        breakout = stage_a_breakout(
            snapshot, weights=weights,
            high_confluence_threshold=high_confluence_threshold,
        )
        if breakout is not None and not _same_level(breakout["level"], state.get("level")):
            return breakout, _signal_state(breakout)
        return None, state

    breakout = stage_a_breakout(
        snapshot, weights=weights, high_confluence_threshold=high_confluence_threshold,
    )
    if breakout is not None:
        return breakout, _signal_state(breakout)

    setup = stage_a_setup(snapshot, weights=weights)
    if setup is not None:
        if current == "early":
            return None, state
        return setup, _signal_state(setup)
    if current == "early":
        # The squeeze or the distance to the level cleared, so a new episode may warn.
        return None, _idle_state()
    return None, _idle_state()


def stage_b_signal(snapshot):
    """A completed candle breaking a key level with volume and trend confirmation."""
    if snapshot is None or not snapshot["bb_expanding"]:
        return None
    volume_ratio = snapshot["volume_ratio"]
    if volume_ratio is None or volume_ratio <= VOLUME_BREAKOUT_MULTIPLE:
        return None
    atr_value = snapshot["atr"]
    close = snapshot["close"]
    previous_close = snapshot["previous_close"]
    rsi_value = snapshot["rsi"]
    ema_value = snapshot["ema"]
    levels = snapshot["levels"]["all"]

    long_candidates = []
    short_candidates = []
    if rsi_value > 50 and close > ema_value:
        for level in levels:
            if level["kind"] != "resistance":
                continue
            threshold = level["price"] + BREAKOUT_ATR_FRACTION * atr_value
            # Cross the 0.1 ATR buffer on this completed candle rather than re-reporting a
            # breakout that has already been above the level for several candles.
            if previous_close < threshold <= close:
                long_candidates.append(level)
    if rsi_value < 50 and close < ema_value:
        for level in levels:
            if level["kind"] != "support":
                continue
            threshold = level["price"] - BREAKOUT_ATR_FRACTION * atr_value
            if previous_close > threshold >= close:
                short_candidates.append(level)

    if long_candidates:
        level = max(long_candidates, key=lambda item: item["price"])
        return {
            "direction": "long",
            "level": level,
            "breakout_atr": (close - level["price"]) / atr_value,
            "volume_ratio": volume_ratio,
        }
    if short_candidates:
        level = min(short_candidates, key=lambda item: item["price"])
        return {
            "direction": "short",
            "level": level,
            "breakout_atr": (level["price"] - close) / atr_value,
            "volume_ratio": volume_ratio,
        }
    return None


def stage_a_event(alert, snapshot, signal):
    """Event metadata for Stage A; notification copy is composed in services."""
    bias = "Bullish" if signal["direction"] == "long" else "Bearish"
    event = signal.get("event")
    if event == "early":
        label = "Early Warning"
    elif event == "failed":
        label = "Failed Breakout"
    else:
        label = "Breakout"
        if signal.get("high_confluence"):
            label += " · High Confluence"
    return {
        "title": f"{alert.symbol}({snapshot.get('timeframe', alert.timeframe)}) Prediction A - {label} - {bias}",
        "observed_value": snapshot["close"],
    }


def stage_b_event(alert, snapshot, signal):
    """Event metadata for Stage B; notification copy is composed in services."""
    status = "Bullish" if signal["direction"] == "long" else "Bearish"
    return {
        "title": f"{alert.symbol}({alert.timeframe}) Prediction B - {status}",
        "observed_value": snapshot["close"],
    }
