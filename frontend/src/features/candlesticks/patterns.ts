/**
 * Candlestick-monitor recognition.
 *
 * The monitor only looks at the most recent bars, so the detectors are intentionally simple and
 * require the shape to end on a bar near the right edge of that window. The rules mirror the
 * reference card: a reversal is only reported when the candles before it lean the other way.
 */

export type CandlestickBias = "bullish" | "bearish";

export type CandlestickPatternKey =
  | "morning_star"
  | "evening_star"
  | "three_black_crows"
  | "three_bar_reversal"
  | "three_outside_up"
  | "three_outside_down"
  | "piercing_line"
  | "dark_cloud_cover"
  | "hammer"
  | "shooting_star"
  | "bearish_engulfing"
  | "bullish_engulfing";

/** Minimal OHLC shape, so both raw bars and Heikin Ashi bars can be passed in. */
export type CandleBar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type CandlestickPattern = {
  key: CandlestickPatternKey;
  label: string;
  /** "both" is used by shapes that reverse in either direction, such as the three-bar reversal. */
  bias: CandlestickBias | "both";
  /** Historical success / reversal rate, as published on the reference card. */
  success: number;
  frequency: string;
  notes: string;
};

/** The default set the monitor watches for, in the order the guide shows them. */
export const CANDLESTICK_PATTERNS: CandlestickPattern[] = [
  {
    key: "morning_star",
    label: "Morning Star",
    bias: "bullish",
    success: 78,
    frequency: "Low",
    notes:
      "A long bearish candle, a small-bodied star below it, then a bullish candle closing back into the first candle's body. Reversal after a decline.",
  },
  {
    key: "evening_star",
    label: "Evening Star",
    bias: "bearish",
    success: 72,
    frequency: "Low",
    notes:
      "A long bullish candle, a small-bodied star above it, then a bearish candle closing back into the first candle's body. Reversal after a rise.",
  },
  {
    key: "three_black_crows",
    label: "Three Black Crows",
    bias: "bearish",
    success: 78,
    frequency: "Low–Medium",
    notes:
      "Three consecutive bearish candles, each opening inside the previous body and closing lower. A steady bearish reversal.",
  },
  {
    key: "three_bar_reversal",
    label: "Three-Bar Reversal",
    bias: "both",
    success: 60,
    frequency: "Low–Moderate",
    notes:
      "The first candle follows the existing trend, the second shows a potential shift, and the third confirms movement in the opposite direction. Works in either direction; the sample shows a bullish reversal. Less common than the standard reversal shapes.",
  },
  {
    key: "three_outside_up",
    label: "Three Outside Up",
    bias: "bullish",
    success: 75,
    frequency: "Moderate",
    notes:
      "A bearish candle, a bullish candle that engulfs its body, then a third bullish candle closing above the engulfing one. The confirmation candle is what makes the reversal readable.",
  },
  {
    key: "three_outside_down",
    label: "Three Outside Down",
    bias: "bearish",
    success: 69,
    frequency: "Moderate",
    notes:
      "A bullish candle, a bearish candle that engulfs its body, then a third bearish candle closing below the engulfing one. The confirmation candle is what makes the reversal readable.",
  },
  {
    key: "piercing_line",
    label: "Piercing Line",
    bias: "bullish",
    success: 64,
    frequency: "Moderate",
    notes:
      "A bearish candle after a decline, then a bullish candle that opens below the first close and closes above the midpoint of its body but below its open. A bullish reversal.",
  },
  {
    key: "dark_cloud_cover",
    label: "Dark Cloud Cover",
    bias: "bearish",
    success: 60,
    frequency: "Moderate",
    notes:
      "A bullish candle after an uptrend, then a bearish candle that opens above the first close and closes below the midpoint of its body but above its open. A bearish reversal.",
  },
  {
    key: "hammer",
    label: "Hammer",
    bias: "bullish",
    success: 60,
    frequency: "Medium",
    notes:
      "A small body near the top of the range with a long lower wick at least twice the body, after a decline. Sellers pushed price down and lost it.",
  },
  {
    key: "shooting_star",
    label: "Shooting Star",
    bias: "bearish",
    success: 59,
    frequency: "Medium–High",
    notes:
      "A small body near the bottom of the range with a long upper wick at least twice the body, after a rise. Buyers pushed price up and lost it.",
  },
  {
    key: "bearish_engulfing",
    label: "Bearish Engulfing",
    bias: "bearish",
    success: 79,
    frequency: "Medium–High",
    notes:
      "A bullish candle followed by a larger bearish candle whose body completely covers the first. Reversal after a rise.",
  },
  {
    key: "bullish_engulfing",
    label: "Bullish Engulfing",
    bias: "bullish",
    success: 63,
    frequency: "Medium–High",
    notes:
      "A bearish candle followed by a larger bullish candle whose body completely covers the first. Reversal after a decline.",
  },
];

const byKey = new Map(CANDLESTICK_PATTERNS.map((pattern) => [pattern.key, pattern]));
/** How many candles are analysed for context and the average body. */
export const CANDLESTICK_LOOKBACK = 25;
/**
 * Only shapes that finish in this many newest bars are reported. The rest of the 25-bar window
 * still supplies trend and body-size context, but an old shape must not pull the monitor back.
 */
export const CANDLESTICK_RECENT_BARS = 5;

export type CandlestickMatch = {
  key: CandlestickPatternKey;
  label: string;
  bias: CandlestickBias;
  success: number;
  frequency: string;
  summary: string;
  startIndex: number;
  endIndex: number;
  startTime: number;
  endTime: number;
  /** Bar count of the shape itself, so the overlay can size its caption. */
  candles: number;
  high: number;
  low: number;
  /** Close of the confirming candle: the price the formation completed at. */
  formationPrice: number;
};

const bullish = (bar: CandleBar) => bar.close > bar.open;
const bearish = (bar: CandleBar) => bar.close < bar.open;
const body = (bar: CandleBar) => Math.abs(bar.close - bar.open);
const span = (bar: CandleBar) => Math.max(bar.high - bar.low, Number.EPSILON);
const bodyTop = (bar: CandleBar) => Math.max(bar.open, bar.close);
const bodyBottom = (bar: CandleBar) => Math.min(bar.open, bar.close);
const midpoint = (bar: CandleBar) => (bar.open + bar.close) / 2;
const upperWick = (bar: CandleBar) => bar.high - bodyTop(bar);
const lowerWick = (bar: CandleBar) => bodyBottom(bar) - bar.low;

/** Average body of the monitored window, used to tell a real candle from a doji. */
function averageBody(bars: readonly CandleBar[], from: number) {
  let total = 0;
  let count = 0;
  for (let index = from; index < bars.length; index += 1) {
    const value = body(bars[index]);
    if (value > 0) {
      total += value;
      count += 1;
    }
  }
  return count ? total / count : 0;
}

/**
 * Was price falling before the shape started? A handful of bars is enough to set the context,
 * and when the shape sits at the very start of the data the candles themselves have to carry it.
 */
function fallingInto(bars: readonly CandleBar[], start: number) {
  if (start < 3) return true;
  return bars[Math.max(0, start - 4)].close > bars[start - 1].close;
}

function risingInto(bars: readonly CandleBar[], start: number) {
  if (start < 3) return true;
  return bars[Math.max(0, start - 4)].close < bars[start - 1].close;
}

function morningStar(bars: readonly CandleBar[], end: number, average: number) {
  const first = bars[end - 2];
  const star = bars[end - 1];
  const last = bars[end];
  const firstBody = body(first);
  const lastBody = body(last);
  if (!fallingInto(bars, end - 2) || !bearish(first) || !bullish(last)) return false;
  if (firstBody < average * 0.55 || lastBody < average * 0.45) return false;
  if (body(star) > firstBody * 0.45) return false;
  // The star has to sit below the first close; a tiny overlap is normal on 24/7 markets.
  if (bodyTop(star) > first.close + firstBody * 0.2) return false;
  return last.close >= midpoint(first);
}

function eveningStar(bars: readonly CandleBar[], end: number, average: number) {
  const first = bars[end - 2];
  const star = bars[end - 1];
  const last = bars[end];
  const firstBody = body(first);
  const lastBody = body(last);
  if (!risingInto(bars, end - 2) || !bullish(first) || !bearish(last)) return false;
  if (firstBody < average * 0.55 || lastBody < average * 0.45) return false;
  if (body(star) > firstBody * 0.45) return false;
  if (bodyBottom(star) < first.close - firstBody * 0.2) return false;
  return last.close <= midpoint(first);
}

function threeBlackCrows(bars: readonly CandleBar[], end: number, average: number) {
  const [first, second, third] = [bars[end - 2], bars[end - 1], bars[end]];
  // Three bearish candles are only a reversal when they interrupt a rise; in a decline they are
  // simply continuation and the pattern's bearish reversal label would be misleading.
  if (!risingInto(bars, end - 2) || ![first, second, third].every(bearish)) return false;
  if (!(first.close > second.close && second.close > third.close)) return false;
  // Each candle opens inside the previous body, which is what makes the stair-step readable.
  if (!(second.open <= first.open && second.open >= first.close)) return false;
  if (!(third.open <= second.open && third.open >= second.close)) return false;
  return [first, second, third].every((bar) => body(bar) >= average * 0.35);
}

function threeOutsideUp(bars: readonly CandleBar[], end: number, average: number) {
  const [first, second, third] = [bars[end - 2], bars[end - 1], bars[end]];
  if (!fallingInto(bars, end - 2) || !bearish(first) || !bullish(second) || !bullish(third)) return false;
  if (body(second) <= body(first) || body(second) < average * 0.4) return false;
  if (!(second.open <= first.close && second.close >= first.open)) return false;
  return third.close > second.close;
}

function threeOutsideDown(bars: readonly CandleBar[], end: number, average: number) {
  const [first, second, third] = [bars[end - 2], bars[end - 1], bars[end]];
  if (!risingInto(bars, end - 2) || !bullish(first) || !bearish(second) || !bearish(third)) return false;
  if (body(second) <= body(first) || body(second) < average * 0.4) return false;
  if (!(second.open >= first.close && second.close <= first.open)) return false;
  return third.close < second.close;
}

function piercingLine(bars: readonly CandleBar[], end: number, average: number) {
  const first = bars[end - 1];
  const second = bars[end];
  const firstBody = body(first);
  if (!fallingInto(bars, end - 1) || !bearish(first) || !bullish(second)) return false;
  if (firstBody < average * 0.35 || body(second) < average * 0.35) return false;
  // The second candle has to open at or below the first close, then pierce the midpoint
  // without swallowing the whole first body (that would be a bullish engulfing).
  if (second.open > first.close) return false;
  return second.close > midpoint(first) && second.close < first.open;
}

function darkCloudCover(bars: readonly CandleBar[], end: number, average: number) {
  const first = bars[end - 1];
  const second = bars[end];
  const firstBody = body(first);
  if (!risingInto(bars, end - 1) || !bullish(first) || !bearish(second)) return false;
  if (firstBody < average * 0.35 || body(second) < average * 0.35) return false;
  // Mirror of the piercing line: open at or above the first close, close below its midpoint,
  // but stay above the first open so it is not a bearish engulfing.
  if (second.open < first.close) return false;
  return second.close < midpoint(first) && second.close > first.open;
}

function threeBarReversalBullish(bars: readonly CandleBar[], end: number, average: number) {
  const [first, second, third] = [bars[end - 2], bars[end - 1], bars[end]];
  const firstBody = body(first);
  if (!fallingInto(bars, end - 2) || !bearish(first) || !bullish(third)) return false;
  if (firstBody < average * 0.3 || body(third) < average * 0.3) return false;
  // The middle candle is the hesitation: it has to be smaller than a normal body and
  // smaller than the trend candle it is trying to reverse.
  if (body(second) > Math.max(average * 0.45, firstBody * 0.6)) return false;
  return third.close > first.close && third.close > second.close && third.close > midpoint(first);
}

function threeBarReversalBearish(bars: readonly CandleBar[], end: number, average: number) {
  const [first, second, third] = [bars[end - 2], bars[end - 1], bars[end]];
  const firstBody = body(first);
  if (!risingInto(bars, end - 2) || !bullish(first) || !bearish(third)) return false;
  if (firstBody < average * 0.3 || body(third) < average * 0.3) return false;
  if (body(second) > Math.max(average * 0.45, firstBody * 0.6)) return false;
  return third.close < first.close && third.close < second.close && third.close < midpoint(first);
}

function hammer(bars: readonly CandleBar[], end: number) {
  const bar = bars[end];
  const range = span(bar);
  const size = body(bar);
  if (!fallingInto(bars, end) || bar.close < bar.open) return false;
  // The real body has to stay small and sit in the upper part of the range.
  if (size > range * 0.45) return false;
  if (lowerWick(bar) < Math.max(size * 2, range * 0.45)) return false;
  if (upperWick(bar) > Math.max(size * 0.6, range * 0.12)) return false;
  return bodyBottom(bar) >= bar.low + range * 0.55;
}

function shootingStar(bars: readonly CandleBar[], end: number) {
  const bar = bars[end];
  const range = span(bar);
  const size = body(bar);
  if (!risingInto(bars, end) || bar.close > bar.open) return false;
  // Mirror of the hammer: a small body low in the range with a long upper wick.
  if (size > range * 0.45) return false;
  if (upperWick(bar) < Math.max(size * 2, range * 0.45)) return false;
  if (lowerWick(bar) > Math.max(size * 0.6, range * 0.12)) return false;
  return bodyTop(bar) <= bar.high - range * 0.55;
}

function bearishEngulfing(bars: readonly CandleBar[], end: number) {
  if (end < 2) return false;
  const first = bars[end - 1];
  const second = bars[end];
  if (!risingInto(bars, end - 1) || !bullish(first) || !bearish(second)) return false;
  if (!(second.open >= first.close && second.close <= first.open)) return false;
  return body(second) > body(first);
}

function bullishEngulfing(bars: readonly CandleBar[], end: number) {
  if (end < 2) return false;
  const first = bars[end - 1];
  const second = bars[end];
  if (!fallingInto(bars, end - 1) || !bearish(first) || !bullish(second)) return false;
  if (!(second.open <= first.close && second.close >= first.open)) return false;
  return body(second) > body(first);
}

type Detector = {
  key: CandlestickPatternKey;
  candles: number;
  test: (bars: readonly CandleBar[], end: number, average: number) => boolean;
  /** Set when one pattern key can resolve in either direction. */
  bias?: CandlestickBias;
};

/**
 * Order matters only when two shapes finish on the same bar: specific shapes are checked before
 * the broad three-bar rule, and more recent bars always win.
 */
const detectors: Detector[] = [
  { key: "morning_star", candles: 3, test: morningStar },
  { key: "evening_star", candles: 3, test: eveningStar },
  { key: "three_black_crows", candles: 3, test: threeBlackCrows },
  { key: "three_outside_up", candles: 3, test: threeOutsideUp },
  { key: "three_outside_down", candles: 3, test: threeOutsideDown },
  { key: "piercing_line", candles: 2, test: piercingLine },
  { key: "dark_cloud_cover", candles: 2, test: darkCloudCover },
  { key: "hammer", candles: 1, test: (bars, end) => hammer(bars, end) },
  { key: "shooting_star", candles: 1, test: (bars, end) => shootingStar(bars, end) },
  { key: "bearish_engulfing", candles: 2, test: (bars, end) => bearishEngulfing(bars, end) },
  { key: "bullish_engulfing", candles: 2, test: (bars, end) => bullishEngulfing(bars, end) },
  // Broadest reversal rule, so it is checked last and never outranks a more specific shape.
  { key: "three_bar_reversal", candles: 3, test: threeBarReversalBullish, bias: "bullish" },
  { key: "three_bar_reversal", candles: 3, test: threeBarReversalBearish, bias: "bearish" },
];

function buildMatch(bars: readonly CandleBar[], end: number, detector: Detector): CandlestickMatch | null {
  const pattern = byKey.get(detector.key);
  if (!pattern) return null;
  const start = end - detector.candles + 1;
  if (start < 0) return null;
  const shape = bars.slice(start, end + 1);
  const high = Math.max(...shape.map((bar) => bar.high));
  const low = Math.min(...shape.map((bar) => bar.low));
  const bias: CandlestickBias =
    detector.bias ?? (pattern.bias === "both" ? "bullish" : pattern.bias);
  return {
    key: pattern.key,
    label: pattern.label,
    bias,
    success: pattern.success,
    frequency: pattern.frequency,
    summary:
      `${pattern.label} on completed candles · ` +
      `${bias} reversal · reference rate ${pattern.success}% (not a live confidence score) · ` +
      `${pattern.frequency.toLowerCase()} frequency`,
    startIndex: start,
    endIndex: end,
    startTime: Number(bars[start].time),
    endTime: Number(bars[end].time),
    candles: detector.candles,
    high,
    low,
    formationPrice: bars[end].close,
  };
}

/**
 * Finds the newest shape in the monitored window. The 25-bar window supplies context, but only
 * shapes finishing in the latest few candles are reported: a pattern from the far side of the
 * window must not outrank what price is doing right now.
 */
export function detectCandlestickPattern(bars: readonly CandleBar[]): CandlestickMatch | null {
  if (bars.length < 4) return null;
  const from = Math.max(0, bars.length - CANDLESTICK_LOOKBACK);
  const recentFrom = Math.max(from, bars.length - CANDLESTICK_RECENT_BARS);
  const average = averageBody(bars, from);
  // Newest first: the first match found is the latest completed shape in the window.
  for (let end = bars.length - 1; end >= recentFrom; end -= 1) {
    for (const detector of detectors) {
      if (end - detector.candles + 1 < from) continue;
      if (!detector.test(bars, end, average)) continue;
      const match = buildMatch(bars, end, detector);
      if (match) return match;
    }
  }
  return null;
}

export function candlestickLabel(key: string) {
  return byKey.get(key as CandlestickPatternKey)?.label ?? key;
}
