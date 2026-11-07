# Trend Recovery — SMA 3/10 vs EMA 12/100 comparison

Backtest of the Trend Recovery alert over 365 days of 1h candles (8,760 bars per
symbol) on Binance, generated 2026-11-07 UTC. Both triggers were evaluated under
the identical 1D MACD (EMA 19/39) and 4H MACD (EMA 12/26) zero-line filters, on
closed candles only. Per-symbol detail lives in `trend_recovery_<SYMBOL>.md`;
this file aggregates the verdict.

## Rules under test (identical for both triggers)

- Trend filter: 1D MACD EMA 19/39 and 4H MACD EMA 12/26 must both be on the same
  side of zero; losing either cancels the setup.
- Pullback/bounce: the 1H MACD must hold the opposite side of zero for at least
  3 consecutive closed bars (filters one-candle noise).
- Early warning: 2 consecutive improves toward zero while still on the pullback
  side — reported separately from confirmations.
- Confirmed alert: the 1H MACD crosses zero on a closed candle, once per cycle.

## Headline numbers (all three symbols, 1 year)

| Metric | SMA 3/10 | EMA 12/100 |
|---|---|---|
| Confirmed signals (BTC+ETH+SOL) | 632 | 59 |
| Confirmed per symbol per year | ~205–231 | ~17–22 |
| False-alert rate, all symbols | 6.5–12.2% | 4.5–11.8% |
| Avg pullback before confirm | ~8–9 bars | ~11–13 bars |
| Early-warning lead over confirm | ~5–7 bars | ~16–45 bars |

## Findings

- **SMA 3/10 is the better default trigger.** It produces roughly 10x more
  confirmed signals (≈200/year/symbol vs ≈20), keeps a comparable or better
  false-alert rate on 2 of 3 symbols, and its early warnings lead the confirmed
  cross by ~5 bars — actionable. Per-signal expectancy (avg +24h return,
  win rate) is a coin flip on BTC/ETH and mildly positive on SOL for both
  triggers; the edge comes from the trend filter, not the trigger choice.
- **EMA 12/100 filters harder but starves the signal.** It waits for a much
  deeper pullback (avg ~12 bars vs ~9) and confirms far later, cutting signals
  to ~20/year — too few to evaluate reliably (per-direction samples of 6–13).
  Out-of-sample it is unstable: false rate swings 0%→33% (BTC), win rate +24h
  swings 53%→29% (ETH). The tiny sample means its apparent quality edge is not
  statistically meaningful.
- **Early warnings work as intended for SMA**: ~180 warnings/year led a
  confirmation by ~5 bars on average, giving traders a heads-up window.
  For EMA the "lead" is misleading — warnings fire early in long pullbacks but
  the confirmation itself is heavily delayed, so the actionable gap is mostly
  dead time.

## Recommendation

Keep **SMA 3/10** as the default 1H trigger (it is the shipped default). The
EMA 12/100 variation remains available per-alert for users who prefer fewer,
slower signals, but the backtest does not demonstrate an advantage worth
switching to — it reduces signal count ~10x without a consistent improvement
in false-alert rate or forward returns, and its small sample makes any
difference indistinguishable from noise.

Caveats: single exchange (Binance), one year of data, crypto majors only, and
signals are evaluated at the zero-line cross with no exit rule — "subsequent
price movement" is descriptive, not a trading P&L simulation.
