# Live Verification Snapshot

Recorded after the initial bootstrap on 2026-08-02. All figures come from the
deployed pipeline's own tables, not from an offline script.

## Stored candle history (Binance Futures, `fapi.binance.com`, 4H, UTC)

| Symbol | Candles stored |
| --- | --- |
| DOGEUSDC | 5,560 |
| SUIUSDC | 5,435 |
| WLDUSDC | 5,225 |
| WIFUSDC | 5,099 |
| 1000BONKUSDC | 4,931 |
| UNIUSDC | 2,470 |
| BTCUSDT (context) | 6,194 |

## Measured rolling accuracy, last 50 resolved predictions

Gated = confidence cleared the pair's validated gate; All = every prediction.

| Pair | Gate | Gated win rate | Gated n | All win rate | All n | Validation (gated) |
| --- | --- | --- | --- | --- | --- | --- |
| WIFUSDC | 0.56 | 76.9% | 13 | 52.0% | 50 | 53.5% |
| UNIUSDC | 0.62 | 66.7% | 9 | 56.0% | 50 | 60.1% |
| WLDUSDC | 0.58 | 61.1% | 18 | 52.0% | 50 | 58.5% |
| SUIUSDC | 0.58 | 54.5% | 11 | 54.0% | 50 | 52.0% |
| DOGEUSDC | 0.56 | 51.9% | 27 | 56.0% | 50 | 52.1% |
| 1000BONKUSDC | 0.58 | 50.0% | 14 | 48.0% | 50 | 53.4% |

Important caveat on the high figures: WIFUSDC's 76.9% rests on only 13 resolved
gated signals, and UNIUSDC's 66.7% on 9. At those sample sizes the confidence
interval is roughly plus or minus 25 points, so neither number is evidence of a
sustained 65-70% edge. The walk-forward validation column, computed over
thousands of bars, is the trustworthy estimate: **52-60% on gated signals**.

The rolling tracker will become meaningful after several weeks of live 4H
closes accumulate, which is precisely why the dashboard reports both the small
rolling sample and the large-sample validation figure side by side.
