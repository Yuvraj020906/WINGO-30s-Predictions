const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('function sortChronological(');
const end = source.indexOf('function nextIssue(');
const engine = source.slice(start, end);
function run(expression, rows = []) {
  return vm.runInNewContext(`${engine}\n${expression}`, { rows, Math, JSON, Array, Object, Number, String, BigInt });
}
function sample(n = 500) {
  let seed = 123456;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, () => {
    const digit = Math.floor(rand() * 10);
    return { digit, type: digit >= 5 ? 'Big' : 'Small', colors: digit === 0 ? ['red', 'violet'] : digit === 5 ? ['green', 'violet'] : digit % 2 ? ['green'] : ['red'] };
  });
}
test('chi-square survival probability matches a known reference value', () => {
  const p = run('regularizedGammaQ(4.5, 16.919 / 2)');
  assert.ok(Math.abs(p - 0.05) < 0.0001);
});
test('Holm-Bonferroni adjusted p-values are monotone and bounded', () => {
  const out = run(`holmAdjust([{id:'a',pValue:.001},{id:'b',pValue:.01},{id:'c',pValue:.04}])`);
  const p = out.map(x => x.pAdjusted);
  assert.deepEqual(Array.from(p), [0.003, 0.02, 0.04]);
  assert.ok(p.every(x => x >= 0 && x <= 1));
});
test('calibrated probabilities remain normalized and report honest holdout metrics', () => {
  const result = run('models(rows)', sample());
  for (const model of Object.values(result.models)) {
    const sum = model.probabilities.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
  }
  assert.equal(result.calibration.models.ensemble.evaluation.n, 188);
  assert.ok(Number.isFinite(result.calibration.models.ensemble.evaluation.brier));
  assert.ok(Number.isFinite(result.calibration.models.ensemble.evaluation.ece));
});
test('multiple-testing results expose raw and Holm-adjusted p-values', () => {
  const result = run('multipleTesting(rows)', sample());
  assert.equal(result.method, 'Holm-Bonferroni family-wise error correction');
  assert.ok(result.numberOfTests >= 10);
  assert.ok(result.tests.every(x => Number.isFinite(x.pValue) && Number.isFinite(x.pAdjusted)));
});
test('engine does not throw on an empty store', () => {
  assert.doesNotThrow(() => run('models(rows)', []));
  assert.doesNotThrow(() => run('metrics(rows)', []));
});
test('chronological sort orders 17-digit issue numbers exactly', () => {
  // Number() collapses these: all distinct periods compare equal above 2^53.
  const unsorted = [
    { period: '20261123100051626' }, { period: '20261123100051623' },
    { period: '20261123100051625' }, { period: '20261123100051624' },
  ];
  const ordered = run('sortChronological(rows)', unsorted).map(r => r.period);
  assert.deepEqual(Array.from(ordered), [
    '20261123100051623', '20261123100051624',
    '20261123100051625', '20261123100051626',
  ]);
});
test('pattern model is actually validated (loss is measured, not the ln10 default)', () => {
  const result = run('models(rows)', sample());
  const { meanLogLoss, walkForwardCases } = result.validation;
  assert.ok(walkForwardCases > 0);
  assert.notEqual(meanLogLoss.pattern, Math.log(10), 'pattern loss must be computed in the walk-forward loop');
});
