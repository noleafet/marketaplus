import { describe, expect, it } from "vitest";
import type { Drawing } from "@/types/market";
import { distanceToSegment, hitTestDrawings, lineValue } from "../chart";

describe("distanceToSegment", () => {
  it("measures perpendicular distance to the middle of a segment", () => {
    expect(distanceToSegment(50, 103, 0, 100, 100, 100)).toBeCloseTo(3, 10);
  });

  it("clamps to the nearest endpoint", () => {
    // Points beyond the end measure from the end, not from the infinite line.
    expect(distanceToSegment(130, 100, 0, 100, 100, 100)).toBeCloseTo(30, 10);
    expect(distanceToSegment(-10, 103, 0, 100, 100, 100)).toBeCloseTo(Math.hypot(10, 3), 10);
  });
});

describe("hitTestDrawings", () => {
  const lines = [
    { id: "upper", x1: 0, y1: 10, x2: 100, y2: 10 },
    { id: "lower", x1: 0, y1: 30, x2: 100, y2: 30 },
  ];

  it("returns the nearest line inside the threshold", () => {
    expect(hitTestDrawings(lines, 50, 26, 8)).toBe("lower");
    expect(hitTestDrawings(lines, 50, 14, 8)).toBe("upper");
  });

  it("returns null when every line is out of reach", () => {
    expect(hitTestDrawings(lines, 50, 20, 8)).toBeNull();
    expect(hitTestDrawings([], 50, 20, 8)).toBeNull();
  });
});

describe("lineValue", () => {
  const trend: Drawing = {
    id: "trend",
    symbol: "BTCUSDT",
    type: "trend",
    t1: 100,
    p1: 10,
    t2: 200,
    p2: 20,
    hidden: false,
    width: 1,
    opacity: 1,
  };

  it("interpolates a trend line in time", () => {
    expect(lineValue(trend, 150)).toBeCloseTo(15, 10);
  });

  it("stops a non-extended trend line at its last point", () => {
    expect(lineValue(trend, 250)).toBeNull();
  });

  it("keeps extending a trend line that is marked extend", () => {
    expect(lineValue({ ...trend, extend: true }, 300)).toBeCloseTo(30, 10);
  });

  it("returns a horizontal line's price at any time", () => {
    expect(lineValue({ ...trend, type: "hline", p1: 42 }, 999)).toBe(42);
  });

  it("only starts a ray at its anchor", () => {
    expect(lineValue({ ...trend, type: "hray", p1: 42 }, 50)).toBeNull();
    expect(lineValue({ ...trend, type: "hray", p1: 42 }, 150)).toBe(42);
  });
});
