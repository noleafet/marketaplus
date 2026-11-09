"""Swing-detection touch rules for the Trend Bias alert.

The alert watches the same current diagonal segments the chart projects: the
upper line through swing highs and the lower line through swing lows on each of
the 1H, 4H and 1D readings. A candle touches when its wick range contains the
line's price at the candle timestamp. Prior segments are historical context and
never alert.
"""


SWING_BIAS_TIMEFRAMES = ("1h", "4h", "1d")
SWING_BIAS_BARS = 320
SWING_DETECTION_BARS = 1000

_KIND_LABELS = {"high": "upper", "low": "lower"}


def line_price(line, timestamp):
    """Price on a trend-bias line at an epoch-second timestamp."""
    return line["p1"] + line["slope"] * (timestamp - line["t1"])


def touches_for_bar(bar, biases):
    """Every current trend-bias line touched by one closed candle.

    ``biases`` maps timeframe to a ``find_trend_bias`` result. The candle's open
    timestamp is the chart's x position for the bar, so the diagonal is read at
    that instant and compared with the bar's high/low wick extremes.
    """
    touches = []
    bar_time = bar["time"]
    for timeframe in SWING_BIAS_TIMEFRAMES:
        bias = biases.get(timeframe)
        if not bias:
            continue
        for line in bias.get("lines", []):
            if line.get("segment") != "current" or bar_time < line["t1"]:
                continue
            level = line_price(line, bar_time)
            if bar["low"] <= level <= bar["high"]:
                touches.append({
                    "bias_timeframe": timeframe,
                    "direction": bias.get("direction", "neutral"),
                    "kind": line["kind"],
                    "kind_label": _KIND_LABELS.get(line["kind"], line["kind"]),
                    "level": level,
                    "slope_pct_per_bar": line.get("slope_pct_per_bar"),
                    "pivots": line.get("pivots"),
                    "bar_time": bar_time,
                })
    return touches
