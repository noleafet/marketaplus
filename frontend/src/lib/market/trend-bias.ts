import type { Bar, Timeframe } from "@/types/market";
import { closedBars } from "./candles";
import { intervalSeconds } from "./constants";

/** The higher timeframes the trend-bias reading is built from. */
export const TREND_BIAS_TIMEFRAMES = ["1h", "4h", "1d"] as const;
export type TrendBiasTimeframe = (typeof TREND_BIAS_TIMEFRAMES)[number];

export type TrendBiasDirection = "bullish" | "bearish" | "neutral";

/**
 * One trendline segment through two swing highs or two swing lows.
 *
 * A "current" segment is still respected by the newest closed candle and runs 24 hours past the
 * current time. A "prior" segment is an earlier leg that a close has since broken; it stops on the
 * breaking candle so it never draws through the move that invalidated it.
 */
export type TrendBiasLine = {
  kind: "high" | "low";
  segment: "current" | "prior";
  /** First anchor, in unix seconds. */
  t1: number;
  p1: number;
  /** End point, in unix seconds: 24 hours past the current time, or the breaking candle. */
  t2: number;
  p2: number;
  /** Price change per second, used to read a price at any time along the line. */
  slope: number;
  /** Slope as a percentage of the line's starting price per bar, for the conditions readout. */
  slopePctPerBar: number;
  /** Anchor pivots plus further pivots that touch the line (always at least two). */
  pivots: number;
};

export type TrendBias = {
  timeframe: TrendBiasTimeframe;
  direction: TrendBiasDirection;
  /** At most one current and one prior segment per side, prior segments first for painting. */
  lines: TrendBiasLine[];
};

type Pivot = {
  time: number;
  price: number;
  /** Bar index, so the fit can require a minimum span and a recent anchor. */
  index: number;
};

type Leg = {
  left: Pivot;
  right: Pivot;
  slope: number;
  span: number;
  touches: number;
  /** First closed candle that broke the line, or -1 while it still holds. */
  breakIndex: number;
};

/**
 * Swing half-width. Five bars either side keeps only the swings a trendline is drawn through;
 * a three-bar fractal picks up too many minor wiggles to be a clean anchor.
 */
const SWING_SPAN = 5;
/** Enough history for a long-term trendline without making one toggle unreasonably heavy. */
const MAX_BARS = 320;
/** Two anchors closer than this describe a swing, not a trend. */
const MIN_SPAN_BARS = 12;
/** The right anchor has to sit in the newest fifth of the window, or the line is history. */
const ACTIVE_START = 0.8;
/** Closing/opening price may not pass the line by more than 0.15%: that is a cut, not noise. */
const MAX_BODY_PIERCING = 0.0015;
/** Wicks may overshoot a little more, but a visible slice through them still disqualifies a line. */
const MAX_WICK_PIERCING = 0.01;
/** A third pivot within this distance of the line counts as a touch. */
const TOUCH_TOLERANCE = 0.005;
/** Slopes below this are read as flat rather than bullish or bearish. */
const FLAT_SLOPE_PCT = 0.01;
/** The current segment runs 24 hours past the current time, so every timeframe reaches the future. */
export const TREND_BIAS_EXTEND_SECONDS = 86400;

const priceAt = (left: Pivot, slope: number, time: number) => left.price + slope * (time - left.time);

/** Local swing highs or lows: strictly beyond every bar in the span either side. */
function findPivots(bars: Bar[], kind: "high" | "low"): Pivot[] {
  const pivots: Pivot[] = [];
  for (let index = SWING_SPAN; index < bars.length - SWING_SPAN; index += 1) {
    const price = kind === "high" ? bars[index].high : bars[index].low;
    let pivot = true;
    for (let offset = 1; offset <= SWING_SPAN; offset += 1) {
      const before = bars[index - offset];
      const after = bars[index + offset];
      if (kind === "high"
        ? before.high >= price || after.high >= price
        : before.low <= price || after.low <= price) {
        pivot = false;
        break;
      }
    }
    if (pivot) pivots.push({ time: Number(bars[index].time), price, index });
  }
  return pivots;
}

/**
 * Whether every candle in the range stays on the correct side of the line. A regression line
 * always sits inside the price action, so anchors are only accepted when no candle body pierces
 * the line and wick overshoot stays negligible.
 */
function restsOnSide(
  bars: Bar[],
  left: Pivot,
  slope: number,
  kind: "high" | "low",
  fromIndex = left.index,
  toIndex = bars.length - 1,
) {
  for (let index = fromIndex; index <= toIndex; index += 1) {
    const bar = bars[index];
    const value = priceAt(left, slope, Number(bar.time));
    if (!(value > 0)) return false;
    if (kind === "high") {
      if (bar.high - value > value * MAX_WICK_PIERCING) return false;
      if (Math.max(bar.open, bar.close) - value > value * MAX_BODY_PIERCING) return false;
    } else {
      if (value - bar.low > value * MAX_WICK_PIERCING) return false;
      if (value - Math.min(bar.open, bar.close) > value * MAX_BODY_PIERCING) return false;
    }
  }
  return true;
}

/**
 * First close beyond the line: up through a swing-high ceiling, down through a swing-low floor.
 * A line that runs to zero is not a break of structure, it is off the price scale, so it reports
 * no break and is then dropped by the side check instead of being drawn as a broken leg.
 */
function findBreak(bars: Bar[], left: Pivot, slope: number, kind: "high" | "low", afterIndex: number) {
  for (let index = afterIndex + 1; index < bars.length; index += 1) {
    const bar = bars[index];
    const value = priceAt(left, slope, Number(bar.time));
    if (!(value > 0)) return -1;
    const beyond = kind === "high" ? bar.close - value : value - bar.close;
    if (beyond > value * MAX_BODY_PIERCING) return index;
  }
  return -1;
}

function countTouches(pivots: Pivot[], left: Pivot, right: Pivot, slope: number) {
  let touches = 0;
  for (const pivot of pivots) {
    if (pivot.index <= left.index || pivot.index >= right.index) continue;
    const value = priceAt(left, slope, pivot.time);
    if (Math.abs(pivot.price - value) <= value * TOUCH_TOLERANCE) touches += 1;
  }
  return touches;
}

/** Every same-side pivot pair that spans enough bars and leaves its own stretch untouched. */
function collectLegs(bars: Bar[], pivots: Pivot[], kind: "high" | "low"): Leg[] {
  const legs: Leg[] = [];
  for (let first = 0; first < pivots.length; first += 1) {
    for (let second = first + 1; second < pivots.length; second += 1) {
      const left = pivots[first];
      const right = pivots[second];
      if (right.index - left.index < MIN_SPAN_BARS) continue;
      const slope = (right.price - left.price) / (right.time - left.time);
      if (!Number.isFinite(slope)) continue;
      if (!restsOnSide(bars, left, slope, kind, left.index, right.index)) continue;
      legs.push({
        left,
        right,
        slope,
        span: right.index - left.index,
        touches: countTouches(pivots, left, right, slope),
        breakIndex: findBreak(bars, left, slope, kind, right.index),
      });
    }
  }
  return legs;
}

/**
 * The current leg: still holding at the newest candle, anchored in the newest fifth of the
 * window. The latest right anchor wins, so the segment describes the newest structure; among the
 * lines ending there the longest one contains the shorter sub-legs.
 */
function chooseCurrent(bars: Bar[], legs: Leg[], kind: "high" | "low"): Leg | null {
  const activeFrom = (bars.length - 1) * ACTIVE_START;
  let best: Leg | null = null;
  for (const leg of legs) {
    if (leg.breakIndex !== -1 || leg.right.index < activeFrom) continue;
    if (!restsOnSide(bars, leg.left, leg.slope, kind, leg.right.index, bars.length - 1)) continue;
    if (!best
      || leg.right.index > best.right.index
      || (leg.right.index === best.right.index && leg.touches > best.touches)
      || (leg.right.index === best.right.index && leg.touches === best.touches && leg.span > best.span)) {
      best = leg;
    }
  }
  return best;
}

/**
 * The prior leg: the most recently broken segment that ended before the current leg began. Its
 * break tells the chart where the old trend failed, which is also where its line is cut off.
 */
function choosePrior(
  bars: Bar[],
  legs: Leg[],
  kind: "high" | "low",
  current: Leg | null,
): Leg | null {
  let best: Leg | null = null;
  for (const leg of legs) {
    if (leg.breakIndex === -1) continue;
    if (current && (leg.right.index >= current.left.index || leg.breakIndex > current.left.index)) continue;
    if (!restsOnSide(bars, leg.left, leg.slope, kind, leg.right.index, leg.breakIndex - 1)) continue;
    if (!best
      || leg.breakIndex > best.breakIndex
      || (leg.breakIndex === best.breakIndex && leg.touches > best.touches)
      || (leg.breakIndex === best.breakIndex && leg.touches === best.touches && leg.span > best.span)) {
      best = leg;
    }
  }
  return best;
}

function buildLine(
  kind: "high" | "low",
  leg: Leg,
  segment: "current" | "prior",
  endTime: number,
  barSeconds: number,
): TrendBiasLine {
  const { left, slope, touches } = leg;
  const p1 = left.price;
  const p2 = priceAt(left, slope, endTime);
  const slopePctPerBar = p1 ? (slope * barSeconds * 100) / Math.abs(p1) : 0;
  return {
    kind,
    segment,
    t1: left.time,
    p1,
    t2: endTime,
    p2,
    slope,
    slopePctPerBar,
    pivots: touches + 2,
  };
}

function directionOf(lines: TrendBiasLine[]): TrendBiasDirection {
  if (!lines.length) return "neutral";
  const signs = lines.map((line) => (
    Math.abs(line.slopePctPerBar) < FLAT_SLOPE_PCT ? 0 : Math.sign(line.slopePctPerBar)
  ));
  if (signs.every((sign) => sign > 0)) return "bullish";
  if (signs.every((sign) => sign < 0)) return "bearish";
  return "neutral";
}

/**
 * Reads the trend bias for one higher timeframe.
 *
 * Each side is split into segments: the current leg through the newest major swing, plus the
 * previous leg that price has already broken. Every segment joins two real swing pivots and is
 * rejected if a candle body cuts it, so the lines map the highs and lows instead of a midline.
 * Only the current legs decide the direction; prior legs are context for where the trend turned.
 */
export function findTrendBias(
  input: Bar[],
  timeframe: TrendBiasTimeframe,
  nowSeconds = Date.now() / 1000,
): TrendBias | null {
  // A higher-timeframe reading is taken from completed candles only: the live 1H/4H/1D bar is
  // still moving and would flip the classification back and forth inside the bar.
  const bars = closedBars(input, timeframe as Timeframe, nowSeconds).slice(-MAX_BARS);
  const required = SWING_SPAN * 2 + MIN_SPAN_BARS;
  if (bars.length < required) return null;

  const endTime = nowSeconds + TREND_BIAS_EXTEND_SECONDS;
  const barSeconds = intervalSeconds[timeframe as Timeframe];
  const lines: TrendBiasLine[] = [];
  const currentLines: TrendBiasLine[] = [];
  for (const kind of ["high", "low"] as const) {
    const legs = collectLegs(bars, findPivots(bars, kind), kind);
    const current = chooseCurrent(bars, legs, kind);
    const prior = choosePrior(bars, legs, kind, current);
    if (prior) {
      lines.push(buildLine(kind, prior, "prior", Number(bars[prior.breakIndex].time), barSeconds));
    }
    if (current) {
      const line = buildLine(kind, current, "current", endTime, barSeconds);
      lines.push(line);
      currentLines.push(line);
    }
  }
  if (!lines.length) return null;

  return { timeframe, direction: directionOf(currentLines), lines };
}
