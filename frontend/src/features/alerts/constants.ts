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

/** 1H MACD trigger configurations for the trend recovery alert. */
export const recoveryTriggers: Record<string, string> = {
  sma: "SMA 3/10",
  ema: "EMA 12/100",
};
