import { describe, expect, it } from "vitest";
import type { PatternBar } from "../pattern-analysis";
import { bestPattern, detectPatterns } from "../pattern-analysis";

const START = 1_700_000_000;
const HOUR = 3600;

function bar(index: number, price: number): PatternBar {
  return {
    time: START + index * HOUR,
    open: price,
    high: price + 0.5,
    low: price - 0.5,
    close: price,
  };
}

/**
 * 100 -> 110 -> 100 -> 110 -> a slide through 100 to 95. The two tops are exactly level and the
 * final leg closes well below the reaction low, so the double top is complete rather than forming.
 */
function doubleTopBars(): PatternBar[] {
  const prices: number[] = [];
  for (let index = 0; index <= 10; index += 1) prices.push(100 + index);
  for (let index = 11; index <= 20; index += 1) prices.push(110 - (index - 10));
  for (let index = 21; index <= 30; index += 1) prices.push(100 + (index - 20));
  for (let index = 31; index <= 69; index += 1) prices.push(110 - (index - 30) * 0.375);
  return prices.map((price, index) => bar(index, price));
}

describe("detectPatterns", () => {
  it("reports a completed double top with entry and invalidation", () => {
    const matches = detectPatterns(["double_top"], doubleTopBars());
    expect(matches).toHaveLength(1);

    const match = matches[0];
    expect(match.key).toBe("double_top");
    expect(match.label).toBe("Double Top");
    expect(match.bias).toBe("bearish");
    expect(match.forming).toBe(false);
    expect(match.entry).toMatch(/Reaction level broke/);
    expect(match.invalidation).toContain("110");
    expect(match.summary).toContain("Double Top");

    // Two tops at 110.5 (the bar high) and the reaction low between them.
    const peaks = match.markers.filter((marker) => marker.kind === "peak");
    expect(peaks).toHaveLength(2);
    expect(peaks[0].price).toBeCloseTo(110.5, 10);
    expect(peaks[1].price).toBeCloseTo(110.5, 10);
    expect(peaks[0].time).toBe(START + 10 * HOUR);
    expect(peaks[1].time).toBe(START + 30 * HOUR);

    const roles = new Set(match.segments.map((segment) => segment.role));
    expect(roles.has("outline")).toBe(true);
    expect(roles.has("boundary")).toBe(true);
    // Every retained point is inside the chart's price range (plus the 25% margin).
    for (const segment of match.segments) {
      for (const point of [segment.from, segment.to]) {
        expect(point.price).toBeGreaterThanOrEqual(94.875 - 0.25 * 15.625);
        expect(point.price).toBeLessThanOrEqual(110.5 + 0.25 * 15.625);
      }
    }
  });

  it("marks a double top as forming while the second top is missing", () => {
    // First top, a deep reaction, and a recovery that has not reached the first top yet. The
    // mirrored second top would fall beyond the newest bar, so it is still a projection.
    const prices: number[] = [];
    for (let index = 0; index <= 10; index += 1) prices.push(100 + index);
    for (let index = 11; index <= 30; index += 1) prices.push(110 - ((index - 10) * 10) / 20);
    for (let index = 31; index <= 39; index += 1) prices.push(100 + ((index - 30) * 5) / 9);
    const matches = detectPatterns(["double_top"], prices.map((price, index) => bar(index, price)));

    expect(matches).toHaveLength(1);
    expect(matches[0].forming).toBe(true);
    expect(matches[0].trigger).toMatch(/to confirm/);
    expect(matches[0].entry).toBe(matches[0].trigger);
    expect(matches[0].segments.some((segment) => segment.role === "projection")).toBe(true);
  });

  it("returns nothing for fewer than thirty bars", () => {
    expect(detectPatterns(["double_top"], doubleTopBars().slice(0, 20))).toEqual([]);
  });

  it("returns the requested patterns in the order asked for", () => {
    const matches = detectPatterns(["double_top", "double_bottom"], doubleTopBars());
    expect(matches.map((match) => match.key)).toEqual(["double_top"]);
  });
});

describe("bestPattern", () => {
  it("prefers a confirmed shape over a forming one, then the wider structure", () => {
    const [confirmed] = detectPatterns(["double_top"], doubleTopBars());
    const forming = { ...confirmed, forming: true, key: "double_bottom" as const };
    const wider = { ...confirmed, key: "head_and_shoulders" as const };
    expect(bestPattern([forming, confirmed])).toBe(confirmed);
    expect(bestPattern([forming])).toBe(forming);
    expect(bestPattern([])).toBeNull();
    // Equal status: both spans come from the same geometry, so the stable sort keeps the first.
    expect(bestPattern([confirmed, wider])).toBe(confirmed);
  });
});
