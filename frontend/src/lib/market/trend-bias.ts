import type { Bar, Timeframe } from "@/types/market";
import { closedBars } from "./candles";
import { intervalSeconds } from "./constants";

/** The higher timeframes the trend-bias reading is built from. */
export const TREND_BIAS_TIMEFRAMES = ["1h", "4h", "1d"] as const;
export type TrendBiasTimeframe = (typeof TREND_BIAS_TIMEFRAMES)[number];

export type TrendBiasDirection = "bullish" | "bearish" | "neutral";

/**
 * One regression line through either the swing highs or the swing lows.
 *
 * The line is stored as a segment plus its slope so the overlay can project it onto whichever
 * interval the chart is showing, and so it can run past the newest candle without refetching.
 */
export type TrendBiasLine = {
  kind: "high" | "low";
  /** First point of the drawn segment, in unix seconds. */
  t1: number;
  p1: number;
  /** End point, one day after the newest candle, in unix seconds. */
  t2: number;
  p2: number;
  /** Price change per second, used to read a price at any time along the line. */
  slope: number;
  /** Slope as a percentage of the line's starting price per bar, for the conditions readout. */
  slopePctPerBar: number;
  /** Number of fractal pivots that went into the fit. */
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
};

/** Swing half-width; a pivot has to be beyond every bar in the span either side. */
const SWING_SPAN = 3;
/** Enough history for a long-term channel without making one toggle unreasonably heavy. */
const MAX_BARS = 320;
/** Recent swings describe the current trend; older pivots would flatten the fit. */
const MAX_PIVOTS = 12;
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
    if (pivot) pivots.push({ time: Number(bars[index].time), price });
  }
  return pivots;
}

type Regression = {
  /** Price change per second. */
  slope: number;
  /** First pivot's timestamp, which keeps the x values small enough to stay precise. */
  origin: number;
  /** Fitted price at the origin. */
  intercept: number;
  count: number;
};

/** Ordinary least squares through the pivots, with time in seconds as x. */
function regress(pivots: Pivot[]): Regression | null {
  if (pivots.length < 2) return null;
  const origin = pivots[0].time;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const pivot of pivots) {
    const x = pivot.time - origin;
    sumX += x;
    sumY += pivot.price;
    sumXX += x * x;
    sumXY += x * pivot.price;
  }
  const count = pivots.length;
  const denominator = count * sumXX - sumX * sumX;
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  const slope = (count * sumXY - sumX * sumY) / denominator;
  if (!Number.isFinite(slope)) return null;
  return { slope, origin, intercept: (sumY - slope * sumX) / count, count };
}

function buildLine(
  kind: "high" | "low",
  pivots: Pivot[],
  endTime: number,
  barSeconds: number,
): TrendBiasLine | null {
  const fit = regress(pivots);
  if (!fit) return null;
  const t1 = pivots[0].time;
  const p1 = fit.intercept + fit.slope * (t1 - fit.origin);
  const p2 = fit.intercept + fit.slope * (endTime - fit.origin);
  if (!Number.isFinite(p1) || !Number.isFinite(p2)) return null;
  const slopePctPerBar = p1 ? (fit.slope * barSeconds * 100) / Math.abs(p1) : 0;
  return {
    kind, t1, p1, t2: endTime, p2, slope: fit.slope, slopePctPerBar, pivots: fit.count,
  };
}

/**
 * Fits the trend bias for one higher timeframe.
 *
 * Swing highs give the upper line and swing lows the lower line. The fit runs through the recent
 * pivots rather than joining the two most extreme ones, so a single spike cannot tilt the channel,
 * and both lines are carried one day past the latest candle.
 */
export function findTrendBias(
  input: Bar[],
  timeframe: TrendBiasTimeframe,
  nowSeconds = Date.now() / 1000,
): TrendBias | null {
  // A higher-timeframe reading is taken from completed candles only: the live 1H/4H/1D bar is
  // still moving and would flip the classification back and forth inside the bar.
  const bars = closedBars(input, timeframe as Timeframe, nowSeconds).slice(-MAX_BARS);
  if (bars.length < SWING_SPAN * 2 + 2) return null;

  const last = bars[bars.length - 1];
  const endTime = Number(last.time) + TREND_BIAS_EXTEND_SECONDS;
  const barSeconds = intervalSeconds[timeframe as Timeframe];
  const highs = findPivots(bars, "high").slice(-MAX_PIVOTS);
  const lows = findPivots(bars, "low").slice(-MAX_PIVOTS);
  const upper = highs.length >= 2 ? buildLine("high", highs, endTime, barSeconds) : null;
  const lower = lows.length >= 2 ? buildLine("low", lows, endTime, barSeconds) : null;
  const lines = [upper, lower].filter((line): line is TrendBiasLine => line !== null);
  if (!lines.length) return null;

  const rising = lines.every((line) => line.slope > 0);
  const falling = lines.every((line) => line.slope < 0);
  return {
    timeframe,
    direction: rising ? "bullish" : falling ? "bearish" : "neutral",
    lines,
  };
}
