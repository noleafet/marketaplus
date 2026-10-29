import type { UTCTimestamp } from "lightweight-charts";
import { describe, expect, it } from "vitest";
import type { Bar } from "@/types/market";
import { findKeyLevels, MIN_DISPLAY_STRENGTH } from "../key-levels";

/**
 * A repeating 105/95 zigzag. Every peak and trough is a clean swing, so the detector has many
 * independent reactions at exactly the same two prices to cluster.
 */
function zigzag(cycles: number, tail: number[] = []): Bar[] {
  const prices = [100, 102, 105, 103, 98, 95];
  const rows = [...Array.from({ length: cycles }, () => prices).flat(), ...tail];
  return rows.map((price, index) => {
    const bearish = price === 105;
    const bullish = price === 95;
    return {
      time: (1_700_000_000 + index * 3600) as UTCTimestamp,
      open: bearish ? price + 0.2 : price,
      high: price + 0.5,
      low: price - 0.5,
      close: bearish ? price - 0.2 : bullish ? price + 0.2 : price,
      volume: 100,
    };
  });
}

describe("findKeyLevels", () => {
  it("finds the repeated swing lows as support and swing highs as resistance", () => {
    // Ten full cycles then the start of an eleventh: the last close is 103, between both levels.
    const levels = findKeyLevels(zigzag(10, [100, 102, 105, 103]));

    expect(levels.supports).toHaveLength(1);
    expect(levels.resistances).toHaveLength(1);

    const [support] = levels.supports;
    const [resistance] = levels.resistances;
    expect(support.price).toBeGreaterThan(94);
    expect(support.price).toBeLessThan(96);
    expect(resistance.price).toBeGreaterThan(104);
    expect(resistance.price).toBeLessThan(106);
    expect(support.strength).toBeGreaterThanOrEqual(MIN_DISPLAY_STRENGTH);
    expect(resistance.strength).toBeGreaterThanOrEqual(MIN_DISPLAY_STRENGTH);
    // The band is drawn around the centre, and each level stays on its own side of price.
    expect(support.low).toBeLessThanOrEqual(support.price);
    expect(support.high).toBeGreaterThanOrEqual(support.price);
    expect(support.price).toBeLessThanOrEqual(103);
    expect(resistance.price).toBeGreaterThanOrEqual(103);
    expect(support.reactions).toBeGreaterThan(1);
    expect(resistance.reactions).toBeGreaterThan(1);
  });

  it("returns nothing for a very short series", () => {
    expect(findKeyLevels(zigzag(2))).toEqual({ supports: [], resistances: [] });
  });

  it("returns nothing when there are no swings to react to", () => {
    const rising = Array.from({ length: 40 }, (_, index) => ({
      time: (1_700_000_000 + index * 3600) as UTCTimestamp,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 100,
    }));
    expect(findKeyLevels(rising)).toEqual({ supports: [], resistances: [] });
  });
});
