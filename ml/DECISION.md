# ML integration decision

**Decision: the Python models do not participate in live predictions.**

Recorded 2026-11-24 after running `ml/train.py` against the live store.

## Evidence

Chronological split of 408 verified outcomes: 226 train / 76 validation / 76 untouched test.
Features use only outcomes strictly before the target round, so there is no leakage.

Held-out test log-loss (lower is better; uniform chance baseline is `ln(10) = 2.302585`):

| Model | Test accuracy | Test log-loss | vs uniform |
|---|---|---|---|
| uniform_random | 9.2% | 2.302585 | baseline |
| historical_frequency | 9.2% | 2.307919 | +0.0053 worse |
| random_forest | 9.2% | 2.378113 | +0.0755 worse |
| gradient_boosting | 13.2% | 3.804378 | +1.5018 worse |
| logistic_regression | 14.5% | 5.413289 | +3.1107 worse |

Every model is worse than predicting 10% for each digit. Accuracy above 10% on 76 cases is noise:
the top model's 14.5% is 11 hits out of 76, and a binomial 95% interval around 10% easily covers it.
Log-loss is the honest metric here because it penalises confident wrong answers, and on that measure
`gradient_boosting` and `logistic_regression` are dramatically worse than chance — they are
confidently wrong, which is the worst possible failure mode for a forecast.

The store was also only ~27% coverage at the time (1,215 rounds missing across 5 gaps), so the
effective sample available for supervised learning is small and non-contiguous.

## Reasoning

1. A model that loses to uniform on held-out data cannot improve a live prediction. Adding it would
   make the output worse while creating an "ML-powered" claim the results do not support.
2. The JavaScript ensemble already applies walk-forward validation weights and temperature
   calibration. It is not claimed to have an edge, and its own diagnostics say
   "NO RELIABLE EDGE DETECTED".
3. Win Go draws are designed to be independent. There is no known exploitable structure, and this
   evaluation is consistent with that. A model "finding" structure here would be evidence of a bug
   or leakage, not of a real edge.

## What would change this decision

Revisit only if all of the following hold:

- At least ~5,000 contiguous verified rounds (the current provider window makes this slow to gather).
- A model beats `uniform_random` on log-loss across **repeated** walk-forward folds, not one split.
- The improvement survives on the untouched final segment and is larger than fold-to-fold variance.
- Calibration error is low enough that the probabilities mean what they say.

Until then `ml/train.py` remains an **offline evaluation tool**. `GET /api/ml-status` reports this
decision and the latest report so the claim is auditable rather than asserted in prose.

## Reproduce

```bash
uv venv ml/.venv
uv pip install --python ml/.venv/Scripts/python.exe numpy scikit-learn
uv run --python ml/.venv/Scripts/python.exe python ml/train.py
```

Output is written to `ml/evaluation-report.json` and served read-only by `GET /api/ml-status`.
