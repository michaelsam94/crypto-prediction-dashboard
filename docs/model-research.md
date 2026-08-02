# Model Research Log

Honest walk-forward (expanding-window, 5 folds, retrain per fold) out-of-sample
results measured on full Binance Futures 4H history from `fapi.binance.com`.
All accuracies below are out-of-sample; nothing here is an in-sample figure.

## Baseline: 32 pair-local features, plain direction label

| Pair | Candles | Raw OOS accuracy | Best gated accuracy | Coverage at gate |
| --- | --- | --- | --- | --- |
| WLDUSDC | 5,225 | 51.9% | 59.2% | 19% |
| UNIUSDC | 2,470 | 51.9% | 57.7% | 26% |
| SUIUSDC | 5,435 | 50.8% | 54.3% | 27% |
| WIFUSDC | 5,099 | 50.1% | 53.0% | 13% |
| 1000BONKUSDC | 4,931 | 50.1% | 52.0% | 22% |
| DOGEUSDC | 5,560 | 50.6% | 51.7% | 25% |

Conclusion: unfiltered 4H direction prediction sits at 50-52%, consistent with
the efficient-market expectation for high-frequency crypto candles. Confidence
gating is the single most effective lever.

## Lever 1: BTC market-context features (+6 features)

Adding BTC 4H returns (1/3/6 bar), realized volatility, current body, and
distance from EMA21 lifts raw accuracy by roughly 2-3 points on every pair.

| Pair | Raw without BTC | Raw with BTC | Best gated with BTC |
| --- | --- | --- | --- |
| WLDUSDC | 51.9% | 53.7% | 58.4% at 38% coverage |
| SUIUSDC | 50.8% | 53.5% | 57.0% at 26% coverage |
| DOGEUSDC | 50.6% | 54.0% | 58.0% at 53% coverage |

This is expected: altcoin 4H direction is strongly conditioned on BTC's
concurrent move, so BTC state is genuine signal rather than noise.

## Lever 2: Significant-move labelling

Restricting training and evaluation to candles whose body exceeds a multiple of
the trailing 20-bar mean body removes low-information chop. Results are mixed
across pairs: it helps SUIUSDC (59.3% at 44% coverage) and WLDUSDC, but hurts
DOGEUSDC at 0.8x while helping it at 1.2x. It is therefore treated as a
per-pair tunable rather than a global default.

## Lever 3: Confidence gating (adopted)

Gating on model confidence is reliably monotonic on most pairs. Representative
high-gate results with BTC context features:

| Pair | Gate | Accuracy | Coverage |
| --- | --- | --- | --- |
| 1000BONKUSDC | 0.66 | 67% | 19% |
| 1000BONKUSDC | 0.64 | 64% | 26% |
| WLDUSDC | 0.70 | 65% | 8% |
| SUIUSDC | 0.60 | 59% | 44% |
| DOGEUSDC | 0.66 | 60% | 28% |

## Adopted design

The production configuration combines all three levers and lets each pair pick
its own operating point during training:

1. 32 pair-local features plus 6 BTC market-context features.
2. Gradient-boosted trees, depth 3, 140 trees, learning rate 0.05, with row and
   feature subsampling for variance reduction.
3. Per-pair confidence gate selected on validation data, preferring the highest
   accuracy that still retains meaningful coverage.
4. Signals below the gate are surfaced as NEUTRAL rather than forced into a
   LONG/SHORT call, so the displayed win rate reflects only actionable signals.

Realistic expectation: **55-62% on gated signals for most pairs**, with some
pairs reaching the 65-70% band at low coverage. The dashboard displays the
measured rolling win rate against the 65-70% target band so the gap between
target and reality is always visible rather than hidden.

## Per-pair hyperparameter search (adopted configuration)

Five configurations were evaluated per pair with BTC context features enabled.
The winner by validated gated accuracy is adopted per pair.

| Pair | Adopted config | Raw OOS | Gated OOS | Gate | Coverage |
| --- | --- | --- | --- | --- | --- |
| WLDUSDC | depth 2, 300 trees, lr 0.03 | 52.8% | 58.7% | 0.58 | 20% |
| UNIUSDC | depth 3, 140 trees, lr 0.05 | 52.9% | 60.1% | 0.62 | 20% |
| SUIUSDC | depth 3, 250 trees, lr 0.03 | 50.3% | 54.0% | 0.58 | 20% |
| DOGEUSDC | depth 2, 300 trees, lr 0.03 | 50.3% | 52.8% | 0.56 | 24% |
| WIFUSDC | depth 2, 200 trees, lr 0.04 | 49.6% | 52.8% | 0.56 | 21% |
| 1000BONKUSDC | depth 2, 200 trees, lr 0.04 | 49.7% | 52.7% | 0.58 | 22% |

Interpretation: UNIUSDC and WLDUSDC carry genuine, repeatable edge in the
58-60% range on gated signals. SUIUSDC is marginal at 54%. WIFUSDC,
1000BONKUSDC, and DOGEUSDC sit at 52-53%, which is a real but small edge over a
coin flip and well below the 65-70% aspiration. Pure meme-coin 4H direction is
the hardest of the six to forecast, which is intuitive: those moves are driven
by sentiment shocks rather than the technical structure the features encode.

No configuration reaches a sustained 65-70% out-of-sample win rate on any pair
at usable coverage. Any dashboard claiming otherwise would be reporting
in-sample fit, not forecasting skill.
