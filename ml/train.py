"""Optional chronological ML evaluation. Run: python -m pip install -r ml/requirements.txt && python ml/train.py"""
import json, math, pathlib, sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parents[1]
STORE = ROOT / 'data' / 'wingo-store.json'
if not STORE.exists():
    raise SystemExit('No local history yet. Start the Node app and allow verified API results to accumulate.')
rows = json.loads(STORE.read_text(encoding='utf-8')).get('results', [])
digits = [int(r['digit']) for r in rows if isinstance(r.get('digit'), int) and 0 <= r['digit'] <= 9]
if len(digits) < 150:
    raise SystemExit(f'Need at least 150 verified sequential outcomes; found {len(digits)}.')
try:
    import numpy as np
    from sklearn.ensemble import RandomForestClassifier, HistGradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import accuracy_score, log_loss
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import make_pipeline
except ImportError as exc:
    raise SystemExit('Install optional dependencies: python -m pip install -r ml/requirements.txt') from exc

# Features use only outcomes strictly before target t. No shuffled split.
def feature(seq, t):
    past = seq[max(0, t-20):t]
    x = []
    for lag in range(1, 11):
        x.extend([1.0 if seq[t-lag] == d else 0.0 for d in range(10)])
    counts = Counter(past)
    x.extend(counts[d] / max(1, len(past)) for d in range(10))
    x.extend([sum(v >= 5 for v in past) / max(1, len(past)), len(past) / 20])
    return x
start = 30
X = np.asarray([feature(digits, t) for t in range(start, len(digits))], dtype=float)
y = np.asarray(digits[start:], dtype=int)
n = len(y); train_end = int(n * .6); val_end = int(n * .8)
if train_end < 40 or val_end <= train_end:
    raise SystemExit('Not enough observations for chronological train/validation/test split.')
models = {
    'logistic_regression': make_pipeline(StandardScaler(), LogisticRegression(max_iter=1500, class_weight=None)),
    'random_forest': RandomForestClassifier(n_estimators=300, min_samples_leaf=5, max_features='sqrt', random_state=42, n_jobs=-1),
    'gradient_boosting': HistGradientBoostingClassifier(max_iter=150, max_leaf_nodes=15, l2_regularization=1.0, random_state=42),
}
try:
    from xgboost import XGBClassifier
    models['xgboost'] = XGBClassifier(n_estimators=250, max_depth=3, learning_rate=.04, subsample=.8, colsample_bytree=.8, objective='multi:softprob', num_class=10, eval_metric='mlogloss', random_state=42)
except ImportError:
    pass

def pad_probs(p):
    out = np.full((len(p), 10), 1e-9)
    for j, cls in enumerate(model_classes): out[:, int(cls)] = p[:, j]
    out /= out.sum(axis=1, keepdims=True)
    return out

def brier(probs, truth):
    one = np.eye(10)[truth]
    return float(np.mean(np.sum((probs-one)**2, axis=1)))

def calibration_error(probs, truth, bins=10):
    confidence = probs.max(axis=1); correct = (probs.argmax(axis=1) == truth).astype(float)
    total = len(truth); error = 0.0
    for lo in np.linspace(0, 1, bins, endpoint=False):
        hi = lo + 1 / bins
        mask = (confidence >= lo) & (confidence < hi if hi < 1 else confidence <= hi)
        if mask.any(): error += mask.mean() * abs(float(confidence[mask].mean()) - float(correct[mask].mean()))
    return float(error)

def score(probs, truth):
    return {'accuracy': float(accuracy_score(truth, probs.argmax(axis=1))),
            'logLoss': float(log_loss(truth, probs, labels=list(range(10)))),
            'brierScore': brier(probs, truth), 'expectedCalibrationError': calibration_error(probs, truth),
            'cases': int(len(truth))}

results = {}
# Hold-out test is strictly later than train and validation. Validation selects no model here;
# all candidates are reported rather than cherry-picked.
for name, model in models.items():
    model.fit(X[:train_end], y[:train_end])
    model_classes = model.classes_ if hasattr(model, 'classes_') else model[-1].classes_
    val_probs = pad_probs(model.predict_proba(X[train_end:val_end]))
    test_probs = pad_probs(model.predict_proba(X[val_end:]))
    results[name] = {'validation': score(val_probs, y[train_end:val_end]), 'test': score(test_probs, y[val_end:])}
# Baselines use only the training prefix; the frequency baseline is Laplace-smoothed.
counts = np.bincount(y[:train_end], minlength=10).astype(float) + 1
freq = counts / counts.sum(); uniform = np.full(10, .1)
truth = y[val_end:]
for name, p in [('uniform_random', uniform), ('historical_frequency', freq)]:
    val_probs = np.tile(p, (val_end-train_end, 1)); test_probs = np.tile(p, (len(truth), 1))
    results[name] = {'validation': score(val_probs, y[train_end:val_end]), 'test': score(test_probs, truth)}
report = {'warning': 'Offline chronological evaluation only; not deployed as a prediction model. Results may be noisy and require repeated walk-forward confirmation.', 'rows': len(digits), 'split': {'train': train_end, 'validation': val_end-train_end, 'test': len(y)-val_end}, 'models': results}
out = ROOT / 'ml' / 'evaluation-report.json'; out.write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report, indent=2)); print(f'Wrote {out}')
