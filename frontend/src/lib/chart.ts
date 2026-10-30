import type { IChartApi, Logical, UTCTimestamp } from "lightweight-charts";
import type { Bar, Drawing, Preferences } from "@/types/market";
import { intervalSeconds } from "./market/constants";

export function lineValue(line: Drawing, time: number) {
  if (line.type === "hline") return line.p1;
  if (time < line.t1) return null;
  if (line.type === "hray") return line.p1;
  if (line.type === "trend" && !line.extend && time > (line.t2 ?? line.t1)) {
    return null;
  }
  if (line.t2 === undefined || line.p2 === undefined || line.t2 === line.t1) {
    return null;
  }
  return line.p1 + ((line.p2 - line.p1) * (time - line.t1)) / (line.t2 - line.t1);
}

export function drawingCoordinate(
  chart: IChartApi,
  time: number,
  data: Bar[],
  timeframe: Preferences["timeframe"],
) {
  const scale = chart.timeScale();
  const coordinate = scale.timeToCoordinate(time as UTCTimestamp);
  if (coordinate !== null) return coordinate;
  const first = data[0];
  if (!first || time < Number(first.time)) return null;
  // Times that sit between the loaded bars - a 4H pivot on a 1D chart, for example - are not in
  // the time scale, so interpolate from the bar just before them using the chart's bar spacing.
  let low = 0;
  let high = data.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Number(data[mid].time) <= time) low = mid;
    else high = mid - 1;
  }
  const logical =
    low + (time - Number(data[low].time)) / intervalSeconds[timeframe];
  // The library maps whole bar indexes only: a fractional logical - a 4H pivot on a 1D chart, or
  // any time past the newest bar - is rejected and collapses to x = 0. Interpolate between the
  // two whole indexes instead, which keeps cross-timeframe drawings and projections on the chart.
  const base = Math.floor(logical);
  const before = scale.logicalToCoordinate(base as Logical);
  if (before === null) return null;
  const after = scale.logicalToCoordinate((base + 1) as Logical);
  if (after === null) return before;
  return before + (logical - base) * (after - before);
}

/**
 * Copies the visible window from the price chart to an indicator pane.
 *
 * The panes are two separate charts, each sizing its own price axis from its own labels, so
 * their plot areas are not quite the same width. Carrying the bar count over and letting the
 * target spread it across its own width keeps both panes on the same stretch of time. Copying
 * the source's bar spacing instead would leave the narrower pane short of bars and slide its
 * left edge out of line with the candles above it.
 */
export function copyWindow(from: IChartApi, to: IChartApi) {
  const source = from.timeScale();
  const target = to.timeScale();
  const range = source.getVisibleLogicalRange();
  // A pane with no bars has no window to describe yet.
  if (!range) return;
  // Hidden panes report a zero width until they are shown. Applying that would squeeze every bar
  // into one pixel and the later resize would inherit a broken window.
  if (!source.width() || !target.width()) return;
  const barSpacing = target.width() / Math.max(1, range.to - range.from + 1);
  const rightOffset = source.scrollPosition();
  // Re-applying an unchanged window still invalidates the pane, so skip that no-op. Bar spacing
  // cannot be read back, but it is exactly the pane width over the visible bar count.
  const current = target.getVisibleLogicalRange();
  if (
    current &&
    Math.abs(
      target.width() / Math.max(1, current.to - current.from + 1) - barSpacing,
    ) < 1e-6 &&
    Math.abs(target.scrollPosition() - rightOffset) < 1e-9
  ) {
    return;
  }
  // Bar spacing has to go first: the right offset is clamped against it.
  target.applyOptions({ barSpacing, rightOffset });
}

/**
 * Queues a window copy for the next frame. A chart only knows its real plot width once it has
 * painted: pane width is the chart width minus the price axis, and the axis is sized from its own
 * labels. Read any earlier and timeScale().width() hands back the width that was asked for, which
 * lands the copy on the wrong bar spacing and slides the target pane out of line.
 */
const windowCopyQueued = new WeakSet<IChartApi>();

export function copyWindowSoon(from: IChartApi, to: IChartApi) {
  // A drag changes the visible range on every frame, so only one copy per pane is worth queueing.
  if (windowCopyQueued.has(to)) return;
  windowCopyQueued.add(to);
  requestAnimationFrame(() => {
    windowCopyQueued.delete(to);
    try {
      copyWindow(from, to);
    } catch {
      /* The target pane is still empty; its data pass retries. */
    }
  });
}

/** A drawing already projected into screen pixels, ready for hit-testing. */
export type ScreenLine = { id: string; x1: number; y1: number; x2: number; y2: number };

export function distanceToSegment(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared
    ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSquared))
    : 0;
  return Math.hypot(x - (x1 + fraction * dx), y - (y1 + fraction * dy));
}

/**
 * The drawing under a pointer, so a line can be selected by clicking it on the chart instead of
 * only from the side panel. The nearest line inside the threshold wins, which keeps overlapping
 * trendlines predictable.
 */
export function hitTestDrawings(
  lines: readonly ScreenLine[],
  x: number,
  y: number,
  threshold = 8,
): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const line of lines) {
    const distance = distanceToSegment(x, y, line.x1, line.y1, line.x2, line.y2);
    if (distance > threshold) continue;
    if (!best || distance < best.distance) best = { id: line.id, distance };
  }
  return best?.id ?? null;
}
