# Sniptoxic Mathematical Intelligence Engine

This upgrade preserves the existing Express application and the existing `GET /api/history` provider integration. It does not rebuild the app or assume undocumented provider pagination parameters.

## What is included

- Existing Big Daddy WinGo 30S history endpoint, with JSON/schema/HTTP validation and 12-second timeout.
- Server-side persistent JSON store (`data/wingo-store.json`), atomic writes, issue-number de-duplication and chronological ordering.
- Local gap detection. Missing rounds are reported, never fabricated.
- Statistical dashboard: 0–9 frequencies, 10/20/50/100/200/500 windows, smoothed distributions, 95% Wilson intervals, entropy, mean/variance/standard deviation, z-scores, Pearson chi-square diagnostic with gamma-function survival probability, runs test, autocorrelation, transition matrix, streaks and distribution drift.
- Independent descriptive estimates: historical frequency, Bayesian/Laplace smoothing, EWMA, Markov transition, pattern context and uniform random baseline.
- Walk-forward log-loss scoring for the ensemble. Until at least 30 validation cases exist, weights remain equal. Correlated models are not described as independent evidence.
- Multiclass temperature calibration for each model and the ensemble, fitted on the first 60% of chronological out-of-fold forecasts and evaluated on the later 40%. Reports log-loss, multiclass Brier score, top-label ECE/MCE, classwise ECE, fitted temperature and sample counts. Calibration is withheld when the fit/evaluation sample is too small or the optimum hits the search boundary.
- Multiple-testing diagnostics for digit uniformity, digit-wise deviations, Big/Small runs and digit autocorrelation lags 1–10, with Holm–Bonferroni adjusted p-values and family-wise alpha 0.05. The dashboard shows raw and adjusted p-values.
- Automatic issue prediction records, result reconciliation, pending/verified status, and number/color/Big-Small accuracy summaries.
- User-configurable payout assumptions, expected-value / break-even calculator, and Monte Carlo bankroll simulation (10k/100k/1m rounds).
- Optional chronological ML evaluation for logistic regression, random forest, gradient boosting and optional XGBoost.

## Important limitations / honest status

1. The uploaded project had no database, prediction tracker, ML pipeline, probability calibration, or simulation engine. This version adds local JSON persistence, a tracking ledger, descriptive models and simulations.
2. **The provider serves only the 10 newest issues (~5 minutes) and ignores every pagination parameter tested** (`pageNo`, `pageSize`, `page`, `size`, `type`, and combinations). The app does not guess undocumented parameters. Consequence: rounds drawn while this server is offline are permanently lost. `GET /api/coverage` reports exactly how much of the timeline is stored and which issue ranges are missing. Nothing is ever backfilled or invented.
3. Issue numbers have the shape `YYYYMMDD | 10005 | round-index-within-day`, so the index restarts at 0 each day. Gap detection therefore runs on derived draw times, not on issue-number differences — a numeric difference would silently skip an overnight outage. The draw time is derived from the issue number; it is used only to decide whether a prediction was recorded before its draw, and is never presented as a platform-published timestamp.
4. Color mapping is derived using the common Win Go mapping (0 = Red/Violet, 5 = Green/Violet, even non-zero = Red, odd non-five = Green) only when provider color data is absent. Confirm that mapping against the specific platform rules.
5. Payout multipliers are editable defaults, not verified platform terms. The EV calculator assumes the entered multiplier is gross return including stake. Change it to the platform's actual rule before using it. No fee is assumed by default.
6. Statistical p-values are diagnostics, not proof of predictability. Pearson chi-square uses its chi-square survival probability; runs and autocorrelation p-values use normal approximations. Holm–Bonferroni adjusts the displayed test family, but exploratory test selection, serial dependence and repeated analysis still require independent confirmation. Treat signals as exploratory. No model claims guaranteed accuracy.
7. The ensemble's validation weights use chronological log loss after at least 30 validation cases; this is not a guarantee of future performance. The current implementation is not a claim that a genuine edge exists.
8. **ML is an offline evaluation script and is deliberately not deployed into live predictions.** Running it against the live store showed every candidate model scoring *worse than uniform chance* on held-out data (see `ml/DECISION.md` and `GET /api/ml-status`). Deploying one would degrade the forecast and support a claim the evidence does not back. The decision is revisited only under the conditions documented in `ml/DECISION.md`.
9. Monte Carlo output is simulated data, never real history or a forecast. Risk-of-ruin assumes fixed stake and the configured win probability/payout.
10. Temperature calibration is an empirical correction, not a guarantee of calibrated future probabilities. The ensemble calibration forecasts use weights learned only from earlier walk-forward log-loss. The correction family currently includes the tests listed in the dashboard; it does not cover every conceivable pattern search. Benjamini–Hochberg, preregistered hypothesis testing, time-of-day feature analysis, daily accuracy aggregation, and a production SQL database remain outside this increment. Do not interpret adjusted significance as evidence that the next result is predictable.
11. **One eligibility rule governs every accuracy number.** A prediction counts only if its round resolved, it was recorded before the draw, its commitment was not generated after the fact, and it was not abandoned to a collection gap. `/api/dashboard`, `/api/predictions/summary` and the result rows all use the same predicate, so they cannot disagree. Exclusions are shown on the dashboard, not hidden.
12. The commitment ledger is tamper-evident, not tamper-proof. A matching digest shows a record has not changed since it was written to *this* local store; a custodian who rewrites both the record and its digest can produce a consistent ledger. Publish digests to an external timestamping service for independent proof.

## Run

```bash
npm install
cp .env.example .env   # optional
npm start
```

Open `http://localhost:3000`.

Run the built-in math/statistics regression tests with `npm test`; run the JavaScript syntax check with `npm run check`. The tests cover a known chi-square reference value, Holm adjustment, normalized calibrated probability vectors, out-of-sample calibration metrics, and multiple-testing output.

## Configuration

- `PORT=3000`
- `WINGO_HISTORY_URL=https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json`
- `WINGO_GAME=WinGo_30S`
- `DB_FILE=./data/wingo-store.json`

The app writes the local data store on the server. Back it up before deleting or moving the project.

## API endpoints

- `GET /api/health` — liveness, poll status, eligibility and coverage counters
- `GET /api/history` — refreshes and merges verified provider results
- `GET /api/analysis` — statistics and model estimates
- `GET /api/predictions` — paginated prediction ledger and accuracy summary. `?limit=` (default 200, capped 1000) and `?offset=` (newest-first) page through it; `pagination.total` is the full count. The ledger is never pruned, so the whole set is not returned in one response.
- `GET /api/dashboard` — payload for the UI (accuracy, coverage, windows, current period)
- `GET /api/coverage` — how much of the game timeline is stored, with missing issue ranges
- `GET /api/ml-status` — the offline-ML decision and the latest evaluation results
- `GET /api/verify` / `GET /api/verify/:id` — commitment integrity checks
- `GET /api/settings`
- `POST /api/settings` — configure payouts and optional fee rate
- `POST /api/simulate` — simulation only

## Optional ML evaluation

The Python models are **evaluation-only and are not wired into live predictions**. See
`ml/DECISION.md` for the measured reason. To reproduce the evaluation:

```bash
uv venv ml/.venv
uv pip install --python ml/.venv/Scripts/python.exe numpy scikit-learn
uv run --python ml/.venv/Scripts/python.exe python ml/train.py
```

The script uses chronological train/validation/test segments, reports validation and untouched test
metrics (accuracy, log loss, Brier score and expected calibration error), and compares candidates to
uniform and Laplace-smoothed historical-frequency baselines. It writes `ml/evaluation-report.json`,
which `GET /api/ml-status` serves read-only. Install XGBoost separately if supported.
