import { intervals } from "@/types/market";

export const conditions: Record<string, string> = {
  cross_up: "crosses above",
  cross_down: "crosses below",
  cross: "crosses",
  above: "is above",
  below: "is below",
};

export const timeframes = intervals;
/** Intervals offered for the MACD and EMA cross alert RSI/MACD context. */
export const contextTimeframes = ["5m", "15m", "1h", "4h", "1d"] as const;
export type ContextTimeframe = (typeof contextTimeframes)[number];

export const defaultRsiSettings = {
  period: "14",
  oversold: "30",
  overbought: "70",
};
