import type { UTCTimestamp } from "lightweight-charts";
import { describe, expect, it } from "vitest";
import type { Bar } from "@/types/market";
import { findTrendBias, TREND_BIAS_EXTEND_SECONDS, type TrendBias } from "../trend-bias";

const START = 1_600_000_000;
const HOUR = 3600;

/** Straight legs between turning points, with a half-unit wick on each side. */
function zigzag(anchors: readonly (readonly [number, number])[]): Bar[] {
  const last = anchors[anchors.length - 1];
  const bars: Bar[] = [];
  for (let index = 0; index <= last[0]; index += 1) {
    let leg = 0;
    while (leg < anchors.length - 2 && anchors[leg + 1][0] <= index) leg += 1;
    const [fromIndex, fromPrice] = anchors[leg];
    const [toIndex, toPrice] = anchors[leg + 1];
    const price = fromPrice + ((toPrice - fromPrice) * (index - fromIndex)) / (toIndex - fromIndex);
    bars.push({
      time: (START + index * HOUR) as UTCTimestamp,
      open: price,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      volume: 1,
    });
  }
  return bars;
}

/** Rising zigzag: higher highs and higher lows, with both active anchors near the right edge. */
function risingBars(): Bar[] {
  return zigzag([
    [0, 10],
    [25, 30],
    [35, 26],
    [60, 50],
    [70, 44],
    [95, 70],
    [105, 64],
    [125, 90],
    [135, 86],
    [145, 96],
  ]);
}

function fallingBars(): Bar[] {
  return risingBars().map((bar) => ({
    ...bar,
    open: 200 - bar.open,
    high: 200 - bar.low,
    low: 200 - bar.high,
    close: 200 - bar.close,
  }));
}

/** Long-term highs step down while the lows since the crash step up: no single direction. */
function mixedBars(): Bar[] {
  return zigzag([
    [0, 100],
    [20, 120],
    [40, 60],
    [60, 110],
    [80, 70],
    [100, 105],
    [120, 85],
    [140, 100],
    [150, 98],
  ]);
}

function priceAt(line: TrendBias["lines"][number], time: number) {
  return line.p1 + line.slope * (time - line.t1);
}

/** Every candle from the first anchor to the right edge has to stay on the line's own side. */
function expectNoCuts(bars: Bar[], bias: TrendBias) {
  for (const line of bias.lines) {
    for (const bar of bars) {
      if (Number(bar.time) < line.t1) continue;
      const value = priceAt(line, Number(bar.time));
      if (line.kind === "high") {
        expect(bar.high - value).toBeLessThanOrEqual(value * 0.01);
        expect(Math.max(bar.open, bar.close) - value).toBeLessThanOrEqual(value * 0.0015);
      } else {
        expect(value - bar.low).toBeLessThanOrEqual(value * 0.01);
        expect(value - Math.min(bar.open, bar.close)).toBeLessThanOrEqual(value * 0.0015);
      }
    }
  }
}

describe("findTrendBias", () => {
  it("reads a rising zigzag as bullish from two anchored lines", () => {
    const bars = risingBars();
    const bias = findTrendBias(bars, "1h", Number(bars[bars.length - 1].time) + HOUR);

    expect(bias).not.toBeNull();
    expect(bias!.direction).toBe("bullish");
    expect(bias!.lines.map((line) => line.kind).sort()).toEqual(["high", "low"]);
    for (const line of bias!.lines) {
      expect(line.slope).toBeGreaterThan(0);
      expect(line.p2).toBeGreaterThan(line.p1);
      expect(line.t2).toBe(Number(bars[bars.length - 1].time) + TREND_BIAS_EXTEND_SECONDS);
      expect(line.pivots).toBeGreaterThanOrEqual(2);
    }
    expectNoCuts(bars, bias!);
  });

  it("anchors each line on a real bar extreme", () => {
    const bars = risingBars();
    const bias = findTrendBias(bars, "1h", Number(bars[bars.length - 1].time) + HOUR)!;

    for (const line of bias.lines) {
      const anchor = bars.find((bar) => Number(bar.time) === line.t1);
      expect(anchor).toBeDefined();
      const extreme = line.kind === "high" ? anchor!.high : anchor!.low;
      expect(line.p1).toBeCloseTo(extreme, 10);
      // The anchor is a swing pivot: five bars either side stay inside it.
      const index = bars.indexOf(anchor!);
      for (let offset = 1; offset <= 5; offset += 1) {
        const before = bars[index - offset];
        const after = bars[index + offset];
        if (line.kind === "high") {
          expect(before.high).toBeLessThan(anchor!.high);
          expect(after.high).toBeLessThan(anchor!.high);
        } else {
          expect(before.low).toBeGreaterThan(anchor!.low);
          expect(after.low).toBeGreaterThan(anchor!.low);
        }
      }
    }
  });

  it("reads a falling zigzag as bearish without cutting through the candles", () => {
    const bars = fallingBars();
    const bias = findTrendBias(bars, "1h", Number(bars[bars.length - 1].time) + HOUR);

    expect(bias).not.toBeNull();
    expect(bias!.direction).toBe("bearish");
    for (const line of bias!.lines) expect(line.slope).toBeLessThan(0);
    expectNoCuts(bars, bias!);
  });

  it("calls a falling ceiling with a rising floor neutral", () => {
    const bars = mixedBars();
    const bias = findTrendBias(bars, "1h", Number(bars[bars.length - 1].time) + HOUR);

    expect(bias).not.toBeNull();
    expect(bias!.direction).toBe("neutral");
    expect(bias!.lines).toHaveLength(2);
    expect(Math.sign(bias!.lines[0].slope)).toBe(-Math.sign(bias!.lines[1].slope));
    expectNoCuts(bars, bias!);
  });

  it("does not use an anchor that price has since cut through", () => {
    // A steady rise, then a collapse back through the rising floor. The old floor cannot be
    // redrawn as support; the line that cut through the sell-off is dropped instead.
    const bars = zigzag([
      [0, 50],
      [20, 60],
      [40, 90],
      [60, 70],
      [80, 110],
      [100, 60],
      [120, 45],
      [150, 55],
      [160, 52],
    ]);
    const bias = findTrendBias(bars, "1h", Number(bars[bars.length - 1].time) + HOUR);
    if (bias) expectNoCuts(bars, bias);
  });

  it("ignores the still-forming candle", () => {
    const bars = risingBars();
    const lastTime = Number(bars[bars.length - 1].time);
    // The next 1H candle has started but has not closed yet, and it is crashing.
    const live: Bar = {
      time: (lastTime + HOUR) as UTCTimestamp,
      open: 400,
      high: 401,
      low: 50,
      close: 60,
      volume: 1,
    };
    const now = lastTime + HOUR;
    const closedOnly = findTrendBias(bars, "1h", now);
    const withLive = findTrendBias([...bars, live], "1h", now);
    expect(withLive).toEqual(closedOnly);
  });

  it("returns null when there is not enough closed history", () => {
    expect(findTrendBias(zigzag([[0, 100], [5, 110], [10, 105], [15, 120]]), "1h")).toBeNull();
  });
});
