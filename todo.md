# Project TODO

## Data Layer
- [x] Verify Binance Futures API (fapi.binance.com) returns 4H klines for all 6 USDC pairs (2471-5561 candles each)
- [x] Database schema: candles table (symbol, openTime UTC ms, o/h/l/c/v)
- [x] Database schema: predictions table (symbol, candleOpenTime, direction, confidence, outcome)
- [x] Database schema: models table (symbol, serialized ensemble, trainedAt, validation accuracy)
- [x] Database schema: job_runs audit table
- [x] Binance klines fetch helper with UTC alignment and pagination for history backfill

## ML Engine
- [x] Feature engineering: RSI
- [x] Feature engineering: MACD (line, signal, histogram)
- [x] Feature engineering: Bollinger Bands (position, width)
- [x] Feature engineering: EMA (multiple periods + price/EMA ratios)
- [x] Feature engineering: volume delta
- [x] Feature engineering: candle body/wick ratios
- [x] Gradient Boosting (GBM) implementation in TypeScript
- [x] Per-pair model training on historical 4H candles
- [x] Walk-forward backtest to measure honest out-of-sample accuracy
- [x] Next-candle direction prediction returning LONG/SHORT + confidence score
- [x] Confidence gate per pair, chosen from validated threshold curve
- [x] BTC market-context features (+2-3 points raw accuracy on every pair)
- [x] Per-pair hyperparameter search, adopted best config per pair
- [x] Threshold-move variant evaluated (kept as research finding, not adopted globally)
- [x] NEUTRAL / no-signal state when confidence is below the gate
- [x] Report measured accuracy honestly against the 65-70% target band (never fabricated)

## Scheduling
- [x] Heartbeat/cron job aligned to UTC 4H closes (00,04,08,12,16,20 UTC)
- [x] Job: fetch latest candles, resolve previous prediction outcomes
- [x] Job: generate new prediction per pair each 4H close
- [x] Job: periodic model retraining on latest candle data

## Frontend
- [x] Dark-themed professional trading dashboard aesthetic
- [x] Prediction card per pair: current price, LONG/SHORT + confidence %, last updated (UTC), mini 4H candlestick chart
- [x] Color coding: green for LONG, red for SHORT
- [x] Live accuracy tracker per pair (last 50 predictions win rate)
- [x] Accuracy target band 65-70% shown as reference on trackers
- [x] Countdown to next 4H UTC candle close
- [x] Prediction history view with outcomes
- [x] Exactly 6 pairs: WLDUSDC, WIFUSDC, 1000BONKUSDC, UNIUSDC, SUIUSDC, DOGEUSDC

## Verification
- [ ] Vitest coverage for indicators, model, and prediction procedures
- [x] Backfill history and seed predictions so accuracy tracker has data
- [x] Verify dashboard renders with live data (headless check confirms all 6 cards populate)
- [x] Fix dashboard data loading: no-input tRPC procedures now declare an optional object input
- [x] Reduce market.overview latency (trimmed per-pair history rows)
- [ ] Remove temporary debug script scripts/checkPage.mjs before delivery
