export type AlertItem = {
  id: number;
  symbol: string;
  kind: "price" | "pattern" | "trend_recovery" | "swing_detection";
  condition: string;
  price: string | null;
  timeframe: string;
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

export type AlertKind = "price" | "pattern" | "trend_recovery" | "swing_detection";
export type RecoveryTrigger = "sma" | "ema";
