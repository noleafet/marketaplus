/** Mirror the serializer rules so bad combinations fail before the request. */
function rsiSettingsErrors(input: {
  rsiEnabled: boolean;
  rsi: { period: string; oversold: string; overbought: string };
}) {
  const errors: Record<string, string> = {};
  if (!input.rsiEnabled) return errors;
  const period = Number(input.rsi.period);
  const oversold = Number(input.rsi.oversold);
  const overbought = Number(input.rsi.overbought);
  if (!Number.isInteger(period) || period < 2 || period > 100) {
    errors.rsi_period = "Use a whole number between 2 and 100.";
  }
  if (!Number.isFinite(oversold) || oversold < 0 || oversold > 100) {
    errors.rsi_oversold = "Use a value between 0 and 100.";
  }
  if (!Number.isFinite(overbought) || overbought < 0 || overbought > 100) {
    errors.rsi_overbought = "Use a value between 0 and 100.";
  }
  if (!errors.rsi_oversold && !errors.rsi_overbought && oversold >= overbought) {
    errors.rsi_oversold = "Oversold must be lower than overbought.";
  }
  return errors;
}

export function macdFieldErrors(input: {
  rsiEnabled: boolean;
  rsi: { period: string; oversold: string; overbought: string };
  trendEnabled: boolean;
  trendPeriod: string;
}) {
  const errors = rsiSettingsErrors(input);
  if (input.trendEnabled) {
    const period = Number(input.trendPeriod);
    if (!Number.isInteger(period) || period < 2 || period > 500) {
      errors.trend_period = "Use a whole number between 2 and 500.";
    }
  }
  return errors;
}

export function emaFieldErrors(input: {
  rsiEnabled: boolean;
  rsi: { period: string; oversold: string; overbought: string };
}) {
  return rsiSettingsErrors(input);
}
