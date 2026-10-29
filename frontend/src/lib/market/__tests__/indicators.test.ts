import type { UTCTimestamp } from "lightweight-charts";
import { describe, expect, it } from "vitest";
import type { Bar } from "@/types/market";
import {
  atr, bollingerBands, ema, heikinAshi, indicatorPoints, macdValues, rsi,
} from "../indicators";

function bar(time: number, open: number, high: number, low: number, close: number): Bar {
  return { time: time as UTCTimestamp, open, high, low, close, volume: 1 };
}

function flatBars(count: number, range = 2): Bar[] {
  return Array.from({ length: count }, (_, index) => bar(index, 100, 100 + range / 2, 100 - range / 2, 100));
}

describe("ema", () => {
  it("seeds with the SMA and then applies the smoothing factor", () => {
    // alpha = 2 / (3 + 1) = 0.5; on 1..6 the values happen to land on the input.
    expect(ema([1, 2, 3, 4, 5, 6], 3)).toEqual([null, null, 2, 3, 4, 5]);
  });

  it("leaves values before the seed empty", () => {
    expect(ema([10, 20, 30, 40], 3)).toEqual([null, null, 20, 30]);
  });
});

describe("rsi", () => {
  it("matches Wilder's classic 14-period reference value", () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64,
      46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
      43.42, 42.66, 43.13,
    ];
    const values = rsi(closes, 14);
    expect(values[13]).toBeNull();
    expect(values[14]).toBeCloseTo(70.46413502109705, 10);
  });

  it("is 100 when every change is a gain", () => {
    const values = rsi(Array.from({ length: 20 }, (_, index) => 100 + index), 14);
    expect(values[19]).toBe(100);
  });

  it("returns all null when there are not enough closes", () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });
});

describe("atr", () => {
  it("seeds the Wilder average at the period and stays at the true range", () => {
    const values = atr(flatBars(20), 14);
    expect(values[12]).toBeNull();
    expect(values[13]).toBe(2);
    expect(values[19]).toBe(2);
  });

  it("includes the gap from the previous close in the true range", () => {
    const bars = [
      bar(0, 100, 101, 99, 100),
      bar(1, 110, 111, 109, 110),
      bar(2, 110, 111, 109, 110),
    ];
    const values = atr(bars, 2);
    // TR2 = max(2, |111 - 100|, |109 - 100|) = 11; TR3 = max(2, 1, 1) = 2.
    expect(values[1]).toBeCloseTo((2 + 11) / 2, 10);
    expect(values[2]).toBeCloseTo((6.5 + 2) / 2, 10);
  });
});

describe("macdValues", () => {
  it("converges to 7 on a linear 1..40 series, with a flat signal and zero histogram", () => {
    const closes = Array.from({ length: 40 }, (_, index) => index + 1);
    const { line, signal, histogram } = macdValues(closes);
    expect(line[39]).toBeCloseTo(7, 10);
    expect(signal[39]).toBeCloseTo(7, 6);
    expect(histogram[39]).toBeCloseTo(0, 6);
    // The slow EMA is the last to seed, so nothing is reported before it.
    expect(line[24]).toBeNull();
    expect(line[25]).not.toBeNull();
  });
});

describe("bollingerBands", () => {
  it("uses a population standard deviation around the SMA", () => {
    const bars = [1, 2, 3, 4, 5].map((price, index) => bar(index, price, price, price, price));
    const { middle, upper, lower } = bollingerBands(bars, 5, 2);
    const deviation = Math.sqrt(2);
    expect(middle[4]).toBeCloseTo(3, 10);
    expect(upper[4]).toBeCloseTo(3 + 2 * deviation, 10);
    expect(lower[4]).toBeCloseTo(3 - 2 * deviation, 10);
    expect(middle[3]).toBeNull();
  });
});

describe("indicatorPoints", () => {
  it("drops empty readings and keeps bar timestamps", () => {
    const bars = [bar(10, 1, 1, 1, 1), bar(20, 1, 1, 1, 1), bar(30, 1, 1, 1, 1)];
    expect(indicatorPoints(bars, [null, 2, 3])).toEqual([
      { time: 20, value: 2 },
      { time: 30, value: 3 },
    ]);
  });
});

describe("heikinAshi", () => {
  it("averages the first candle and chains the open of the next one", () => {
    const bars = [bar(0, 10, 12, 9, 11), bar(1, 11, 13, 10, 12)];
    const candles = heikinAshi(bars);
    // Bar 1: close (10+12+9+11)/4 = 10.5, open (10+11)/2 = 10.5.
    expect(candles[0].open).toBe(10.5);
    expect(candles[0].close).toBe(10.5);
    expect(candles[0].high).toBe(12);
    expect(candles[0].low).toBe(9);
    // Bar 2: close (11+13+10+12)/4 = 11.5, open (10.5+10.5)/2 = 10.5.
    expect(candles[1].close).toBe(11.5);
    expect(candles[1].open).toBe(10.5);
    expect(candles[1].high).toBe(13);
    expect(candles[1].low).toBe(10);
  });
});
