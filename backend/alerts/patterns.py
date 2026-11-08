"""Pure chart-pattern detection for the pattern forming alerts.

The rules are the chart's own, reimplemented server side: three-bar swing pivots, a
least-squares line through the swings a shape is made of, and a confirming close measured
against that line. The browser is never consulted — this module is the implementation the
alert job runs, and the chart is the reference it is tested against.

Only the numbers a monitoring job needs come back: the entry level together with the
per-bar drift of the line it sits on, the measured target, the invalidation level, and the
time of the bar that confirmed the shape. The chart draws lines in (time, price) space; the
job only ever asks what a level is worth and where it is heading, so ``slope`` is priced
per bar and the caller advances it by the bars that have closed since the shape was seen.

Bull and bear flags are left out on purpose. A flag never finishes inside its own detector,
and its confirming level is the channel edge at the newest bar, so there is no single entry
and target to pin to a forming alert.
"""

import sys


PATTERN_LABELS = {
    "head_and_shoulders": "Head and Shoulders",
    "inverse_head_and_shoulders": "Inverse Head and Shoulders",
    "double_top": "Double Top",
    "double_bottom": "Double Bottom",
    "ascending_triangle": "Ascending Triangle",
    "descending_triangle": "Descending Triangle",
    "symmetrical_triangle": "Symmetrical Triangle",
    "rising_wedge": "Rising Wedge",
    "falling_wedge": "Falling Wedge",
}

PATTERN_BIAS = {
    "head_and_shoulders": "bearish",
    "inverse_head_and_shoulders": "bullish",
    "double_top": "bearish",
    "double_bottom": "bullish",
    "ascending_triangle": "bullish",
    "descending_triangle": "bearish",
    "symmetrical_triangle": "neutral",
    "rising_wedge": "bearish",
    "falling_wedge": "bullish",
}

DETECTED_PATTERN_KEYS = tuple(PATTERN_LABELS)

# The chart monitor looks at the latest slice of candles; an alert evaluates the same slice.
RECENT_BARS = 50
MIN_BARS = 30
SWING_SPAN = 3
PROJECTION_BARS = 6
MAX_PROJECTION_BARS = 24
FORMING_WINDOW = 30
MIN_REACTION_RATIO = 0.005
MIN_THREE_SWING_BARS = 12
MIN_DOUBLE_SWING_BARS = 10
CONVERGENCE_MIN_BARS = 24
FLAT_SIDE_DRIFT = 0.06
CONVERGING_SIDE_DRIFT = 0.3
WEDGE_SIDE_DRIFT = 0.15

_EPSILON = sys.float_info.epsilon


class _Trend:
    """Least-squares line through a shape's swings; ``at`` extrapolates past them."""

    __slots__ = ("slope", "intercept")

    def __init__(self, slope, intercept):
        self.slope = slope
        self.intercept = intercept

    def at(self, index):
        return self.slope * index + self.intercept


def _price_range(bars):
    low = min(bar["low"] for bar in bars)
    high = max(bar["high"] for bar in bars)
    return {"low": low, "high": high, "span": max(high - low, _EPSILON)}


def _swing_pivots(bars, half_window):
    """A bar whose high, or low, rules its whole window on both sides.

    Bars printing the same extreme side by side are one swing, placed on the first of them, but
    only once strictly weaker bars have closed the run on both sides: an exact tie must not erase
    the swing, and a run still going at the newest bar has not turned yet.
    """
    swings = []
    count = len(bars)

    def rules(index, field, better):
        value = bars[index][field]
        for offset in range(1, half_window + 1):
            if not better(value, bars[index - offset][field]):
                return False
        run_end = index
        while run_end + 1 < count and bars[run_end + 1][field] == value:
            run_end += 1
        if run_end + half_window >= count:
            return False
        return all(better(value, bars[run_end + offset][field]) for offset in range(1, half_window + 1))

    for index in range(half_window, count - half_window):
        is_peak = rules(index, "high", lambda value, other: value > other)
        is_trough = rules(index, "low", lambda value, other: value < other)
        pivot = None
        if is_peak:
            pivot = {"index": index, "price": bars[index]["high"], "kind": "peak"}
        elif is_trough:
            pivot = {"index": index, "price": bars[index]["low"], "kind": "trough"}
        if pivot is None:
            continue
        if swings and swings[-1]["kind"] == pivot["kind"]:
            # Neighbouring bars of the same type are one swing, so only the extreme one is kept.
            stronger = max if pivot["kind"] == "peak" else min
            if stronger(swings[-1]["price"], pivot["price"]) != swings[-1]["price"]:
                swings[-1] = pivot
            continue
        swings.append(pivot)
    return swings


def _alternating(swings):
    """Drops the rare double swing so highs and lows strictly alternate."""
    sequence = []
    for swing in swings:
        if not sequence or sequence[-1]["kind"] != swing["kind"]:
            sequence.append(swing)
    return sequence


def _trend_fit(points):
    if len(points) < 2:
        return None
    count = len(points)
    sum_index = sum(point["index"] for point in points)
    sum_price = sum(point["price"] for point in points)
    sum_product = sum(point["index"] * point["price"] for point in points)
    sum_squared = sum(point["index"] * point["index"] for point in points)
    denominator = count * sum_squared - sum_index * sum_index
    if not denominator:
        return None
    slope = (count * sum_product - sum_index * sum_price) / denominator
    return _Trend(slope, (sum_price - slope * sum_index) / count)


def _flat_trend(price):
    return _Trend(0.0, price)


def _line_fits(pivots, trend, tolerance):
    """A line is only a boundary if every swing it is fitted to actually touches it."""
    return all(abs(pivot["price"] - trend.at(pivot["index"])) <= tolerance for pivot in pivots)


def _projection_edge(bars, last_swing_index):
    """How far past its own last swing a shape's lines are worth following."""
    return min(len(bars) - 1 + PROJECTION_BARS, last_swing_index + MAX_PROJECTION_BARS)


def _first_close_beyond(bars, from_index, direction, level_at):
    """First bar after ``from_index`` closing beyond the level, or ``None``.

    The index is what names the confirmation price: a sloped line sits at a different level
    on the break bar than on the shape's last swing.
    """
    for index in range(max(0, from_index + 1), len(bars)):
        close = bars[index]["close"]
        beyond = close > level_at(index) if direction == "above" else close < level_at(index)
        if beyond:
            return index
    return None


def _time_at(bars, index):
    """Maps a bar index, allowed to run past either end, back onto a timestamp."""
    step = bars[1]["time"] - bars[0]["time"] if len(bars) > 1 else 60
    if index < 0:
        return bars[0]["time"] + index * step
    if index >= len(bars):
        return bars[-1]["time"] + (index - len(bars) + 1) * step
    return bars[index]["time"]


def _broke_against(bars, extreme, levels):
    """A shape stops being a setup once price has closed decisively against it."""
    close = bars[-1]["close"]
    edge = max(levels) if extreme == "peak" else min(levels)
    return close > edge if extreme == "peak" else close < edge


def _price_text(value):
    """Prices as the chart writes them, so an alert and the candle chart say the same number."""
    digits = 2 if value >= 100 else 4 if value >= 1 else 8
    return f"{value:,.{digits}f}".rstrip("0").rstrip(".")


def _level(side, price, slope, target, bias, name, slack=0.0):
    return {
        "side": side,
        "price": price,
        "slope": slope,
        "target": target,
        "bias": bias,
        "name": name,
        # How far past the line a close must land before it counts as a break; the
        # convergence detector ignores overshoots smaller than this as noise.
        "slack": slack,
    }


def _match(key, bars, *, forming, stage, span_bars, end_index, break_index, levels,
           invalidation, summary, bias=None):
    """One reading of the candles, as the numbers a monitoring job has to follow.

    ``stage`` says which part of the shape is still missing, so the alert can name it:
    ``missing_swing`` (the extreme that has not printed), ``awaiting_break`` (the shape is
    drawn, the confirming close is not) or ``broke``. ``levels`` are quoted at the newest bar
    and ``slope`` is their drift per bar, which is what lets a caller keep testing the same
    level as the window slides.
    """
    return {
        "key": key,
        "label": PATTERN_LABELS[key],
        "bias": bias or PATTERN_BIAS[key],
        "forming": forming,
        "stage": stage,
        "summary": summary,
        "span_bars": span_bars,
        "end_time": _time_at(bars, end_index),
        "break_time": None if break_index is None else _time_at(bars, break_index),
        "end_index": end_index,
        "break_index": break_index,
        "levels": levels,
        "invalidation": invalidation,
    }


def _neck_trend(group):
    return _trend_fit([
        {"index": group["neck1"]["index"], "price": group["neck1"]["price"]},
        {"index": group["neck2"]["index"], "price": group["neck2"]["price"]},
    ])


def _score_three_swing(bars, price_range, group, extreme):
    """Geometry test shared by the finished and the partial reading, or ``None``."""
    left, head, neck1, neck2, right = (
        group["left"], group["head"], group["neck1"], group["neck2"], group["right"],
    )
    end = right["index"] if right else neck2["index"]
    if end - left["index"] < MIN_THREE_SWING_BARS:
        return None
    # With no right shoulder yet the left shoulder is the only one to measure the head against.
    shoulder = right["price"] if right else left["price"]
    best_shoulder = max(left["price"], shoulder) if extreme == "peak" else min(left["price"], shoulder)
    advance = head["price"] - best_shoulder if extreme == "peak" else best_shoulder - head["price"]
    span = price_range["span"]
    if advance < 0.02 * span:
        return None
    if right and abs(left["price"] - right["price"]) > max(0.6 * advance, 0.02 * span):
        return None
    # Reaction pivots from different price universes give the neckline a useless slope.
    if abs(neck1["price"] - neck2["price"]) > 0.6 * span:
        return None
    neckline = _neck_trend(group)
    if neckline is None:
        return None
    neck_end = neckline.at(_projection_edge(bars, end))
    if neck_end < price_range["low"] - 0.2 * span or neck_end > price_range["high"] + 0.2 * span:
        return None
    # A group pinned to the left edge is history, so recency is weighted heavily here.
    return advance / span + 0.25 * (end / (len(bars) - 1))


def _still_on_head_side(bars, group):
    """A partial shape is only useful while price is still on the head's side of the neckline."""
    neckline = _neck_trend(group)
    if neckline is None:
        return False
    last = len(bars) - 1
    close = bars[last]["close"]
    neck = neckline.at(last)
    return close > neck if group["head"]["kind"] == "peak" else close < neck


def _find_three_swing(bars, swings, extreme):
    """Head and Shoulders, or the inverted version when the head is made of troughs."""
    sequence = _alternating(swings)
    last = len(bars) - 1
    price_range = _price_range(bars)
    best = None

    def keep(score, group, current):
        if score is None or (current is not None and score <= current["score"]):
            return current
        return {"score": score, "group": group}

    # A shape that has already printed its right shoulder is worth more than a projection.
    for start in range(0, len(sequence) - 4):
        group = {
            "left": sequence[start], "neck1": sequence[start + 1], "head": sequence[start + 2],
            "neck2": sequence[start + 3], "right": sequence[start + 4],
        }
        if (group["left"]["kind"] != extreme or group["head"]["kind"] != extreme
                or group["right"]["kind"] != extreme):
            continue
        # Price clearing the right shoulder has already broken the lower-high structure.
        if _broke_against(bars, extreme, [group["right"]["price"]]):
            continue
        best = keep(_score_three_swing(bars, price_range, group, extreme), group, best)
    if best:
        return best["group"]

    # Head and neckline are on the chart, the right shoulder is not: project it.
    for start in range(0, len(sequence) - 3):
        group = {
            "left": sequence[start], "neck1": sequence[start + 1], "head": sequence[start + 2],
            "neck2": sequence[start + 3], "right": None,
        }
        if group["left"]["kind"] != extreme or group["head"]["kind"] != extreme:
            continue
        if last - group["neck2"]["index"] > FORMING_WINDOW:
            continue
        # The missing shoulder is drawn at the mirrored neckline swing. If that date has already
        # passed without it printing, the setup is stale rather than still forming.
        shoulder_index = 2 * group["neck2"]["index"] - group["neck1"]["index"]
        if shoulder_index <= last:
            continue
        if not _still_on_head_side(bars, group):
            continue
        # A rally through the left shoulder makes the projected shoulder a higher high, so the
        # shape has already failed.
        if _broke_against(bars, extreme, [group["left"]["price"]]):
            continue
        best = keep(_score_three_swing(bars, price_range, group, extreme), group, best)
    return best["group"] if best else None


def _describe_three_swing(key, bars, group):
    bearish = key == "head_and_shoulders"
    left, neck1, head, neck2, right = (
        group["left"], group["neck1"], group["head"], group["neck2"], group["right"],
    )
    end_index = right["index"] if right else neck2["index"]
    edge = _projection_edge(bars, end_index)
    neckline = _neck_trend(group)
    missing_shoulder = right is None
    # A printed right shoulder is only half the pattern: the neckline break confirms it.
    break_index = None
    if right is not None and neckline is not None:
        break_index = _first_close_beyond(
            bars, right["index"], "below" if bearish else "above", neckline.at,
        )
    forming = missing_shoulder or break_index is None
    stage = ("missing_swing" if missing_shoulder
             else "broke" if break_index is not None else "awaiting_break")
    span_bars = end_index - left["index"]
    break_word = "below" if bearish else "above"
    invalidation = {
        "side": "above" if bearish else "below",
        "price": head["price"],
        "slope": 0.0,
    }
    summary = (f"{PATTERN_LABELS[key]} forming over {span_bars} bars" if forming
               else f"{PATTERN_LABELS[key]} over {span_bars} bars")
    if stage == "awaiting_break":
        summary += " · awaiting neckline break"
    if neckline is None:
        return _match(
            key, bars, forming=forming, stage=stage, span_bars=span_bars,
            end_index=end_index, break_index=break_index, levels=[],
            invalidation=invalidation, summary=summary,
        )
    height = (head["price"] - neckline.at(head["index"])) if bearish \
        else (neckline.at(head["index"]) - head["price"])
    side = "down" if bearish else "up"
    slope = neckline.slope
    # The measured move starts where the neckline is broken: the break bar once confirmed, the
    # latest bar while forming. Projecting from the drawing edge would let a sloped neckline drag
    # the target along as new candles arrive.
    price = neckline.at(len(bars) - 1) if forming else neckline.at(break_index)
    target = price - height if bearish else price + height
    if forming:
        summary += f" · break {break_word} {_price_text(price)} · target {_price_text(target)}"
    else:
        summary += f" · neckline {_price_text(price)} · target {_price_text(target)}"
    return _match(
        key, bars, forming=forming, stage=stage, span_bars=span_bars,
        end_index=end_index, break_index=break_index,
        levels=[_level(side, price, slope, target, PATTERN_BIAS[key], "neckline")],
        invalidation=invalidation, summary=summary,
    )


def _find_double_swing(bars, swings, extreme):
    """Two similar swings with one clear reaction between them, or the start of a second."""
    sequence = _alternating(swings)
    last = len(bars) - 1
    price_range = _price_range(bars)
    span = price_range["span"]
    best = None

    def keep(score, group, current):
        if current is not None and score <= current["score"]:
            return current
        return {"score": score, "group": group}

    for start in range(0, len(sequence) - 2):
        group = {"first": sequence[start], "middle": sequence[start + 1], "second": sequence[start + 2]}
        first, middle, second = group["first"], group["middle"], group["second"]
        if first["kind"] != extreme or second["kind"] != extreme:
            continue
        if second["index"] - first["index"] < MIN_DOUBLE_SWING_BARS:
            continue
        if abs(first["price"] - second["price"]) > 0.1 * span:
            continue
        if extreme == "peak":
            reaction = min(first["price"], second["price"]) - middle["price"]
        else:
            reaction = middle["price"] - max(first["price"], second["price"])
        if reaction < 0.03 * span:
            continue
        if reaction < MIN_REACTION_RATIO * max(first["price"], second["price"]):
            continue
        if _broke_against(bars, extreme, [first["price"], second["price"]]):
            continue
        # Depth is what makes this a double top rather than two blips joined by a wiggle, so it
        # leads the score rather than the neatness of the two levels lining up.
        level = max(first["price"], second["price"]) if extreme == "peak" \
            else min(first["price"], second["price"])
        score = ((reaction / level) * 20
                 + (1 - abs(first["price"] - second["price"]) / span)
                 + 0.15 * (second["index"] / last))
        best = keep(score, group, best)
    if best:
        return best["group"]

    # The first extreme is printed and the reaction is under way, but the second has not reached it.
    for start in range(0, len(sequence) - 1):
        group = {"first": sequence[start], "middle": sequence[start + 1], "second": None}
        first, middle = group["first"], group["middle"]
        if first["kind"] != extreme:
            continue
        if last - middle["index"] > FORMING_WINDOW:
            continue
        # The projected second extreme is drawn at the mirrored time. If that bar is already
        # behind us, the setup had its chance and did not print.
        projected_index = 2 * middle["index"] - first["index"]
        if projected_index <= last:
            continue
        depth = abs(first["price"] - middle["price"])
        if depth < 0.03 * span:
            continue
        if depth < MIN_REACTION_RATIO * first["price"]:
            continue
        # Price clearing the first extreme puts the projected second one out of reach.
        if _broke_against(bars, extreme, [first["price"]]):
            continue
        # A close through the reaction level means the neckline broke before the second extreme;
        # that is a failed shape, not a partial one.
        close = bars[last]["close"]
        closed_through_reaction = (
            close <= middle["price"] if extreme == "peak" else close >= middle["price"]
        )
        if closed_through_reaction:
            continue
        score = (depth / first["price"]) * 20 + 0.25 * (middle["index"] / last)
        best = keep(score, group, best)
    return best["group"] if best else None


def _describe_double_swing(key, bars, group):
    bearish = key == "double_top"
    first, middle, second = group["first"], group["middle"], group["second"]
    end_index = second["index"] if second else middle["index"]
    edge = _projection_edge(bars, end_index)
    missing_second = second is None
    # Two equal tops are not confirmed until price closes through the reaction low, mirrored
    # for a double bottom and its reaction high.
    break_index = None
    if second is not None:
        break_index = _first_close_beyond(
            bars, second["index"], "below" if bearish else "above", lambda index: middle["price"],
        )
    forming = missing_second or break_index is None
    stage = ("missing_swing" if missing_second
             else "broke" if break_index is not None else "awaiting_break")
    span_bars = end_index - first["index"]
    # With no second extreme yet, the level it has to come back to is the flat one it left behind.
    level_line = _trend_fit([
        {"index": first["index"], "price": first["price"]},
        {"index": second["index"], "price": second["price"]},
    ]) if second else _flat_trend(first["price"])
    # A single reaction cannot be fitted, so the neckline is the flat level it left behind.
    neckline = _flat_trend(middle["price"])
    failure_level = max(first["price"], second["price"] if second else first["price"]) if bearish \
        else min(first["price"], second["price"] if second else first["price"])
    invalidation = {
        "side": "above" if bearish else "below",
        "price": failure_level,
        "slope": 0.0,
    }
    levels = []
    summary = f"{PATTERN_LABELS[key]}{' forming' if forming else ''} over {span_bars} bars"
    if stage == "awaiting_break":
        summary += " · awaiting neckline break"
    if level_line is not None:
        # Measured move: the outer extreme to the reaction level, not a line extrapolated
        # through both extremes, which would grow with any difference between them.
        height = abs(failure_level - middle["price"])
        target = neckline.at(edge) - height if bearish else neckline.at(edge) + height
        break_word = "below" if bearish else "above"
        if forming:
            summary += f" · break {break_word} {_price_text(neckline.at(edge))}"
        else:
            summary += f" · neckline {_price_text(neckline.at(edge))}"
        summary += f" · target {_price_text(target)}"
        levels = [_level(
            "down" if bearish else "up", neckline.at(edge), neckline.slope, target,
            PATTERN_BIAS[key], "reaction level",
        )]
    return _match(
        key, bars, forming=forming, stage=stage, span_bars=span_bars,
        end_index=end_index, break_index=break_index, levels=levels,
        invalidation=invalidation, summary=summary,
    )


def _matches_convergence(kind, upper_drift, lower_drift, width_start):
    """A triangle has one flat side and one closing side; a wedge has both sides moving."""
    if kind == "ascending":
        return (abs(upper_drift) <= FLAT_SIDE_DRIFT * width_start
                and lower_drift >= CONVERGING_SIDE_DRIFT * width_start)
    if kind == "descending":
        return (abs(lower_drift) <= FLAT_SIDE_DRIFT * width_start
                and upper_drift <= -CONVERGING_SIDE_DRIFT * width_start)
    if kind == "symmetrical":
        return (upper_drift <= -WEDGE_SIDE_DRIFT * width_start
                and lower_drift >= WEDGE_SIDE_DRIFT * width_start)
    if kind == "rising":
        return (upper_drift >= WEDGE_SIDE_DRIFT * width_start
                and lower_drift >= WEDGE_SIDE_DRIFT * width_start
                and upper_drift < lower_drift)
    if kind == "falling":
        return (upper_drift <= -WEDGE_SIDE_DRIFT * width_start
                and lower_drift <= -WEDGE_SIDE_DRIFT * width_start
                and upper_drift < lower_drift)
    return False


def _find_convergence(bars, swings, kind):
    """Triangles and wedges: two trendlines that meet inside the visible range."""
    count = len(bars)
    last = count - 1
    price_range = _price_range(bars)
    span = price_range["span"]
    key = f"{kind}_triangle" if kind in {"ascending", "descending", "symmetrical"} else f"{kind}_wedge"
    best = None
    for from_index in range(max(2, count - 150), last - CONVERGENCE_MIN_BARS + 1):
        highs = [pivot for pivot in swings if pivot["kind"] == "peak" and from_index <= pivot["index"] <= last]
        lows = [pivot for pivot in swings if pivot["kind"] == "trough" and from_index <= pivot["index"] <= last]
        if len(highs) < 2 or len(lows) < 2:
            continue
        upper = _trend_fit([{"index": p["index"], "price": p["price"]} for p in highs])
        lower = _trend_fit([{"index": p["index"], "price": p["price"]} for p in lows])
        if upper is None or lower is None:
            continue
        # The shape starts at its first touch; measuring the lines further back, where nothing
        # touches them, would only make the opening look wider than price ever traded.
        first_pivot = min(pivot["index"] for pivot in highs + lows)
        width_start = upper.at(first_pivot) - lower.at(first_pivot)
        width_end = upper.at(last) - lower.at(last)
        if width_start < 0.03 * span or width_end < 0.02 * span:
            continue
        if width_end > 0.8 * width_start:
            continue
        # A flat regression line through three highs is not a resistance line when one of them is
        # a spike far above it, so every touch has to be near the line it is supposed to define.
        fit_tolerance = min(0.12 * span, 0.35 * width_start)
        if not _line_fits(highs, upper, fit_tolerance) or not _line_fits(lows, lower, fit_tolerance):
            continue
        upper_drift = upper.at(last) - upper.at(first_pivot)
        lower_drift = lower.at(last) - lower.at(first_pivot)
        if not _matches_convergence(kind, upper_drift, lower_drift, width_start):
            continue
        score = (1 - width_end / width_start) * 0.7 + ((last - first_pivot) / 150) * 0.3
        if best is not None and score <= best["score"]:
            continue
        # The channel edges are already drawn, so the break level needs no line of its own; a
        # small overshoot past the edge is noise rather than the breakout that resolves the shape.
        slack = 0.05 * span
        last_swing = max([pivot["index"] for pivot in highs] + [pivot["index"] for pivot in lows])
        # A breakout only counts after the final swing, otherwise a close through the channel on
        # the way to the last pivot is mistaken for the resolution that comes after it.
        broke_up = False
        broke_down = False
        break_index = None
        for index in range(last_swing + 1, last + 1):
            close = bars[index]["close"]
            if close > upper.at(index) + slack:
                broke_up = True
                if break_index is None:
                    break_index = index
            if close < lower.at(index) - slack:
                broke_down = True
                if break_index is None:
                    break_index = index
        # The measured move is the opening width, added from the edge where price leaves the
        # shape: the break bar once it has, the latest bar while still inside.
        anchor = last if break_index is None else break_index
        up_target = upper.at(anchor) + width_start
        down_target = lower.at(anchor) - width_start
        # Ascending triangles and falling wedges resolve upward, the other two downward.
        upside = kind in {"ascending", "falling"}
        resolution = None
        if kind == "symmetrical":
            # A two-sided shape resolves whichever way price leaves the channel; a whipsaw
            # through both sides is noise rather than a usable measured move.
            if broke_up and broke_down:
                continue
            if broke_up:
                resolution = "up"
            elif broke_down:
                resolution = "down"
        else:
            # A close through the side the shape does not resolve towards is a failure.
            if broke_down if upside else broke_up:
                continue
            if broke_up if upside else broke_down:
                resolution = "up" if upside else "down"
        forming = resolution is None
        above = resolution == "up" or (resolution is None and upside)
        line = upper if above else lower
        # Once the break has happened there is nothing left to wait for at a future bar.
        price = line.at(break_index) if resolution else line.at(last)
        target = up_target if above else down_target
        if kind == "symmetrical":
            # Until price leaves the channel the shape has not picked a direction.
            bias = ("bullish" if resolution == "up" else "bearish") if resolution else "neutral"
        else:
            bias = PATTERN_BIAS[key]
        if kind == "symmetrical" and forming:
            # A symmetrical shape that has not picked a side is entered on either edge, and
            # neither edge invalidates a direction the shape has not taken.
            levels = [
                _level("up", upper.at(last), upper.slope, up_target, "bullish", "resistance",
                       slack=slack),
                _level("down", lower.at(last), lower.slope, down_target, "bearish", "support",
                       slack=slack),
            ]
            invalidation = None
        else:
            levels = [_level("up" if above else "down", price, line.slope, target, bias,
                              "resistance" if above else "support", slack=slack)]
            if bias == "bullish":
                invalidation = {"side": "below", "price": lower.at(last), "slope": lower.slope,
                                "slack": slack}
            else:
                invalidation = {"side": "above", "price": upper.at(last), "slope": upper.slope,
                                "slack": slack}
        width_percent = int((1 - width_end / width_start) * 100 + 0.5)
        # A symmetrical shape projects both measured moves; the others have one side.
        targets = [up_target, down_target] if kind == "symmetrical" else [target]
        summary = f"{PATTERN_LABELS[key]} over {last - first_pivot} bars closing {width_percent}%"
        if forming:
            if kind == "symmetrical":
                summary += (" · break outside "
                            f"{_price_text(lower.at(last))}-{_price_text(upper.at(last))}")
            else:
                summary += f" · break {'above' if above else 'below'} {_price_text(price)}"
        else:
            edge_line = upper if resolution == "up" else lower
            summary += (f" · broke {'above' if resolution == 'up' else 'below'} "
                        f"{_price_text(edge_line.at(break_index))}")
        summary += " · target " + " / ".join(_price_text(item) for item in targets)
        match = _match(
            key, bars, forming=forming,
            stage="awaiting_break" if forming else "broke",
            span_bars=last - first_pivot, end_index=last_swing,
            break_index=break_index, levels=levels, invalidation=invalidation,
            summary=summary, bias=bias,
        )
        match["width_percent"] = width_percent
        best = {"score": score, "result": match}
    return best["result"] if best else None


def _build_match(key, bars, swings):
    if key == "head_and_shoulders":
        group = _find_three_swing(bars, swings, "peak")
        return None if group is None else _describe_three_swing(key, bars, group)
    if key == "inverse_head_and_shoulders":
        group = _find_three_swing(bars, swings, "trough")
        return None if group is None else _describe_three_swing(key, bars, group)
    if key == "double_top":
        group = _find_double_swing(bars, swings, "peak")
        return None if group is None else _describe_double_swing(key, bars, group)
    if key == "double_bottom":
        group = _find_double_swing(bars, swings, "trough")
        return None if group is None else _describe_double_swing(key, bars, group)
    if key == "ascending_triangle":
        return _find_convergence(bars, swings, "ascending")
    if key == "descending_triangle":
        return _find_convergence(bars, swings, "descending")
    if key == "symmetrical_triangle":
        return _find_convergence(bars, swings, "symmetrical")
    if key == "rising_wedge":
        return _find_convergence(bars, swings, "rising")
    if key == "falling_wedge":
        return _find_convergence(bars, swings, "falling")
    return None


def detect_patterns(keys, bars):
    """Look for the requested patterns in the given closed bars, in the order they were asked.

    One swing scan is shared by the whole batch, so asking for every pattern costs little more
    than asking for one. Fewer than thirty candles cannot hold a shape.
    """
    if len(bars) < MIN_BARS:
        return []
    swings = _swing_pivots(bars, SWING_SPAN)
    # Two swings are enough for a forming double top: the first extreme and the reaction that is
    # still waiting for the second one.
    if len(swings) < 2:
        return []
    found = []
    for key in keys:
        if key not in PATTERN_LABELS:
            continue
        match = _build_match(key, bars, swings)
        if match is not None:
            found.append(match)
    return found


def _pattern_span(match):
    """How wide a reading is, so a shape made of two swings cannot beat a whole channel."""
    return match.get("span_bars", 0)


def best_pattern(matches):
    """Confirmed shapes beat partial ones, and among equals the widest structure wins."""
    return min(
        matches,
        key=lambda match: (bool(match["forming"]), -_pattern_span(match)),
        default=None,
    )


def _bar_step(bars):
    return bars[1]["time"] - bars[0]["time"] if len(bars) > 1 else 60


def first_close_past(bars, *, anchor_time, price, slope, side, max_drift_bars=FORMING_WINDOW,
                     slack=0.0):
    """The first closed bar after ``anchor_time`` that trades beyond a pinned level.

    The level is re-priced for each newer candle from the ``slope`` it was quoted with, so a
    sloped neckline is not tested at the price it had on the poll that found it. Bars further
    out than ``max_drift_bars`` are ignored: the job polls every minute, so a break that far
    behind was missed while the service was down and is stale news. ``slack`` is the same
    noise band the detector applies — a close must clear the line by that much to count.
    """
    step = _bar_step(bars)
    horizon = anchor_time + max_drift_bars * step
    for bar in bars:
        if bar["time"] <= anchor_time or bar["time"] > horizon:
            continue
        level = price + slope * ((bar["time"] - anchor_time) / step)
        if side == "up" and bar["close"] > level + slack:
            return bar
        if side == "down" and bar["close"] < level - slack:
            return bar
    return None


def _formation_signature(symbol, timeframe, match):
    """Identifies one reading of one shape, so the same formation is never reported twice."""
    return f"{symbol}|{timeframe}|{match['key']}|{match['bias']}|{match['end_time']}"


def _traded_level(match):
    """The one level an alert can follow, or ``None`` when the shape has not picked a side.

    A symmetrical triangle that has not broken out is entered on either edge, so no single
    close confirms it and a forming alert would be guessing. Those shapes are reported when
    they resolve instead, from the side price actually left the channel through.
    """
    if match["forming"] and len(match["levels"]) > 1:
        return None
    wanted = "down" if match["bias"] == "bearish" else "up"
    for level in match["levels"]:
        if level["side"] == wanted:
            return level
    return None


def _pinned(level, anchor_time):
    return {"side": level["side"], "price": level["price"], "slope": level["slope"],
            "slack": level.get("slack") or 0.0, "anchor_time": anchor_time}


def _pinned_invalidation(invalidation, anchor_time):
    """The cancel level in the same vocabulary as the entry, so one crossing test serves both."""
    if not invalidation:
        return {}
    return _pinned({
        "side": "up" if invalidation["side"] == "above" else "down",
        "price": invalidation["price"],
        "slope": invalidation.get("slope") or 0.0,
        "slack": invalidation.get("slack") or 0.0,
    }, anchor_time)


def _idle_state():
    return {"state": "idle", "key": "", "bias": "", "signature": "", "entry": {},
            "target": None, "invalidation": {}, "end_time": None}


def _pin(state, match, *, symbol, timeframe, last_time):
    """Records the numbers a forming alert has to repeat on its entry event."""
    level = _traded_level(match)
    state.update({
        "key": match["key"],
        "bias": match["bias"],
        "signature": _formation_signature(symbol, timeframe, match),
        "end_time": match["end_time"],
        "entry": {**_pinned(level, last_time),
                  # The neckline only confirms a shape whose last swing has printed.
                  "needs_swing": match.get("stage") == "missing_swing",
                  # The measured move, so the breakout can apply it from wherever a sloped
                  # line has drifted to by the time price actually breaks it.
                  "height": abs(level["target"] - level["price"])},
        "target": level["target"],
        "invalidation": _pinned_invalidation(match["invalidation"], last_time),
    })


def _swing_completed(bars, key):
    """Whether the shape pinned while a swing was missing now reads with that swing printed."""
    if not key:
        return False
    return any(match["stage"] != "missing_swing" for match in detect_patterns([key], bars))


def pattern_evaluate(bars, match, state, *, symbol, timeframe, first_poll=False):
    """One step of the forming alert's ``idle -> forming -> idle`` cycle.

    Returns ``(signals, state)`` and never produces more than one event per call, because the
    caller only advances on a newly closed bar. A forming match pins its entry, target and
    invalidation; the entry event applies the pinned measured move from the break, and a shape
    that breaks against its invalidation or ages out of the forming window is dropped silently.

    A match that arrives already confirmed arms without alerting on the first poll: the break
    happened before anyone was watching, so reporting it would be a stale trade. A later poll
    treats it as live only when the newest closed bar is the one that broke the level.
    """
    state = {**_idle_state(), **(state or {})}
    last_time = bars[-1]["time"]
    step = _bar_step(bars)

    if state["state"] == "forming":
        entry = state.get("entry") or {}
        if not entry:
            return [], {**state, "state": "idle"}
        broke = first_close_past(
            bars, anchor_time=entry["anchor_time"], price=entry["price"],
            slope=entry["slope"], side=entry["side"], slack=entry.get("slack") or 0.0,
        )
        if broke is not None and entry.get("needs_swing") and not _swing_completed(bars, state["key"]):
            # The neckline gave way before the second top or right shoulder printed: the
            # shape failed rather than broke out, so it is dropped without an alert.
            return [], {**state, "state": "idle", "entry": {}, "invalidation": {}, "target": None}
        if broke is not None:
            level = entry["price"] + entry["slope"] * ((broke["time"] - entry["anchor_time"]) / step)
            # The measured move runs from the break. On a flat line that is the number the
            # warning already quoted; on a sloped one the line has moved since, and a target
            # pinned at the warning could even end up behind the breakout.
            target = state.get("target")
            if entry.get("height") is not None:
                target = level + entry["height"] if entry["side"] == "up" else level - entry["height"]
            return (
                [{"event": "breakout", "bar_time": broke["time"], "close": broke["close"],
                  "level": level}],
                {**state, "state": "idle", "entry": {}, "invalidation": {}, "target": target},
            )
        invalidation = state.get("invalidation") or {}
        if invalidation and first_close_past(
            bars, anchor_time=invalidation["anchor_time"], price=invalidation["price"],
            slope=invalidation["slope"], side=invalidation["side"],
            slack=invalidation.get("slack") or 0.0,
        ) is not None:
            return [], {**state, "state": "idle", "entry": {}, "invalidation": {}, "target": None}
        if last_time - entry["anchor_time"] > FORMING_WINDOW * step:
            return [], {**state, "state": "idle", "entry": {}, "invalidation": {}, "target": None}
        return [], state

    if match is None or not _traded_level(match):
        return [], state

    signature = _formation_signature(symbol, timeframe, match)
    if signature == state.get("signature"):
        return [], state
    if match["forming"] and match.get("stage") == "missing_swing":
        # A second top or right shoulder that has not printed is a guess, and on live candles
        # about half of those guesses never complete. The warning waits until the shape is fully
        # drawn and only the neckline break is missing; the chart still shows the projection.
        # Nothing is remembered, so the completed shape (a new signature) can still warn.
        return [], state
    if match["forming"]:
        _pin(state, match, symbol=symbol, timeframe=timeframe, last_time=last_time)
        return (
            [{"event": "forming", "bar_time": last_time, "close": bars[-1]["close"]}],
            {**state, "state": "forming"},
        )
    if not first_poll and match["break_time"] == last_time:
        level = _traded_level(match)
        return (
            [{"event": "breakout", "bar_time": last_time, "close": bars[-1]["close"], "level": level["price"]}],
            {**state, "signature": signature, "key": match["key"], "bias": match["bias"],
             "end_time": match["end_time"], "target": level["target"]},
        )
    # Nothing to report, but the shape is remembered so its own forming phase cannot fire later.
    return [], {**state, "signature": signature, "key": "", "bias": "", "end_time": None}
