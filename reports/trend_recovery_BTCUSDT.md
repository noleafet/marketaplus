# Trend Recovery backtest — BTCUSDT

Exchange: Binance · Period: 365 days of 1h candles (8760 bars) · Generated 2026-11-07 23:12 UTC

Filters (identical for both triggers): 1D MACD EMA 19/39 and 4H MACD EMA 12/26 must both sit on the same side of zero.
A pullback needs 3+ consecutive closed 1h bars on the opposite side of zero; the early warning needs 2 consecutive improves toward zero; the confirmation is the zero-line cross.

## SMA 3/10

| Metric | All signals | In-sample (70%) | Out-of-sample (30%) |
|---|---|---|---|
| Confirmed signals | 196 | 137 | 59 |
| Early warnings | 190 | 133 | 57 |
| False-alert rate | 12.2% | 13.1% | 10.2% |
| Avg pullback bars | 9.3 | 9.7 | 8.3 |
| Avg max favorable excursion | 1.7% | 1.9% | 1.1% |
| Avg +6h return | 0.0% | 0.1% | -0.1% |
| Avg +24h return | -0.1% | -0.1% | -0.1% |
| Avg +72h return | -0.1% | 0.1% | -0.5% |
| Win rate +24h | 42.9% | 40.9% | 47.5% |

## EMA 12/100

| Metric | All signals | In-sample (70%) | Out-of-sample (30%) |
|---|---|---|---|
| Confirmed signals | 17 | 11 | 6 |
| Early warnings | 27 | 16 | 11 |
| False-alert rate | 11.8% | 0.0% | 33.3% |
| Avg pullback bars | 13.4 | 11.5 | 16.7 |
| Avg max favorable excursion | 1.0% | 1.0% | 1.0% |
| Avg +6h return | -0.6% | -0.8% | -0.1% |
| Avg +24h return | -1.0% | -1.1% | -0.7% |
| Avg +72h return | -1.4% | -1.5% | -1.1% |
| Win rate +24h | 23.5% | 27.3% | 16.7% |


## Confirmed signals by direction

| Trigger | Direction | Signals | False % | Avg pullback bars | Avg MFE % | Avg +24h % | Win +24h % |
|---|---|---|---|---|---|---|---|
| SMA 3/10 | bullish | 71 | 8.5 | 8.9 | 1.27 | -0.03 | 45.1 |
| SMA 3/10 | bearish | 125 | 14.4 | 9.5 | 1.89 | -0.16 | 41.6 |
| EMA 12/100 | bullish | 6 | 16.7 | 18.3 | 0.85 | -0.87 | 16.7 |
| EMA 12/100 | bearish | 11 | 9.1 | 10.6 | 1.09 | -1.01 | 27.3 |

## Early warning lead time

- SMA 3/10: 173 warnings led a confirmation by 4.8 bars on average
- EMA 12/100: 15 warnings led a confirmation by 45.1 bars on average
