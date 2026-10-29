import type { UTCTimestamp } from "lightweight-charts";
import { describe, expect, it } from "vitest";
import type { Bar } from "@/types/market";
import { findTrendBias, TREND_BIAS_EXTEND_SECONDS } from "../trend-bias";

const START = 1_600_000_000;
const HOUR = 3600;

/** A sine wave carried upward by a steady drift, sampled as 1H candles. */
function driftingBars(count: number, drift = 0.05, amplitude = 3): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const price = 100 + drift * index + amplitude * Math.sin(index / 4);
    return {
      time: (START + index * HOUR) as UTCTimestamp,
      open: price,
      high: price + 0.5,
      low: price - 0.5,
      close: price,
      volume: 1,
    };
  });
}

describe("findTrendBias", () => {
  it("reads an upward channel as bullish from its own closed 1H candles", () => {
    const bars = driftingBars(260);
    const now = Number(bars[bars.length - 1].time) + HOUR;
    const bias = findTrendBias(bars, "1h", now);

    expect(bias).not.toBeNull();
    expect(bias!.timeframe).toBe("1h");
    expect(bias!.direction).toBe("bullish");
    expect(bias!.lines.map((line) => line.kind).sort()).toEqual(["high", "low"]);
    for (const line of bias!.lines) {
      expect(line.slope).toBeGreaterThan(0);
      expect(line.p2).toBeGreaterThan(line.p1);
      expect(line.t2).toBe(Number(bars[bars.length - 1].time) + TREND_BIAS_EXTEND_SECONDS);
      expect(line.pivots).toBeGreaterThanOrEqual(2);
    }
  });

  it("ignores the still-forming candle", () => {
    const bars = driftingBars(260);
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
    expect(findTrendBias(driftingBars(5), "1h")).toBeNull();
  });
});
