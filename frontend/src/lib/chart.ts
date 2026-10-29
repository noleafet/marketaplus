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
  return scale.logicalToCoordinate(logical as Logical);
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
