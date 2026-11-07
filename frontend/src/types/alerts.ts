export type AlertItem = {
  id: number;
  symbol: string;
  kind: "price" | "macd" | "pattern" | "trend_recovery";
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
  pattern_state?: "idle" | "forming" | "entered";
  pattern_key?: string;
  pattern_bias?: string;
  pattern_target?: number | null;
  pattern_last_bar_time?: string | null;
  recovery_trigger?: "sma" | "ema";
  recovery_last_bar_time?: string | null;
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

export type AlertKind = "price" | "macd" | "pattern" | "trend_recovery";
export type RecoveryTrigger = "sma" | "ema";
export type RsiSettings = { period: string; oversold: string; overbought: string };
