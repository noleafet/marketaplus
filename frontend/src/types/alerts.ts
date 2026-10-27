export type AlertItem = {
  id: number;
  symbol: string;
  kind: "price" | "macd" | "ema" | "prediction";
  condition: string;
  price: string | null;
  timeframe: string;
  rsi_timeframe?: string;
  trend_timeframe?: string;
  note: string;
  frequency: "once" | "every";
  active: boolean;
  created_at: string;
  last_triggered_at: string | null;
  line_type?: string;
  line_t1?: string;
  line_price1?: string;
  line_t2?: string | null;
  line_price2?: string | null;
  line_extend?: boolean;
  rsi_period?: number;
  rsi_oversold?: number;
  rsi_overbought?: number;
  macd_threshold_5?: boolean;
  macd_threshold_10?: boolean;
  rsi_enabled?: boolean;
  trend_enabled?: boolean;
  trend_period?: number;
  ema_period?: number;
  macd_context_enabled?: boolean;
  macd_context_timeframe?: string;
  prediction_stage_a?: boolean;
  prediction_stage_b?: boolean;
  prediction_a_state?: "idle" | "early" | "breakout";
  prediction_a_last_bar_time?: string | null;
  prediction_a_direction?: string;
  prediction_a_level?: Record<string, unknown>;
  prediction_a_score?: number | null;
  prediction_a_high_confluence?: boolean;
};

export type EventItem = {
  id: number;
  symbol: string;
  title: string;
  message: string;
  triggered_at: string;
};

export type ToastItem = {
  id: number;
  title: string;
  message: string;
};

export type AlertKind = "price" | "macd" | "ema" | "prediction";
export type RsiSettings = { period: string; oversold: string; overbought: string };
