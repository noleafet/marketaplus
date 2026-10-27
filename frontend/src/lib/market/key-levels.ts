import type { Bar } from "@/types/market";
import { atr } from "./indicators";

export type KeyLevelKind = "support" | "resistance";

/**
 * A horizontal support/resistance band with a 0–100 strength score.
 *
 * The score follows the five-factor table used by the chart UI:
 * independent reactions 30, price rejection 25, higher-timeframe confluence 20,
 * volume confirmation 15, recency 10.
 */
export type KeyLevel = {
  kind: KeyLevelKind;
  /** Centre of the band. */
  price: number;
  low: number;
  high: number;
  /** Weighted 0–100 score. */
  strength: number;
  /** Independent swing reactions inside the band. */
  reactions: number;
  /** Normalised 0–1 factor values, kept for a future score breakdown. */
  factors: {
    reactions: number;
    rejection: number;
    confluence: number;
    volume: number;
    recency: number;
  };
};

export type KeyLevels = {
  /** Up to two closest levels scoring 40+ below the current close. */
  supports: KeyLevel[];
  /** Up to two closest levels scoring 40+ above the current close. */
  resistances: KeyLevel[];
};

export const KEY_LEVEL_WEIGHTS = {
  reactions: 30,
  rejection: 25,
  confluence: 20,
  volume: 15,
  recency: 10,
} as const;

/** Levels below this score are noise and are not drawn on the chart. */
export const MIN_DISPLAY_STRENGTH = 40;

type Pivot = {
  index: number;
  price: number;
  kind: "high" | "low";
  bar: Bar;
};

/** Swing half-width on the selected timeframe. */
const SWING_SPAN = 3;
/** Aggregate four selected-timeframe bars to get the higher-timeframe view. */
const HTF_MULTIPLIER = 4;
const HTF_SWING_SPAN = 2;
/** Enough data for about 100 higher-timeframe bars without making every tick expensive. */
const MAX_BARS = 420;
/** A reaction older than this contributes nothing to the recency score. */
const RECENCY_BARS = 180;
const MIN_REACTIONS = 1;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

/** Local swing highs and lows: strictly beyond every bar in the span either side. */
function findPivots(bars: Bar[], span: number): Pivot[] {
  const pivots: Pivot[] = [];
  for (let index = span; index < bars.length - span; index += 1) {
    const bar = bars[index];
    let high = true;
    let low = true;
    for (let offset = 1; offset <= span; offset += 1) {
      if (bars[index - offset].high >= bar.high || bars[index + offset].high >= bar.high) high = false;
      if (bars[index - offset].low <= bar.low || bars[index + offset].low <= bar.low) low = false;
    }
    if (high) pivots.push({ index, price: bar.high, kind: "high", bar });
    if (low) pivots.push({ index, price: bar.low, kind: "low", bar });
  }
  return pivots;
}

/** Four selected-timeframe bars become one higher-timeframe bar. */
function aggregateBars(bars: Bar[], factor: number): Bar[] {
  const result: Bar[] = [];
  for (let index = 0; index < bars.length; index += factor) {
    const group = bars.slice(index, index + factor);
    if (!group.length) continue;
    result.push({
      time: group[group.length - 1].time,
      open: group[0].open,
      high: Math.max(...group.map((bar) => bar.high)),
      low: Math.min(...group.map((bar) => bar.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((sum, bar) => sum + bar.volume, 0),
    });
  }
  return result;
}

/**
 * Two swings a few bars apart are one reaction, not two. If the closer swing is more extreme,
 * it replaces the earlier one so plateau highs and lows do not inflate the reaction count.
 */
function independentPivots(pivots: Pivot[], minGap: number): Pivot[] {
  const ordered = [...pivots].sort((left, right) => left.index - right.index);
  const kept: Pivot[] = [];
  for (const pivot of ordered) {
    const nearbyIndex = kept.findIndex((item) => Math.abs(item.index - pivot.index) < minGap);
    if (nearbyIndex < 0) {
      kept.push(pivot);
      continue;
    }
    const nearby = kept[nearbyIndex];
    const moreExtreme = pivot.kind === "high" ? pivot.price > nearby.price : pivot.price < nearby.price;
    if (moreExtreme) kept[nearbyIndex] = pivot;
  }
  return kept;
}

/** Group prices that sit within one ATR-scaled tolerance of the running cluster mean. */
function clusterPivots(pivots: Pivot[], tolerance: number): Pivot[][] {
  const ordered = [...pivots].sort((left, right) => left.price - right.price);
  const clusters: Pivot[][] = [];
  for (const pivot of ordered) {
    const cluster = clusters.at(-1);
    if (!cluster) {
      clusters.push([pivot]);
      continue;
    }
    const mean = average(cluster.map((item) => item.price));
    if (Math.abs(pivot.price - mean) <= tolerance) cluster.push(pivot);
    else clusters.push([pivot]);
  }
  return clusters;
}

/** How far the candle's wick and close rejected the level, averaged over the reactions. */
function rejectionScore(pivots: Pivot[], kind: KeyLevelKind): number {
  const scores = pivots.map(({ bar }) => {
    const range = bar.high - bar.low;
    if (range <= 0) return 0;
    const wick = kind === "resistance"
      ? (bar.high - Math.max(bar.open, bar.close)) / range
      : (Math.min(bar.open, bar.close) - bar.low) / range;
    // A close away from the level is a second confirmation, but the wick carries more weight.
    const closeAway = kind === "resistance"
      ? (bar.open - bar.close) / range
      : (bar.close - bar.open) / range;
    return clamp01(0.65 * wick + 0.35 * Math.max(0, closeAway));
  });
  return average(scores);
}

/** Volume at the reactions compared with the window's own baseline. */
function volumeScore(pivots: Pivot[], baseline: number): number {
  if (baseline <= 0) return 0;
  const reactionVolume = average(pivots.map(({ bar }) => bar.volume));
  // Average volume is neutral-low; 1.5× average or better earns the full 15 points.
  return clamp01((reactionVolume / baseline - 0.75) / 0.75);
}

/** The newest reaction carries the recency weight; old levels fade out. */
function recencyScore(pivots: Pivot[], lastIndex: number): number {
  const newest = Math.max(...pivots.map(({ index }) => index));
  return clamp01(1 - (lastIndex - newest) / RECENCY_BARS);
}

/** Higher-timeframe pivots within (or close to) the band confirm the level. */
function confluenceScore(
  center: number,
  halfWidth: number,
  kind: KeyLevelKind,
  htfPivots: Pivot[],
): number {
  const matching = htfPivots.filter((pivot) =>
    kind === "resistance" ? pivot.kind === "high" : pivot.kind === "low");
  if (!matching.length) return 0;
  const falloff = Math.max(halfWidth * 2.5, center * 0.0001);
  return matching.reduce(
    (best, pivot) => Math.max(best, clamp01(1 - Math.abs(pivot.price - center) / falloff)),
    0,
  );
}

function buildLevel(
  kind: KeyLevelKind,
  pivots: Pivot[],
  atrValue: number | null,
  baselineVolume: number,
  lastIndex: number,
  htfPivots: Pivot[],
): KeyLevel {
  const prices = pivots.map(({ price }) => price);
  const center = average(prices);
  const spread = Math.max(...prices) - Math.min(...prices);
  const atrBand = atrValue !== null && atrValue > 0 ? atrValue : center * 0.002;
  // Slightly tighter than the scoring cluster: the chart is marking a level, not painting a
  // full volatility band over the candles.
  const halfWidth = Math.max(
    atrBand * 0.18,
    spread / 2 + center * 0.00015,
    center * 0.0004,
  );

  const factors = {
    reactions: clamp01(pivots.length / 4),
    rejection: rejectionScore(pivots, kind),
    confluence: confluenceScore(center, halfWidth, kind, htfPivots),
    volume: volumeScore(pivots, baselineVolume),
    recency: recencyScore(pivots, lastIndex),
  };
  const strength = Math.round(
    KEY_LEVEL_WEIGHTS.reactions * factors.reactions
    + KEY_LEVEL_WEIGHTS.rejection * factors.rejection
    + KEY_LEVEL_WEIGHTS.confluence * factors.confluence
    + KEY_LEVEL_WEIGHTS.volume * factors.volume
    + KEY_LEVEL_WEIGHTS.recency * factors.recency,
  );

  return {
    kind,
    price: center,
    low: center - halfWidth,
    high: center + halfWidth,
    strength,
    reactions: pivots.length,
    factors,
  };
}

/**
 * Finds the two closest qualified supports below the latest close and the two closest qualified
 * resistances above it. A level must score at least 40/100 to be drawn.
 *
 * The selected timeframe supplies the reactions; a 4× aggregation supplies the higher-timeframe
 * confluence. Raw OHLC is used even when the chart is showing Heikin Ashi, because averaged
 * candles would move the actual wick highs and lows.
 */
export function findKeyLevels(input: Bar[]): KeyLevels {
  const empty: KeyLevels = { supports: [], resistances: [] };
  if (!input.length) return empty;

  const bars = input.slice(-MAX_BARS);
  if (bars.length < 20) return empty;

  const lastIndex = bars.length - 1;
  const close = bars[lastIndex].close;
  const atrValue = atr(bars).at(-1) ?? null;
  const baselineVolume = average(bars.map((bar) => bar.volume));
  const pivots = findPivots(bars, SWING_SPAN);
  if (!pivots.length) return empty;

  const htfBars = aggregateBars(bars, HTF_MULTIPLIER);
  const htfPivots = htfBars.length > HTF_SWING_SPAN * 2
    ? findPivots(htfBars, HTF_SWING_SPAN)
    : [];
  const tolerance = Math.max(
    (atrValue !== null && atrValue > 0 ? atrValue : close * 0.002) * 0.35,
    close * 0.0008,
  );

  const levels: KeyLevel[] = [];
  for (const kind of ["support", "resistance"] as const) {
    const matching = pivots.filter((pivot) =>
      kind === "resistance" ? pivot.kind === "high" : pivot.kind === "low");
    for (const cluster of clusterPivots(matching, tolerance)) {
      const independent = independentPivots(cluster, SWING_SPAN * 2 + 1);
      if (independent.length < MIN_REACTIONS) continue;
      levels.push(buildLevel(kind, independent, atrValue, baselineVolume, lastIndex, htfPivots));
    }
  }

  // A broken level belongs on the other side of the trade, so supports stay below price and
  // resistances above it. Equality is allowed so a level being tested right now is still drawn.
  const supports = levels
    .filter((level) =>
      level.kind === "support"
      && level.price <= close
      && level.strength >= MIN_DISPLAY_STRENGTH)
    .sort((left, right) => right.price - left.price || right.strength - left.strength)
    .slice(0, 2);
  const resistances = levels
    .filter((level) =>
      level.kind === "resistance"
      && level.price >= close
      && level.strength >= MIN_DISPLAY_STRENGTH)
    .sort((left, right) => left.price - right.price || right.strength - left.strength)
    .slice(0, 2);

  return { supports, resistances };
}
