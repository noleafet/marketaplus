# Trend Recovery backtest — SOLUSDT

Exchange: Binance · Period: 365 days of 1h candles (8760 bars) · Generated 2026-11-07 23:13 UTC

Filters (identical for both triggers): 1D MACD EMA 19/39 and 4H MACD EMA 12/26 must both sit on the same side of zero.
A pullback needs 3+ consecutive closed 1h bars on the opposite side of zero; the early warning needs 2 consecutive improves toward zero; the confirmation is the zero-line cross.

## SMA 3/10

| Metric | All signals | In-sample (70%) | Out-of-sample (30%) |
|---|---|---|---|
| Confirmed signals | 205 | 144 | 61 |
| Early warnings | 182 | 126 | 56 |
| False-alert rate | 8.8% | 11.1% | 3.3% |
| Avg pullback bars | 8.8 | 8.7 | 9.0 |
| Avg max favorable excursion | 2.8% | 2.6% | 3.1% |
| Avg +6h return | 0.0% | -0.0% | 0.1% |
| Avg +24h return | 0.2% | -0.2% | 1.2% |
| Avg +72h return | 0.3% | 0.3% | 0.5% |
| Win rate +24h | 49.3% | 43.8% | 62.3% |

## EMA 12/100

| Metric | All signals | In-sample (70%) | Out-of-sample (30%) |
|---|---|---|---|
| Confirmed signals | 20 | 14 | 6 |
| Early warnings | 27 | 20 | 7 |
| False-alert rate | 10.0% | 14.3% | 0.0% |
| Avg pullback bars | 11.2 | 10.9 | 12.0 |
| Avg max favorable excursion | 2.7% | 2.4% | 3.3% |
| Avg +6h return | 0.2% | 0.5% | -0.4% |
| Avg +24h return | 0.9% | 0.8% | 0.9% |
| Avg +72h return | 0.2% | -0.3% | 1.2% |
| Win rate +24h | 65.0% | 64.3% | 66.7% |


## Confirmed signals by direction

| Trigger | Direction | Signals | False % | Avg pullback bars | Avg MFE % | Avg +24h % | Win +24h % |
|---|---|---|---|---|---|---|---|
| SMA 3/10 | bullish | 64 | 10.9 | 8.9 | 2.48 | 0.18 | 48.4 |
| SMA 3/10 | bearish | 141 | 7.8 | 8.7 | 2.90 | 0.22 | 49.6 |
| EMA 12/100 | bullish | 8 | 12.5 | 13.4 | 2.18 | 0.34 | 75.0 |
| EMA 12/100 | bearish | 12 | 8.3 | 9.8 | 2.99 | 1.20 | 58.3 |

## Early warning lead time

- SMA 3/10: 169 warnings led a confirmation by 6.6 bars on average
- EMA 12/100: 19 warnings led a confirmation by 16.0 bars on average
