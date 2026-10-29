/**
 * Classic chart-pattern recognition for the pattern-analysis picture export.
 *
 * Detectors work on plain OHLC bars and return geometry in (time, price) space, so the
 * workspace can paint a match on top of a chart screenshot without touching the live chart.
 * Every detector looks for the most recent occurrence, because that is the one that matters
 * for the latest slice of candles the monitor evaluates.
 *
 * A shape that has not finished is reported too. Head and shoulders without its right shoulder,
 * a double top without its second top, and triangles or flags still inside their channel are
 * marked `forming`: the missing swing is returned as a `projection` segment, the level that
 * confirms the shape as a `trigger` segment, and the measured target is measured from the
 * geometry that is actually on the chart. A completed shape always wins over a partial one for
 * the same pattern, so a forming match never shadows a real one.
 */

export type PatternKey =
  | "head_and_shoulders" | "inverse_head_and_shoulders" | "double_top" | "double_bottom"
  | "bull_flag" | "bear_flag" | "ascending_triangle" | "descending_triangle"
  | "symmetrical_triangle" | "rising_wedge" | "falling_wedge";

export type PatternBar = { time: number; open: number; high: number; low: number; close: number };

export type PatternChoice = { value: PatternKey; label: string; bias: "bullish" | "bearish" };

export const patternChoices: PatternChoice[] = [
  { value: "head_and_shoulders", label: "Head and Shoulders", bias: "bearish" },
  { value: "inverse_head_and_shoulders", label: "Inverse Head and Shoulders", bias: "bullish" },
  { value: "double_top", label: "Double Top", bias: "bearish" },
  { value: "double_bottom", label: "Double Bottom", bias: "bullish" },
  { value: "bull_flag", label: "Bull Flag", bias: "bullish" },
  { value: "bear_flag", label: "Bear Flag", bias: "bearish" },
  { value: "ascending_triangle", label: "Ascending Triangle", bias: "bullish" },
  { value: "descending_triangle", label: "Descending Triangle", bias: "bearish" },
  { value: "symmetrical_triangle", label: "Symmetrical Triangle", bias: "bullish" },
  { value: "rising_wedge", label: "Rising Wedge", bias: "bearish" },
  { value: "falling_wedge", label: "Falling Wedge", bias: "bullish" },
];

const choices = new Map(patternChoices.map((choice) => [choice.value, choice]));

export type PatternPoint = { time: number; price: number };
/** The role decides how the workspace paints a line; the geometry carries no styling itself.
 *  "projection" is a swing that has not printed yet and "trigger" is the level that confirms it. */
export type PatternSegment = { from: PatternPoint; to: PatternPoint; role: "outline" | "boundary" | "pole" | "target" | "projection" | "trigger" };
export type PatternMarker = PatternPoint & { kind: "peak" | "trough"; text?: string };
export type PatternLabel = PatternPoint & { text: string };
export type PatternMatch = {
  key: PatternKey;
  label: string;
  bias: "bullish" | "bearish";
  segments: PatternSegment[];
  markers: PatternMarker[];
  labels: PatternLabel[];
  /** Short sentence describing what was found; also captioned on exported pictures. */
  summary: string;
  /** True while the confirming swing or breakout is still missing, so the geometry is projected. */
  forming: boolean;
  /** Plain sentence naming the level that confirms the shape, when there is one. */
  trigger?: string;
  /** Level at which the shape is traded once it confirms. */
  entry?: string;
  /** Level that proves the reading wrong. */
  invalidation?: string;
};

type Pivot = { index: number; price: number; kind: "peak" | "trough" };
type Trend = { slope: number; at: (index: number) => number };
type PriceRange = { low: number; high: number; span: number };
/** A missing "right" or "second" pivot is what makes a shape partial rather than finished. */
type ThreeSwing = { left: Pivot; neck1: Pivot; head: Pivot; neck2: Pivot; right: Pivot | null };
type DoubleSwing = { first: Pivot; middle: Pivot; second: Pivot | null };

/** Lines are stretched a few bars past the last bar so the picture reads into the empty space. */
const PROJECTION_BARS = 6;
/** Hard cap on how far past its own last swing a pattern is allowed to project. */
const MAX_PROJECTION_BARS = 24;
/**
 * How close to the last bar a partial shape has to be. A missing swing that is still tens of bars
 * away is a forecast, not a pattern, so anything further back is left to the completed detectors.
 */
const FORMING_WINDOW = 30;
/**
 * Smallest reaction, as a share of the pattern's own price, that still counts as a structure. The
 * checks below are all shares of the visible range, which is generous on a chart that is travelling:
 * a two-bump wiggle clears them easily. Without a floor in price terms, noise between two blips gets
 * reported as a double top.
 */
const MIN_REACTION_RATIO = 0.005;

/**
 * A reversal shape stops being a setup once price has closed decisively against it: a double top
 * cleared from above, or a double bottom from below, is already over and its target is meaningless.
 */
function brokeAgainst(bars: PatternBar[], extreme: "peak" | "trough", levels: number[]) {
  const close = bars[bars.length - 1].close;
  const edge = extreme === "peak" ? Math.max(...levels) : Math.min(...levels);
  return extreme === "peak" ? close > edge : close < edge;
}

/**
 * First bar after `from` that closes beyond the level, or null when it never does. The index is
 * what names the confirmation price: a sloped line is at a different level on the break bar than
 * on the shape's last swing.
 */
function firstCloseBeyond(
  bars: PatternBar[],
  from: number,
  direction: "above" | "below",
  levelAt: (index: number) => number,
) {
  for (let index = Math.max(0, from + 1); index < bars.length; index += 1) {
    const close = bars[index].close;
    if (direction === "above" ? close > levelAt(index) : close < levelAt(index)) return index;
  }
  return null;
}

/**
 * True when a bar after `from` has closed beyond the level. Confirmation only counts after the
 * last swing of the shape: a neckline break that happened before the right shoulder does not
 * complete the pattern, it just means the shape failed on the way there.
 */
function closedBeyond(
  bars: PatternBar[],
  from: number,
  direction: "above" | "below",
  levelAt: (index: number) => number,
) {
  return firstCloseBeyond(bars, from, direction, levelAt) !== null;
}

function priceText(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: value >= 100 ? 2 : value >= 1 ? 4 : 8 });
}

function priceRange(bars: PatternBar[]): PriceRange {
  let low = Infinity;
  let high = -Infinity;
  for (const bar of bars) {
    if (bar.low < low) low = bar.low;
    if (bar.high > high) high = bar.high;
  }
  return { low, high, span: Math.max(high - low, Number.EPSILON) };
}

/** A swing is a bar whose high, or low, rules its whole window on both sides. */
function swingPivots(bars: PatternBar[], halfWindow: number): Pivot[] {
  const swings: Pivot[] = [];
  const keep = (pivot: Pivot) => {
    const previous = swings.at(-1);
    // Neighbouring bars of the same type are one swing, so only the extreme one is kept.
    if (previous && previous.kind === pivot.kind) {
      const stronger = pivot.kind === "peak" ? Math.max(previous.price, pivot.price) : Math.min(previous.price, pivot.price);
      if (stronger !== previous.price) swings[swings.length - 1] = pivot;
      return;
    }
    swings.push(pivot);
  };
  for (let index = halfWindow; index < bars.length - halfWindow; index += 1) {
    let isPeak = true;
    let isTrough = true;
    for (let offset = 1; offset <= halfWindow; offset += 1) {
      if (bars[index - offset].high >= bars[index].high || bars[index + offset].high >= bars[index].high) isPeak = false;
      if (bars[index - offset].low <= bars[index].low || bars[index + offset].low <= bars[index].low) isTrough = false;
    }
    if (isPeak) keep({ index, price: bars[index].high, kind: "peak" });
    else if (isTrough) keep({ index, price: bars[index].low, kind: "trough" });
  }
  return swings;
}

/** Drops the rare double swing so highs and lows strictly alternate. */
function alternating(swings: Pivot[]): Pivot[] {
  const sequence: Pivot[] = [];
  for (const swing of swings) if (sequence.length === 0 || sequence.at(-1)!.kind !== swing.kind) sequence.push(swing);
  return sequence;
}

/** Least-squares fit; the returned price function extrapolates past the fitted points. */
function trendFit(points: { index: number; price: number }[]): Trend | null {
  if (points.length < 2) return null;
  let sumIndex = 0;
  let sumPrice = 0;
  let sumProduct = 0;
  let sumSquared = 0;
  for (const point of points) {
    sumIndex += point.index;
    sumPrice += point.price;
    sumProduct += point.index * point.price;
    sumSquared += point.index * point.index;
  }
  const denominator = points.length * sumSquared - sumIndex * sumIndex;
  if (!denominator) return null;
  const slope = (points.length * sumProduct - sumIndex * sumPrice) / denominator;
  const intercept = (sumPrice - slope * sumIndex) / points.length;
  return { slope, at: (index: number) => slope * index + intercept };
}

/** Flat reference line, used where the pattern only gives a single anchor price. */
function flatTrend(price: number): Trend {
  return { slope: 0, at: () => price };
}

/** A line is only a boundary if every swing it is fitted to actually touches it. */
function lineFits(pivots: Pivot[], trend: Trend, tolerance: number) {
  return pivots.every((pivot) => Math.abs(pivot.price - trend.at(pivot.index)) <= tolerance);
}

function barStep(bars: PatternBar[]) {
  return bars.length > 1 ? bars[1].time - bars[0].time : 60;
}

/**
 * Bar index a pattern's lines stop at: past the last bar of the range when the pattern is
 * current, otherwise only just past the pattern's own last swing. Projecting an old, steep
 * trendline across the whole range would draw it into prices that have nothing to do with it.
 */
function projectionEdge(bars: PatternBar[], lastSwingIndex: number) {
  return Math.min(bars.length - 1 + PROJECTION_BARS, lastSwingIndex + MAX_PROJECTION_BARS);
}

/** Maps a bar index, allowed to run past either end, back onto a timestamp. */
function timeAt(bars: PatternBar[], index: number) {
  const step = barStep(bars);
  if (index < 0) return bars[0].time + index * step;
  if (index >= bars.length) return bars[bars.length - 1].time + (index - bars.length + 1) * step;
  return bars[index].time;
}

function poleExtents(bars: PatternBar[], from: number, to: number) {
  let low = Infinity;
  let high = -Infinity;
  for (let index = from; index <= to; index += 1) {
    if (bars[index].low < low) low = bars[index].low;
    if (bars[index].high > high) high = bars[index].high;
  }
  return { low, high, height: high - low };
}

/** Neckline through the two reaction pivots, shared by the finished and the partial reading. */
function neckTrend(group: ThreeSwing): Trend | null {
  return trendFit([
    { index: group.neck1.index, price: group.neck1.price },
    { index: group.neck2.index, price: group.neck2.price },
  ]);
}

/**
 * Geometry test shared by both readings: the head has to stand out and the neckline has to stay a
 * line the user can follow. Returns the score, or null when the group does not hold together.
 */
function scoreThreeSwing(bars: PatternBar[], range: PriceRange, group: ThreeSwing, extreme: "peak" | "trough"): number | null {
  const { left, head, neck2, right } = group;
  const end = right?.index ?? neck2.index;
  if (end - left.index < 12) return null;
  // With no right shoulder yet the left shoulder is the only one to measure the head against.
  const shoulder = right?.price ?? left.price;
  const bestShoulder = extreme === "peak" ? Math.max(left.price, shoulder) : Math.min(left.price, shoulder);
  const advance = extreme === "peak" ? head.price - bestShoulder : bestShoulder - head.price;
  if (advance < 0.02 * range.span) return null;
  if (right && Math.abs(left.price - right.price) > Math.max(0.6 * advance, 0.02 * range.span)) return null;
  // Reaction pivots from different price universes give the neckline a useless slope.
  if (Math.abs(group.neck1.price - neck2.price) > 0.6 * range.span) return null;
  const neckline = neckTrend(group);
  if (!neckline) return null;
  // The neckline has to reach the end of the shape at a price that is still inside the visible range.
  const neckEnd = neckline.at(projectionEdge(bars, end));
  if (neckEnd < range.low - 0.2 * range.span || neckEnd > range.high + 0.2 * range.span) return null;
  // A group pinned to the left edge is history, so recency is weighted heavily here.
  return advance / range.span + 0.25 * (end / (bars.length - 1));
}

/** A partial shape is only useful while price is still on the head's side of the neckline. */
function stillOnHeadSide(bars: PatternBar[], group: ThreeSwing) {
  const neckline = neckTrend(group);
  if (!neckline) return false;
  const close = bars[bars.length - 1].close;
  const neck = neckline.at(bars.length - 1);
  return group.head.kind === "peak" ? close > neck : close < neck;
}

/** Head and Shoulders, or the inverted version when the head is made of troughs. */
function findThreeSwing(bars: PatternBar[], swings: Pivot[], extreme: "peak" | "trough"): ThreeSwing | null {
  const sequence = alternating(swings);
  const last = bars.length - 1;
  const range = priceRange(bars);
  let best: { score: number; group: ThreeSwing } | null = null;
  /** Keeps the highest-scoring group; a null score means the group did not hold together. */
  const keep = (score: number | null, group: ThreeSwing, current: { score: number; group: ThreeSwing } | null) => score === null || (current && score <= current.score) ? current : { score, group };
  // A shape that has already printed its right shoulder is worth more than a projection of one.
  for (let start = 0; start + 4 < sequence.length; start += 1) {
    const group: ThreeSwing = {
      left: sequence[start], neck1: sequence[start + 1], head: sequence[start + 2],
      neck2: sequence[start + 3], right: sequence[start + 4],
    };
    // The sequence alternates, so this also skips groups built on the opposite swing type.
    if (group.left.kind !== extreme || group.head.kind !== extreme || group.right!.kind !== extreme) continue;
    // Price clearing the right shoulder has already broken the lower-high/lower-low structure, so
    // the group is no longer a head and shoulders even if the neckline is still below it.
    if (brokeAgainst(bars, extreme, [group.right!.price])) continue;
    best = keep(scoreThreeSwing(bars, range, group, extreme), group, best);
  }
  if (best) return best.group;
  // Head and neckline are on the chart, the right shoulder is not: project it.
  for (let start = 0; start + 3 < sequence.length; start += 1) {
    const group: ThreeSwing = {
      left: sequence[start], neck1: sequence[start + 1], head: sequence[start + 2],
      neck2: sequence[start + 3], right: null,
    };
    if (group.left.kind !== extreme || group.head.kind !== extreme) continue;
    if (last - group.neck2.index > FORMING_WINDOW) continue;
    // The missing shoulder is drawn at the mirrored neckline swing. If that date has already
    // passed without the shoulder printing, the setup is stale rather than still forming.
    const shoulderIndex = group.neck2.index + (group.neck2.index - group.neck1.index);
    if (shoulderIndex <= last) continue;
    if (!stillOnHeadSide(bars, group)) continue;
    // A rally through the left shoulder makes the projected right shoulder a higher high, not a
    // lower high, so the shape has already failed.
    if (brokeAgainst(bars, extreme, [group.left.price])) continue;
    best = keep(scoreThreeSwing(bars, range, group, extreme), group, best);
  }
  return best?.group ?? null;
}

function buildThreeSwing(key: PatternKey, bars: PatternBar[], found: ThreeSwing): PatternMatch {
  const { left, neck1, head, neck2, right } = found;
  const bearish = key === "head_and_shoulders";
  const extreme: PatternMarker["kind"] = bearish ? "peak" : "trough";
  const other: PatternMarker["kind"] = bearish ? "trough" : "peak";
  const edge = projectionEdge(bars, right?.index ?? neck2.index);
  const neckline = neckTrend(found);
  const missingShoulder = right === null;
  // A printed right shoulder is only half the pattern: the neckline break is the confirmation.
  const breakIndex = right !== null && neckline !== null
    ? firstCloseBeyond(bars, right.index, bearish ? "below" : "above", (index) => neckline.at(index))
    : null;
  const confirmed = breakIndex !== null;
  const forming = missingShoulder || !confirmed;
  const choice = choices.get(key)!;
  const segments: PatternSegment[] = [
    { from: { time: timeAt(bars, left.index), price: left.price }, to: { time: timeAt(bars, neck1.index), price: neck1.price }, role: "outline" },
    { from: { time: timeAt(bars, neck1.index), price: neck1.price }, to: { time: timeAt(bars, head.index), price: head.price }, role: "outline" },
    { from: { time: timeAt(bars, head.index), price: head.price }, to: { time: timeAt(bars, neck2.index), price: neck2.price }, role: "outline" },
  ];
  if (right) segments.push({ from: { time: timeAt(bars, neck2.index), price: neck2.price }, to: { time: timeAt(bars, right.index), price: right.price }, role: "outline" });
  const labels: PatternLabel[] = [
    { time: timeAt(bars, left.index), price: left.price, text: "LS" },
    { time: timeAt(bars, head.index), price: head.price, text: "Head" },
  ];
  if (right) labels.push({ time: timeAt(bars, right.index), price: right.price, text: "RS" });
  const span = (right?.index ?? neck2.index) - left.index;
  const breakWord = bearish ? "below" : "above";
  let summary = `${choice.label} over ${span} bars.`;
  let trigger: string | undefined;
  let entry: string | undefined;
  let invalidation = `Close ${bearish ? "above" : "below"} ${priceText(head.price)} against the head.`;
  if (forming) {
    summary = `${choice.label} forming over ${span} bars`;
    if (!missingShoulder) summary += " · awaiting neckline break";
    if (missingShoulder) {
      // The missing shoulder mirrors the left one in time and stops at its price.
      const shoulderIndex = neck2.index + (neck2.index - neck1.index);
      const shoulder = { time: timeAt(bars, shoulderIndex), price: left.price };
      segments.push({ from: { time: timeAt(bars, neck2.index), price: neck2.price }, to: shoulder, role: "projection" });
      if (neckline) segments.push({ from: shoulder, to: { time: shoulder.time, price: neckline.at(shoulderIndex) }, role: "projection" });
      labels.push({ ...shoulder, text: "Projected RS" });
    }
  }
  if (neckline) {
    // The neckline starts under the left shoulder so the whole shape sits above it.
    const neckStart = neckline.at(left.index);
    const neckEnd = neckline.at(edge);
    // While the shape is partial this line is the break level rather than just a boundary.
    segments.push({ from: { time: timeAt(bars, left.index), price: neckStart }, to: { time: timeAt(bars, edge), price: neckEnd }, role: forming ? "trigger" : "boundary" });
    const height = bearish ? head.price - neckline.at(head.index) : neckline.at(head.index) - head.price;
    const target = neckEnd + (bearish ? -height : height);
    segments.push({ from: { time: timeAt(bars, left.index), price: target }, to: { time: timeAt(bars, edge), price: target }, role: "target" });
    labels.push({ time: timeAt(bars, neck2.index), price: neck2.price, text: "Neckline" }, { time: timeAt(bars, edge), price: target, text: "Target" });
    if (forming) {
      // The line runs on to the projection edge, but the level that confirms the shape today is
      // the neckline at the latest bar; a sloping neckline otherwise quotes a future price.
      const neckNow = neckline.at(bars.length - 1);
      trigger = `Close ${breakWord} ${priceText(neckNow)} to confirm.`;
      entry = trigger;
      summary = `${summary} · break ${breakWord} ${priceText(neckNow)} · target ${priceText(target)}`;
    } else {
      summary = `${choice.label} over ${span} bars · neckline ${priceText(neckEnd)} · target ${priceText(target)}`;
      entry = breakIndex !== null && neckline
        ? `Neckline broke ${breakWord} ${priceText(neckline.at(breakIndex))}.`
        : undefined;
    }
  }
  const markers: PatternMarker[] = [
    { time: timeAt(bars, left.index), price: left.price, kind: extreme, text: "Left shoulder" },
    { time: timeAt(bars, head.index), price: head.price, kind: extreme, text: "Head" },
    ...(right ? [{ time: timeAt(bars, right.index), price: right.price, kind: extreme, text: "Right shoulder" }] : []),
    { time: timeAt(bars, neck1.index), price: neck1.price, kind: other },
    { time: timeAt(bars, neck2.index), price: neck2.price, kind: other },
  ];
  return {
    label: choice.label, bias: choice.bias, segments, forming, trigger, markers,
    labels, summary, key, entry, invalidation,
  };
}

/** Double Top or Double Bottom: two similar swings with one clear reaction between them. */
function findDoubleSwing(bars: PatternBar[], swings: Pivot[], extreme: "peak" | "trough"): DoubleSwing | null {
  const sequence = alternating(swings);
  const last = bars.length - 1;
  const range = priceRange(bars);
  let best: { score: number; group: DoubleSwing } | null = null;
  const keep = (score: number, group: DoubleSwing, current: { score: number; group: DoubleSwing } | null) => current && score <= current.score ? current : { score, group };
  for (let start = 0; start + 2 < sequence.length; start += 1) {
    const group: DoubleSwing = { first: sequence[start], middle: sequence[start + 1], second: sequence[start + 2] };
    if (group.first.kind !== extreme || group.second!.kind !== extreme) continue;
    if (group.second!.index - group.first.index < 10) continue;
    if (Math.abs(group.first.price - group.second!.price) > 0.1 * range.span) continue;
    const reaction = extreme === "peak" ? Math.min(group.first.price, group.second!.price) - group.middle.price : group.middle.price - Math.max(group.first.price, group.second!.price);
    if (reaction < 0.03 * range.span) continue;
    if (reaction < MIN_REACTION_RATIO * Math.max(group.first.price, group.second!.price)) continue;
    if (brokeAgainst(bars, extreme, [group.first.price, group.second!.price])) continue;
    // Depth is what makes this a double top rather than two blips joined by a wiggle, so it leads
    // the score. Scoring on how neatly the two levels lined up instead picked the flattest, least
    // convincing candidate in the window and ignored a real reaction sitting further along.
    const level = extreme === "peak" ? Math.max(group.first.price, group.second!.price) : Math.min(group.first.price, group.second!.price);
    best = keep((reaction / level) * 20 + (1 - Math.abs(group.first.price - group.second!.price) / range.span) + 0.15 * (group.second!.index / last), group, best);
  }
  if (best) return best.group;
  // First top is printed and the reaction is under way, but the second top has not reached it.
  for (let start = 0; start + 1 < sequence.length; start += 1) {
    const group: DoubleSwing = { first: sequence[start], middle: sequence[start + 1], second: null };
    if (group.first.kind !== extreme) continue;
    if (last - group.middle.index > FORMING_WINDOW) continue;
    // The projected second top is drawn at the mirrored time. If that bar is already behind us,
    // the setup had its chance and did not print, so reporting it as forming would paint history.
    const projectedIndex = group.middle.index + (group.middle.index - group.first.index);
    if (projectedIndex <= last) continue;
    const depth = Math.abs(group.first.price - group.middle.price);
    if (depth < 0.03 * range.span) continue;
    if (depth < MIN_REACTION_RATIO * group.first.price) continue;
    // Price clearing the first top puts the projected second one out of reach.
    if (brokeAgainst(bars, extreme, [group.first.price])) continue;
    // A close through the reaction level means the neckline broke before the second top; that is
    // a failed double top/bottom, not a partial one.
    const close = bars[last].close;
    if (extreme === "peak" ? close <= group.middle.price : close >= group.middle.price) continue;
    // Approaching the first top is the normal path to a second top. The invalidation above already
    // rejects a close that has cleared it, so there is no retracement ceiling to enforce here.
    // Same weighting as the completed shape, and measured against the level rather than the range,
    // so the depth term means the same thing on every pair instead of being dwarfed by recency.
    best = keep((depth / group.first.price) * 20 + 0.25 * (group.middle.index / last), group, best);
  }
  return best?.group ?? null;
}

function buildDoubleSwing(key: PatternKey, bars: PatternBar[], found: DoubleSwing): PatternMatch {
  const { first, middle, second } = found;
  const bearish = key === "double_top";
  const extreme: PatternMarker["kind"] = bearish ? "peak" : "trough";
  const other: PatternMarker["kind"] = bearish ? "trough" : "peak";
  const edge = projectionEdge(bars, second?.index ?? middle.index);
  const missingSecond = second === null;
  // Two equal tops are not a confirmed double top until price closes through the reaction low.
  // The same rule mirrored applies to a double bottom and its reaction high.
  const confirmed = second !== null
    && closedBeyond(bars, second.index, bearish ? "below" : "above", () => middle.price);
  const forming = missingSecond || !confirmed;
  const choice = choices.get(key)!;
  // With no second top yet, the level it has to come back to is the flat one it left behind.
  const level = second
    ? trendFit([
      { index: first.index, price: first.price },
      { index: second.index, price: second.price },
    ])
    : flatTrend(first.price);
  // A single reaction cannot be fitted, so the neckline is the flat level it left behind.
  const neckline = flatTrend(middle.price);
  const segments: PatternSegment[] = [
    { from: { time: timeAt(bars, first.index), price: first.price }, to: { time: timeAt(bars, middle.index), price: middle.price }, role: "outline" },
  ];
  if (second) segments.push({ from: { time: timeAt(bars, middle.index), price: middle.price }, to: { time: timeAt(bars, second.index), price: second.price }, role: "outline" });
  const labels: PatternLabel[] = [
    { time: timeAt(bars, first.index), price: first.price, text: bearish ? "Top 1" : "Bottom 1" },
  ];
  if (second) labels.push({ time: timeAt(bars, second.index), price: second.price, text: bearish ? "Top 2" : "Bottom 2" });
  if (missingSecond) {
    // The missing top mirrors the first leg in time and has to stop at the first top's price.
    const projectedIndex = middle.index + (middle.index - first.index);
    const projected = { time: timeAt(bars, projectedIndex), price: first.price };
    segments.push({ from: { time: timeAt(bars, middle.index), price: middle.price }, to: projected, role: "projection" });
    segments.push({ from: projected, to: { time: projected.time, price: neckline.at(projectedIndex) }, role: "projection" });
    labels.push({ ...projected, text: bearish ? "Projected top 2" : "Projected bottom 2" });
  }
  let summary = `${choice.label}${forming ? " forming" : ""} over ${(second?.index ?? middle.index) - first.index} bars`;
  if (forming && !missingSecond) summary += " · awaiting neckline break";
  let trigger: string | undefined;
  let entry: string | undefined;
  const failureLevel = extreme === "peak"
    ? Math.max(first.price, second?.price ?? first.price)
    : Math.min(first.price, second?.price ?? first.price);
  const invalidation = `Close ${bearish ? "above" : "below"} ${priceText(failureLevel)} invalidates both ${bearish ? "tops" : "bottoms"}.`;
  const height = level ? Math.abs(level.at(edge) - neckline.at(edge)) : 0;
  if (level) {
    segments.push({ from: { time: timeAt(bars, first.index), price: level.at(first.index) }, to: { time: timeAt(bars, edge), price: level.at(edge) }, role: "boundary" });
    // While the second top is missing, the reaction level is the break that confirms the shape.
    segments.push({ from: { time: timeAt(bars, first.index), price: neckline.at(first.index) }, to: { time: timeAt(bars, edge), price: neckline.at(edge) }, role: forming ? "trigger" : "boundary" });
    const target = neckline.at(edge) + (bearish ? -height : height);
    segments.push({ from: { time: timeAt(bars, first.index), price: target }, to: { time: timeAt(bars, edge), price: target }, role: "target" });
    labels.push(
      { time: timeAt(bars, middle.index), price: middle.price, text: "Neckline" },
      { time: timeAt(bars, edge), price: target, text: "Target" },
    );
    if (forming) {
      trigger = `Close ${bearish ? "below" : "above"} ${priceText(neckline.at(edge))} to confirm.`;
      entry = trigger;
      summary += ` · break ${bearish ? "below" : "above"} ${priceText(neckline.at(edge))}`;
    } else {
      summary += ` · neckline ${priceText(neckline.at(edge))}`;
      entry = `Reaction level broke at ${priceText(neckline.at(edge))}.`;
    }
    summary += ` · target ${priceText(target)}`;
  }
  const markers: PatternMarker[] = [
    { time: timeAt(bars, first.index), price: first.price, kind: extreme, text: bearish ? "Top 1" : "Bottom 1" },
    ...(second ? [{ time: timeAt(bars, second.index), price: second.price, kind: extreme, text: bearish ? "Top 2" : "Bottom 2" }] : []),
    { time: timeAt(bars, middle.index), price: middle.price, kind: other },
  ];
  return {
    label: choice.label, bias: choice.bias, segments, forming, trigger, markers,
    labels, summary, key, entry, invalidation,
  };
}

/** A pole is the sharp move before the pause, not a slow drift that happens to cover 3%. */
const MAX_POLE_BARS = 20;

/** Bull or Bear Flag: one decisive move, then a tight channel that leans against it. */
function findFlag(bars: PatternBar[], key: "bull_flag" | "bear_flag") {
  const rising = key === "bull_flag";
  const count = bars.length;
  const last = count - 1;
  const pivots = swingPivots(bars, 2);
  const scanFrom = Math.max(0, count - 170);
  const choice = choices.get(key)!;
  let best: { score: number; result: PatternMatch } | null = null;
  for (let start = scanFrom; start + 6 <= last - 4; start += 1) {
    for (let length = 6; length <= MAX_POLE_BARS && start + length <= last - 4; length += 1) {
      const poleEnd = start + length;
      const move = rising ? bars[poleEnd].close / bars[start].close - 1 : 1 - bars[poleEnd].close / bars[start].close;
      if (move < 0.03) continue;
      const pole = poleExtents(bars, start, poleEnd);
      if (pole.height < 0.01 * bars[start].close) continue;
      const base = poleEnd + 1;
      // A flag is a short pause, so a long stretch after the move is a different shape entirely.
      const pause = last - poleEnd;
      if (pause < 5 || pause > 45) continue;
      const highs = pivots.filter((pivot) => pivot.kind === "peak" && pivot.index >= base + 1 && pivot.index <= last);
      const lows = pivots.filter((pivot) => pivot.kind === "trough" && pivot.index >= base + 1 && pivot.index <= last);
      if (highs.length < 2 || lows.length < 2) continue;
      const upper = trendFit(highs.map((pivot) => ({ index: pivot.index, price: pivot.price })));
      const lower = trendFit(lows.map((pivot) => ({ index: pivot.index, price: pivot.price })));
      if (!upper || !lower) continue;
      const channelStart = upper.at(base) - lower.at(base);
      const channelEnd = upper.at(last) - lower.at(last);
      if (channelStart <= 0 || channelEnd <= 0) continue;
      // The consolidation has to stay inside the move it belongs to and lean against it.
      if (channelEnd > 0.6 * pole.height) continue;
      if (upper.at(base) > pole.high + 0.05 * pole.height) continue;
      if (lower.at(base) < pole.low - 0.05 * pole.height) continue;
      const upperDrift = upper.at(last) - upper.at(base);
      const lowerDrift = lower.at(last) - lower.at(base);
      if (rising ? Math.max(upperDrift, lowerDrift) > 0.35 * pole.height : Math.min(upperDrift, lowerDrift) < -0.35 * pole.height) continue;
      // Once price closes meaningfully outside the channel the flag has resolved, and this
      // detector deliberately only reports the pause before the breakout.
      const slack = 0.15 * channelEnd;
      const close = bars[last].close;
      if (close > upper.at(last) + slack || close < lower.at(last) - slack) continue;
      const score = move * (1 - 0.35 * ((last - poleEnd) / 170));
      if (best && score <= best.score) continue;
      const poleStart = { time: timeAt(bars, start), price: rising ? bars[start].low : bars[start].high };
      const poleEndPoint = { time: timeAt(bars, poleEnd), price: rising ? pole.high : pole.low };
      const half = base + Math.floor((last - base) / 2);
      const target = rising ? upper.at(last) + pole.height : lower.at(last) - pole.height;
      const flagPrice = rising ? lower.at(half) : upper.at(half);
      const segments: PatternSegment[] = [
        { from: poleStart, to: poleEndPoint, role: "pole" },
        { from: { time: timeAt(bars, base), price: upper.at(base) }, to: { time: timeAt(bars, last + PROJECTION_BARS), price: upper.at(last + PROJECTION_BARS) }, role: "boundary" },
        { from: { time: timeAt(bars, base), price: lower.at(base) }, to: { time: timeAt(bars, last + PROJECTION_BARS), price: lower.at(last + PROJECTION_BARS) }, role: "boundary" },
      ];
      const markers: PatternMarker[] = [
        { ...poleStart, kind: rising ? "trough" : "peak" },
        { ...poleEndPoint, kind: rising ? "peak" : "trough" },
      ];
      const labels: PatternLabel[] = [
        { time: timeAt(bars, start + Math.floor(length / 2)), price: rising ? pole.low : pole.high, text: "Pole" },
        { time: timeAt(bars, half), price: flagPrice, text: "Flag" },
        { time: timeAt(bars, last + PROJECTION_BARS), price: target, text: "Target" },
      ];
      // A flag only resolves once price leaves the channel, so it is always reported as forming.
      // The confirming level is the channel edge where price is now; quoting the edge at the
      // projected end of the drawing would name a price that does not exist yet.
      const triggerLevel = rising ? upper.at(last) : lower.at(last);
      const trigger = rising
        ? `Close above ${priceText(triggerLevel)} to confirm.`
        : `Close below ${priceText(triggerLevel)} to confirm.`;
      const invalidation = rising
        ? `Close below ${priceText(pole.low)} (pole low) invalidates the flag.`
        : `Close above ${priceText(pole.high)} (pole high) invalidates the flag.`;
      best = {
        score,
        result: {
          key, label: choice.label, bias: choice.bias, segments, markers, labels, forming: true, trigger,
          entry: trigger, invalidation,
          summary: `${choice.label} · pole ${(move * 100).toFixed(1)}% over ${length} bars, ${last - poleEnd}-bar ${rising ? "pullback" : "bounce"} · break ${rising ? "above" : "below"} ${priceText(triggerLevel)} · target ${priceText(target)}`,
        },
      };
    }
  }
  return best?.result ?? null;
}

/** Triangles and wedges: two trendlines that meet inside the visible range. */
function findConvergence(bars: PatternBar[], swings: Pivot[], kind: "ascending" | "descending" | "symmetrical" | "rising" | "falling") {
  const count = bars.length;
  const last = count - 1;
  const range = priceRange(bars);
  const key = kind === "rising" ? "rising_wedge" : kind === "falling" ? "falling_wedge" : `${kind}_triangle` as PatternKey;
  const choice = choices.get(key)!;
  let best: { score: number; result: PatternMatch } | null = null;
  for (let from = Math.max(2, count - 150); from <= last - 24; from += 1) {
    const highs = swings.filter((pivot) => pivot.kind === "peak" && pivot.index >= from && pivot.index <= last);
    const lows = swings.filter((pivot) => pivot.kind === "trough" && pivot.index >= from && pivot.index <= last);
    if (highs.length < 2 || lows.length < 2) continue;
    const upper = trendFit(highs.map((pivot) => ({ index: pivot.index, price: pivot.price })));
    const lower = trendFit(lows.map((pivot) => ({ index: pivot.index, price: pivot.price })));
    if (!upper || !lower) continue;
    const widthStart = upper.at(from) - lower.at(from);
    const widthEnd = upper.at(last) - lower.at(last);
    if (widthStart < 0.03 * range.span || widthEnd < 0.02 * range.span) continue;
    if (widthEnd > 0.8 * widthStart) continue;
    // A flat regression line through three highs is not a resistance line when one of them is a
    // spike far above it. Every touch has to be near the line it is supposed to define, and the
    // tolerance follows the channel rather than the whole history around it.
    const fitTolerance = Math.min(0.12 * range.span, 0.35 * widthStart);
    if (!lineFits(highs, upper, fitTolerance) || !lineFits(lows, lower, fitTolerance)) continue;
    const upperDrift = upper.at(last) - upper.at(from);
    const lowerDrift = lower.at(last) - lower.at(from);
    if (!matchesConvergence(kind, upperDrift, lowerDrift, widthStart)) continue;
    const score = (1 - widthEnd / widthStart) * 0.7 + ((last - from) / 150) * 0.3;
    if (best && score <= best.score) continue;
    const upTarget = upper.at(last) + widthStart;
    const downTarget = lower.at(last) - widthStart;
    const segments: PatternSegment[] = [
      { from: { time: timeAt(bars, from), price: upper.at(from) }, to: { time: timeAt(bars, last + PROJECTION_BARS), price: upper.at(last + PROJECTION_BARS) }, role: "boundary" },
      { from: { time: timeAt(bars, from), price: lower.at(from) }, to: { time: timeAt(bars, last + PROJECTION_BARS), price: lower.at(last + PROJECTION_BARS) }, role: "boundary" },
    ];
    const labels: PatternLabel[] = [
      { time: timeAt(bars, last + PROJECTION_BARS), price: upper.at(last + PROJECTION_BARS), text: "Resistance" },
      { time: timeAt(bars, last + PROJECTION_BARS), price: lower.at(last + PROJECTION_BARS), text: "Support" },
    ];
    // The channel edges are already on the picture, so the break level needs no line of its own;
    // a small overshoot past the edge is noise rather than the breakout that resolves the shape.
    const slack = 0.05 * range.span;
    const lastSwing = Math.max(...highs.map((pivot) => pivot.index), ...lows.map((pivot) => pivot.index));
    // A breakout only counts after the final swing. Without that rule a close through the channel
    // on the way to the last pivot would be mistaken for the resolution that comes after it.
    let brokeUp = false;
    let brokeDown = false;
    let breakIndex: number | null = null;
    for (let index = lastSwing + 1; index <= last; index += 1) {
      const close = bars[index].close;
      if (close > upper.at(index) + slack) {
        brokeUp = true;
        if (breakIndex === null) breakIndex = index;
      }
      if (close < lower.at(index) - slack) {
        brokeDown = true;
        if (breakIndex === null) breakIndex = index;
      }
    }
    // Ascending triangles and falling wedges resolve upward, the other two downward.
    const upside = kind === "ascending" || kind === "falling";
    let resolution: "up" | "down" | null = null;
    if (kind === "symmetrical") {
      // Two-sided shapes resolve whichever way price leaves the channel. A whipsaw through both
      // sides is noise rather than a usable measured move.
      if (brokeUp && brokeDown) continue;
      if (brokeUp) resolution = "up";
      else if (brokeDown) resolution = "down";
    } else {
      // A close through the side the shape does not resolve towards is a failure, not a breakout.
      if (upside ? brokeDown : brokeUp) continue;
      if (upside ? brokeUp : brokeDown) resolution = upside ? "up" : "down";
    }
    const forming = resolution === null;
    const breakWord = resolution === "up" || (resolution === null && upside) ? "above" : "below";
    const level = breakWord === "above" ? upper.at(last) : lower.at(last);
    // Once the break has happened there is nothing left to wait for, so no trigger is named.
    const trigger = !forming ? undefined : kind === "symmetrical"
      ? `Close outside ${priceText(lower.at(last))}–${priceText(upper.at(last))} to confirm.`
      : `Close ${breakWord} ${priceText(level)} to confirm.`;
    let summary = `${choice.label} over ${last - from} bars closing ${Math.round((1 - widthEnd / widthStart) * 100)}%`;
    summary += forming
      ? ` · break ${kind === "symmetrical" ? `outside ${priceText(lower.at(last))}–${priceText(upper.at(last))}` : `${breakWord} ${priceText(level)}`}`
      : ` · broke ${resolution === "up" ? "above" : "below"} ${priceText(resolution === "up" ? upper.at(last) : lower.at(last))}`;
    // A symmetrical triangle can go either way, so both measured moves are projected.
    const targets: { price: number; text: string }[] = kind === "symmetrical"
      ? [{ price: upTarget, text: "Target up" }, { price: downTarget, text: "Target down" }]
      : [{ price: upside ? upTarget : downTarget, text: "Target" }];
    for (const item of targets) {
      segments.push({ from: { time: timeAt(bars, from), price: item.price }, to: { time: timeAt(bars, last + PROJECTION_BARS), price: item.price }, role: "target" });
      labels.push({ time: timeAt(bars, last + PROJECTION_BARS), price: item.price, text: item.text });
    }
    summary += ` · target ${targets.map((item) => priceText(item.price)).join(" / ")}`;
    // A symmetrical triangle inherits its direction from the side that actually broke.
    const bias = kind === "symmetrical" && resolution
      ? resolution === "up" ? "bullish" : "bearish"
      : choice.bias;
    const entry = forming
      ? trigger
      : `Break ${resolution === "up" ? "above" : "below"} ${priceText(resolution === "up" ? upper.at(breakIndex ?? last) : lower.at(breakIndex ?? last))} confirmed.`;
    // The pattern's thesis fails when price closes back through the side it broke from. A
    // symmetrical triangle with no resolution yet has no side, so neither edge invalidates it;
    // only a close back inside the channel after a breakout undoes that breakout.
    const invalidation = forming && kind === "symmetrical"
      ? `A close back inside ${priceText(lower.at(last))}–${priceText(upper.at(last))} invalidates a breakout.`
      : bias === "bullish"
        ? `Close back below ${priceText(lower.at(last))} invalidates the upside setup.`
        : `Close back above ${priceText(upper.at(last))} invalidates the downside setup.`;
    best = {
      score,
      result: {
        key: choice.value, label: choice.label, bias, segments, forming, trigger, entry, invalidation,
        markers: [
          ...highs.map((pivot) => ({ time: timeAt(bars, pivot.index), price: pivot.price, kind: "peak" as const })),
          ...lows.map((pivot) => ({ time: timeAt(bars, pivot.index), price: pivot.price, kind: "trough" as const })),
        ],
        labels, summary,
      },
    };
  }
  return best?.result ?? null;
}

/** How far the flat side of a triangle may drift, as a share of the shape's opening width. */
const FLAT_SIDE_DRIFT = 0.06;
/** How much the converging side of a triangle must move to count, same unit. */
const CONVERGING_SIDE_DRIFT = 0.3;
/** Both sides of a wedge have to move clearly; only the closing angle separates it from noise. */
const WEDGE_SIDE_DRIFT = 0.15;

/**
 * A triangle has one flat side and one closing side; a wedge has both sides moving the same
 * way. Holding the flat side genuinely flat is what keeps the five shapes apart — a loose
 * tolerance lets a rising floor pass as a "descending triangle" and the picture contradicts
 * its own title.
 */
function matchesConvergence(kind: "ascending" | "descending" | "symmetrical" | "rising" | "falling", upperDrift: number, lowerDrift: number, widthStart: number) {
  switch (kind) {
    case "ascending": return Math.abs(upperDrift) <= FLAT_SIDE_DRIFT * widthStart && lowerDrift >= CONVERGING_SIDE_DRIFT * widthStart;
    case "descending": return Math.abs(lowerDrift) <= FLAT_SIDE_DRIFT * widthStart && upperDrift <= -CONVERGING_SIDE_DRIFT * widthStart;
    case "symmetrical": return upperDrift <= -WEDGE_SIDE_DRIFT * widthStart && lowerDrift >= WEDGE_SIDE_DRIFT * widthStart;
    case "rising": return upperDrift >= WEDGE_SIDE_DRIFT * widthStart && lowerDrift >= WEDGE_SIDE_DRIFT * widthStart && upperDrift < lowerDrift;
    case "falling": return upperDrift <= -WEDGE_SIDE_DRIFT * widthStart && lowerDrift <= -WEDGE_SIDE_DRIFT * widthStart && upperDrift < lowerDrift;
  }
}

/** The stretch of time a match covers, including any projected target line. */
function patternSpan(match: PatternMatch) {
  let first = Infinity;
  let last = -Infinity;
  const include = (time: number) => {
    if (time < first) first = time;
    if (time > last) last = time;
  };
  for (const segment of match.segments) { include(segment.from.time); include(segment.to.time); }
  for (const marker of match.markers) include(marker.time);
  for (const label of match.labels) include(label.time);
  return last > first ? last - first : 0;
}

/**
 * Picks the most useful match for the chart overlay when Auto finds several. Confirmed shapes
 * beat partial ones, and among equals the widest structure wins: a descending triangle should not
 * lose its place to a small double top that is only one part of it.
 */
export function bestPattern(matches: readonly PatternMatch[]): PatternMatch | null {
  return [...matches].sort((a, b) =>
    Number(a.forming) - Number(b.forming) || patternSpan(b) - patternSpan(a),
  )[0] ?? null;
}

/**
 * Looks for the requested patterns in the given bars, which are normally the latest 50 candles,
 * and returns the matches in the order the keys were given. A single swing scan is shared
 * by the whole batch, so asking for every pattern costs little more than asking for one.
 */
export function detectPatterns(keys: readonly PatternKey[], bars: PatternBar[]): PatternMatch[] {
  if (bars.length < 30) return [];
  const swings = swingPivots(bars, 3);
  // Two swings are enough for a forming double top/bottom: the first top and the reaction that
  // is still waiting for its second top. Each detector asks for the swings its own shape needs.
  if (swings.length < 2) return [];
  const found = keys.flatMap((key) => {
    const choice = choices.get(key);
    if (!choice) return [];
    const built = buildMatch(key, bars, swings);
    if (!built) return [];
    const range = priceRange(bars);
    // Anything drawn far outside the range the user is looking at would be noise on the picture.
    const floor = range.low - 0.25 * range.span;
    const ceiling = range.high + 0.25 * range.span;
    const inside = (point: { price: number }) => point.price >= floor && point.price <= ceiling;
    return [{
      ...built,
      label: choice.label,
      segments: built.segments.filter((segment) => inside(segment.from) && inside(segment.to)),
      markers: built.markers.filter(inside),
      labels: built.labels.filter(inside),
    }];
  });
  return found;
}

function buildMatch(key: PatternKey, bars: PatternBar[], swings: Pivot[]): PatternMatch | null {
  switch (key) {
    case "head_and_shoulders": {
      const group = findThreeSwing(bars, swings, "peak");
      return group ? buildThreeSwing(key, bars, group) : null;
    }
    case "inverse_head_and_shoulders": {
      const group = findThreeSwing(bars, swings, "trough");
      return group ? buildThreeSwing(key, bars, group) : null;
    }
    case "double_top": {
      const group = findDoubleSwing(bars, swings, "peak");
      return group ? buildDoubleSwing(key, bars, group) : null;
    }
    case "double_bottom": {
      const group = findDoubleSwing(bars, swings, "trough");
      return group ? buildDoubleSwing(key, bars, group) : null;
    }
    case "bull_flag":
    case "bear_flag":
      return findFlag(bars, key);
    case "ascending_triangle":
      return findConvergence(bars, swings, "ascending");
    case "descending_triangle":
      return findConvergence(bars, swings, "descending");
    case "symmetrical_triangle":
      return findConvergence(bars, swings, "symmetrical");
    case "rising_wedge":
      return findConvergence(bars, swings, "rising");
    case "falling_wedge":
      return findConvergence(bars, swings, "falling");
  }
}

export function patternFileName(key: PatternKey, symbol: string, timeframe: string) {
  return `${symbol}-${timeframe}-${key.replace(/_/g, "-")}.png`.toLowerCase();
}
