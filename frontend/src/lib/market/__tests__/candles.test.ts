import type { UTCTimestamp } from "lightweight-charts";
import { describe, expect, it } from "vitest";
import type { Bar } from "@/types/market";
import { closedBars, isCandleClosed, liveBarIndex, mergeBars } from "../candles";

const NOW = 1_000_000;
const HOUR = 3600;

function bar(time: number, close = 100): Bar {
  return { time: time as UTCTimestamp, open: close, high: close + 1, low: close - 1, close, volume: 1 };
}

describe("isCandleClosed", () => {
  it("counts a candle closed once its interval has elapsed", () => {
    expect(isCandleClosed(bar(NOW - HOUR), "1h", NOW)).toBe(true);
    expect(isCandleClosed(bar(NOW - HOUR + 1), "1h", NOW)).toBe(false);
  });

  it("uses the selected timeframe's interval", () => {
    expect(isCandleClosed(bar(NOW - 300), "5m", NOW)).toBe(true);
    expect(isCandleClosed(bar(NOW - 300), "1h", NOW)).toBe(false);
  });
});

describe("closedBars", () => {
  it("drops the still-forming newest candle", () => {
    const bars = [bar(NOW - 3 * HOUR), bar(NOW - 2 * HOUR), bar(NOW - HOUR + 10)];
    expect(closedBars(bars, "1h", NOW).map((item) => item.time)).toEqual([
      NOW - 3 * HOUR,
      NOW - 2 * HOUR,
    ]);
  });

  it("keeps every closed candle", () => {
    const bars = [bar(NOW - 3 * HOUR), bar(NOW - 2 * HOUR), bar(NOW - HOUR)];
    expect(closedBars(bars, "1h", NOW)).toHaveLength(3);
  });
});

describe("liveBarIndex", () => {
  it("points at the last candle only while it is still forming", () => {
    expect(liveBarIndex([bar(NOW - 3 * HOUR), bar(NOW - 2 * HOUR), bar(NOW - HOUR + 10)], "1h", NOW)).toBe(2);
    expect(liveBarIndex([bar(NOW - 3 * HOUR), bar(NOW - 2 * HOUR)], "1h", NOW)).toBe(-1);
    expect(liveBarIndex([], "1h", NOW)).toBe(-1);
  });
});

describe("mergeBars", () => {
  it("replaces an updated candle and appends a newer one in time order", () => {
    const existing = [bar(100, 1), bar(200, 2)];
    const merged = mergeBars([bar(200, 3), bar(300, 4)], existing);
    expect(merged.map((item) => [item.time, item.close])).toEqual([
      [100, 1],
      [200, 3],
      [300, 4],
    ]);
  });

  it("ignores older candles unless keepOlder is set", () => {
    const existing = [bar(200, 2), bar(300, 3)];
    expect(mergeBars([bar(100, 1)], existing)).toHaveLength(2);
    expect(mergeBars([bar(100, 1)], existing, true).map((item) => item.time)).toEqual([100, 200, 300]);
  });

  it("deduplicates history pages that overlap the first stored candle", () => {
    const existing = [bar(200, 2), bar(300, 3)];
    const merged = mergeBars([bar(100, 1), bar(200, 2)], existing, true);
    expect(merged).toHaveLength(3);
    expect(merged.map((item) => item.time)).toEqual([100, 200, 300]);
  });
});
