import type { Bar, Timeframe } from "@/types/market";
import { closedBars } from "./candles";
import { intervalSeconds } from "./constants";

/** The higher timeframes the trend-bias reading is built from. */
export const TREND_BIAS_TIMEFRAMES = ["1h", "4h", "1d"] as const;
export type TrendBiasTimeframe = (typeof TREND_BIAS_TIMEFRAMES)[number];

export type TrendBiasDirection = "bullish" | "bearish" | "neutral";

/**
 * One trendline through two swing highs or two swing lows.
 *
 * The line joins its two anchor pivots and is stored with the slope so the overlay can carry it
 * to the right edge of the visible history without refetching.
 */
export type TrendBiasLine = {
  kind: "high" | "low";
  /** First anchor, in unix seconds. */
  t1: number;
  p1: number;
  /** End point, one day after the newest candle, in unix seconds. */
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
  /** Upper (swing-high) line and/or lower (swing-low) line. */
  lines: TrendBiasLine[];
};

type Pivot = {
  time: number;
  price: number;
  /** Bar index, so the fit can require a minimum span and a recent anchor. */
  index: number;
};

type Candidate = {
  left: Pivot;
  right: Pivot;
  slope: number;
  touches: number;
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
/** The line runs one full day past the newest candle. */
export const TREND_BIAS_EXTEND_SECONDS = 86400;

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
 * Whether every bar after the first anchor stays on the correct side of the line. A regression
 * line always sits inside the price action, so the anchors are chosen from pairs that leave no
 * candle body through the line and only negligible wick overshoot.
 */
function restsOnSide(bars: Bar[], left: Pivot, slope: number, kind: "high" | "low") {
  for (const bar of bars) {
    const time = Number(bar.time);
    if (time < left.time) continue;
    const value = left.price + slope * (time - left.time);
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

function countTouches(pivots: Pivot[], left: Pivot, right: Pivot, slope: number) {
  let touches = 0;
  for (const pivot of pivots) {
    if (pivot.index <= left.index || pivot.index >= right.index) continue;
    const value = left.price + slope * (pivot.time - left.time);
    if (Math.abs(pivot.price - value) <= value * TOUCH_TOLERANCE) touches += 1;
  }
  return touches;
}

/**
 * Picks the best pair of same-side pivots: most third touches, then the most recent right
 * anchor, then the widest span. Pairs that cut through price are rejected outright.
 */
function chooseAnchors(
  bars: Bar[],
  pivots: Pivot[],
  kind: "high" | "low",
): Candidate | null {
  const newest = bars.length - 1;
  const activeFrom = newest * ACTIVE_START;
  let best: Candidate | null = null;
  for (let first = 0; first < pivots.length; first += 1) {
    for (let second = first + 1; second < pivots.length; second += 1) {
      const left = pivots[first];
      const right = pivots[second];
      if (right.index - left.index < MIN_SPAN_BARS) continue;
      if (right.index < activeFrom) continue;
      const slope = (right.price - left.price) / (right.time - left.time);
      if (!Number.isFinite(slope)) continue;
      if (!restsOnSide(bars, left, slope, kind)) continue;
      const candidate: Candidate = {
        left, right, slope, touches: countTouches(pivots, left, right, slope),
      };
      if (!best
        || candidate.touches > best.touches
        || (candidate.touches === best.touches && candidate.right.index > best.right.index)
        || (candidate.touches === best.touches && candidate.right.index === best.right.index
          && candidate.right.index - candidate.left.index > best.right.index - best.left.index)) {
        best = candidate;
      }
    }
  }
  return best;
}

function buildLine(
  kind: "high" | "low",
  candidate: Candidate,
  endTime: number,
  barSeconds: number,
): TrendBiasLine {
  const { left, slope, touches } = candidate;
  const p1 = left.price;
  const p2 = p1 + slope * (endTime - left.time);
  const slopePctPerBar = p1 ? (slope * barSeconds * 100) / Math.abs(p1) : 0;
  return {
    kind,
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
 * Swing highs give the upper trendline and swing lows the lower one. Each line is drawn through
 * two recent, clean swing pivots and is only kept when the candles between them and the newest
 * bar stay on the correct side, so it behaves as a ceiling or floor rather than a midline.
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

  const last = bars[bars.length - 1];
  const endTime = Number(last.time) + TREND_BIAS_EXTEND_SECONDS;
  const barSeconds = intervalSeconds[timeframe as Timeframe];
  const upperAnchor = chooseAnchors(bars, findPivots(bars, "high"), "high");
  const lowerAnchor = chooseAnchors(bars, findPivots(bars, "low"), "low");
  const lines: TrendBiasLine[] = [];
  if (upperAnchor) lines.push(buildLine("high", upperAnchor, endTime, barSeconds));
  if (lowerAnchor) lines.push(buildLine("low", lowerAnchor, endTime, barSeconds));
  if (!lines.length) return null;

  return { timeframe, direction: directionOf(lines), lines };
}
