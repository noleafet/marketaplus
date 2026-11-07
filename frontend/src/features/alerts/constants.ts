import { intervals } from "@/types/market";

export const conditions: Record<string, string> = {
  cross_up: "crosses above",
  cross_down: "crosses below",
  cross: "crosses",
  above: "is above",
  below: "is below",
};

export const timeframes = intervals;
/** Shape names the backend pattern engine reports. */
export const patternLabels: Record<string, string> = {
  head_and_shoulders: "Head and Shoulders",
  inverse_head_and_shoulders: "Inverse Head and Shoulders",
  double_top: "Double Top",
  double_bottom: "Double Bottom",
  ascending_triangle: "Ascending Triangle",
  descending_triangle: "Descending Triangle",
  symmetrical_triangle: "Symmetrical Triangle",
  rising_wedge: "Rising Wedge",
  falling_wedge: "Falling Wedge",
};

/** Intervals offered for the MACD cross alert RSI and trend context. */
export const contextTimeframes = ["5m", "15m", "1h", "4h", "1d"] as const;
export type ContextTimeframe = (typeof contextTimeframes)[number];

/** 1H MACD trigger configurations for the trend recovery alert. */
export const recoveryTriggers: Record<string, string> = {
  sma: "SMA 3/10",
  ema: "EMA 12/100",
};

export const defaultRsiSettings = {
  period: "14",
  oversold: "30",
  overbought: "70",
};
