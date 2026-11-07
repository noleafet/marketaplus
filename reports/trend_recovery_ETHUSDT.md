# Trend Recovery backtest — ETHUSDT

Exchange: Binance · Period: 365 days of 1h candles (8760 bars) · Generated 2026-11-07 23:13 UTC

Filters (identical for both triggers): 1D MACD EMA 19/39 and 4H MACD EMA 12/26 must both sit on the same side of zero.
A pullback needs 3+ consecutive closed 1h bars on the opposite side of zero; the early warning needs 2 consecutive improves toward zero; the confirmation is the zero-line cross.

## SMA 3/10

| Metric | All signals | In-sample (70%) | Out-of-sample (30%) |
|---|---|---|---|
| Confirmed signals | 231 | 162 | 69 |
| Early warnings | 191 | 134 | 57 |
| False-alert rate | 6.5% | 6.2% | 7.2% |
| Avg pullback bars | 8.1 | 8.3 | 7.6 |
| Avg max favorable excursion | 2.2% | 2.3% | 2.1% |
| Avg +6h return | -0.0% | -0.1% | 0.1% |
| Avg +24h return | -0.1% | -0.2% | 0.1% |
| Avg +72h return | 0.2% | 0.2% | 0.2% |
| Win rate +24h | 44.6% | 43.8% | 46.4% |

## EMA 12/100

| Metric | All signals | In-sample (70%) | Out-of-sample (30%) |
|---|---|---|---|
| Confirmed signals | 22 | 15 | 7 |
| Early warnings | 31 | 25 | 6 |
| False-alert rate | 4.5% | 0.0% | 14.3% |
| Avg pullback bars | 11.9 | 11.6 | 12.4 |
| Avg max favorable excursion | 2.6% | 2.7% | 2.3% |
| Avg +6h return | 0.3% | 0.8% | -0.9% |
| Avg +24h return | 0.0% | 0.5% | -1.0% |
| Avg +72h return | 0.3% | 0.5% | -0.1% |
| Win rate +24h | 45.5% | 53.3% | 28.6% |


## Confirmed signals by direction

| Trigger | Direction | Signals | False % | Avg pullback bars | Avg MFE % | Avg +24h % | Win +24h % |
|---|---|---|---|---|---|---|---|
| SMA 3/10 | bullish | 100 | 8.0 | 7.8 | 1.82 | -0.08 | 44.0 |
| SMA 3/10 | bearish | 131 | 5.3 | 8.3 | 2.52 | -0.10 | 45.0 |
| EMA 12/100 | bullish | 9 | 0.0 | 12.1 | 2.73 | 0.18 | 33.3 |
| EMA 12/100 | bearish | 13 | 7.7 | 11.7 | 2.43 | -0.10 | 53.8 |

## Early warning lead time

- SMA 3/10: 180 warnings led a confirmation by 5.7 bars on average
- EMA 12/100: 19 warnings led a confirmation by 26.5 bars on average
