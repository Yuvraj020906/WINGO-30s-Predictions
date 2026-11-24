const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

/** Pull a top-level `function name(...)` (or `const name = (...) =>`) out of server.js by matching
 *  braces, so these tests exercise the real implementation rather than a copy. */
function extractFunction(name) {
  const decl = `function ${name}(`;
  let start = source.indexOf(decl);
  if (start === -1) {
    // const NAME=function(...) / const NAME=(...) =>  style
    const alt = new RegExp(`(?:function|const)\\s+${name}\\s*[=(]`);
    const m = alt.exec(source);
    if (!m) throw new Error(`Could not locate ${name} in server.js`);
    start = m.index;
  }
  // Walk forward from the first `{` after the signature, tracking depth.
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(start, i);
}

function extractConstLine(name) {
  const re = new RegExp(`^const ${name}\\s*=.*$`, 'm');
  const m = re.exec(source);
  if (!m) throw new Error(`Could not locate const ${name}`);
  return m[0];
}

const commitmentSource = [
  extractConstLine('GENESIS'),
  extractFunction('sha256Hex'),
  extractFunction('canonicalPayload'),
  extractFunction('commitmentFor'),
].join('\n');

const statsSource = [
  extractFunction('normalCdf'),
  extractFunction('wilsonInterval'),
  extractFunction('poissonBinomialTest'),
  extractFunction('chanceFor'),
].join('\n');

function makeContext(extra = {}) {
  return {
    Math, JSON, Array, Object, Number, String, Boolean, BigInt, Date,
    crypto,
    console: { log() {}, warn() {}, error() {} },
    ...extra,
  };
}

function loadCommitUtils() {
  const code = `${commitmentSource}\n;({sha256Hex, canonicalPayload, commitmentFor});`;
  return vm.runInNewContext(code, makeContext());
}

function loadStats() {
  const code = `${statsSource}\n;({wilsonInterval, poissonBinomialTest, chanceFor, normalCdf});`;
  return vm.runInNewContext(code, makeContext());
}

/* ---------------------------------------------------------------- commitments */

const basePrediction = () => ({
  id: 'fixed-id',
  issue: '20261123100051999',
  predictionTime: '2026-11-23T14:00:00.000Z',
  predictedNumber: 4,
  predictedColor: 'Red',
  predictedBigSmall: 'Big',
  probabilities: [0.07, 0.028, 0.0749, 0.0854, 0.1782, 0.086, 0.1298, 0.1095, 0.1393, 0.0984],
  model: 'Walk-forward validation ensemble',
  sampleSize: 63,
  nonce: 'a'.repeat(32),
});

test('commitment is deterministic for identical content', () => {
  const { commitmentFor } = loadCommitUtils();
  const a = commitmentFor(basePrediction());
  const b = commitmentFor(basePrediction());
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('commitment changes when the predicted side is edited', () => {
  const { commitmentFor } = loadCommitUtils();
  const original = commitmentFor(basePrediction());
  const flipped = basePrediction();
  flipped.predictedBigSmall = 'Small';
  assert.notEqual(commitmentFor(flipped), original,
    'editing the published prediction must change the digest');
});

test('commitment changes when the issue or the nonce changes', () => {
  const { commitmentFor } = loadCommitUtils();
  const original = commitmentFor(basePrediction());

  const otherIssue = basePrediction();
  otherIssue.issue = '20261123100052000';
  assert.notEqual(commitmentFor(otherIssue), original);

  const otherNonce = basePrediction();
  otherNonce.nonce = 'b'.repeat(32);
  assert.notEqual(commitmentFor(otherNonce), original,
    'the nonce must be part of the hashed payload');
});

test('commitment ignores the resolved outcome, so reconciliation cannot invalidate a record', () => {
  const { commitmentFor } = loadCommitUtils();
  const before = commitmentFor(basePrediction());
  const resolved = { ...basePrediction(), actual: 7, correctBigSmall: true, verifiedAt: '2026-11-23T14:00:30.000Z' };
  assert.equal(commitmentFor(resolved), before);
});

test('commitment payload reproduces the published bytes for a checkable hash', () => {
  const { canonicalPayload } = loadCommitUtils();
  const payload = canonicalPayload(basePrediction());
  // Field order must be stable, otherwise a verifier cannot rebuild the digest.
  assert.equal(payload.indexOf('"issue"'), 1);
  assert.ok(payload.includes('"predictedBigSmall":"Big"'));
  assert.ok(payload.includes('"predictedNumber":4'));
  assert.ok(!payload.includes('nonce'), 'nonce is appended outside the JSON payload');
});

/* ---------------------------------------------------------------- chance rates */

test('chance baseline reflects the true rate of the pick actually made', () => {
  const { chanceFor } = loadStats();
  assert.equal(chanceFor('bigSmall', 'Big'), 0.5);
  assert.equal(chanceFor('bigSmall', 'Small'), 0.5);
  assert.equal(chanceFor('number', 7), 0.1);
  assert.equal(chanceFor('colour', 'Red'), 0.5);
  assert.equal(chanceFor('colour', 'Green'), 0.5);
  // Violet covers only 0 and 5, so treating it as 50% would manufacture a fake edge.
  assert.equal(chanceFor('colour', 'Violet'), 0.2);
});

/* ---------------------------------------------------------------- intervals */

test('Wilson interval contains the observed rate and widens as n shrinks', () => {
  const { wilsonInterval } = loadStats();
  const small = wilsonInterval(6, 10);
  const large = wilsonInterval(600, 1000);
  assert.ok(small.lower < 0.6 && small.upper > 0.6);
  assert.ok(large.lower < 0.6 && large.upper > 0.6);
  assert.ok((small.upper - small.lower) > (large.upper - large.lower),
    'a smaller sample must produce a wider interval');
});

test('Wilson interval stays inside [0,1] at the extremes', () => {
  const { wilsonInterval } = loadStats();
  for (const [hits, n] of [[0, 20], [20, 20], [0, 1], [1, 1]]) {
    const ci = wilsonInterval(hits, n);
    assert.ok(ci.lower >= 0 && ci.lower <= 1, `lower ${ci.lower} out of range`);
    assert.ok(ci.upper >= 0 && ci.upper <= 1, `upper ${ci.upper} out of range`);
    assert.ok(ci.lower <= ci.upper);
  }
});

/* ---------------------------------------------------------------- z-test */

test('z-test is not significant when results match chance exactly', () => {
  const { poissonBinomialTest } = loadStats();
  const chances = Array(100).fill(0.5);
  const out = poissonBinomialTest(50, chances);
  assert.equal(out.hits, 50);
  assert.equal(out.chanceRate, 0.5);
  assert.ok(out.z === 0 || Math.abs(out.z) < 1e-9);
  assert.equal(out.pValue, 1);
});

test('z-test flags a large deviation but not a modest one', () => {
  const { poissonBinomialTest } = loadStats();
  const hundred = Array(100).fill(0.5);
  const modest = poissonBinomialTest(58, hundred);   // 58% on n=100
  const extreme = poissonBinomialTest(90, hundred);  // 90% on n=100
  assert.ok(modest.pValue > 0.05, `58/100 should not be significant, got p=${modest.pValue}`);
  assert.ok(extreme.pValue < 0.001, `90/100 should be significant, got p=${extreme.pValue}`);
  assert.ok(extreme.z > 0);
});

test('z-test handles a mixed Violet/Red/Green baseline instead of a flat 50%', () => {
  const { poissonBinomialTest } = loadStats();
  // Twenty Violet picks (chance 0.2 each) and twenty Red picks (chance 0.5 each).
  const chances = [...Array(20).fill(0.2), ...Array(20).fill(0.5)];
  const out = poissonBinomialTest(4, chances);
  assert.equal(out.n, 40);
  assert.ok(Math.abs(out.chanceRate - 0.35) < 1e-9, `expected 0.35 baseline, got ${out.chanceRate}`);
  assert.ok(Math.abs(out.expectedHits - 14) < 1e-9);
});

test('z-test refuses to invent a p-value for an empty sample', () => {
  const { poissonBinomialTest } = loadStats();
  const out = poissonBinomialTest(0, []);
  assert.equal(out.n, 0);
  assert.equal(out.pValue, null);
  assert.equal(out.z, null);
});

/* ---------------------------------------------------------------- draw time derivation */

// The provider returns one `serviceTime` for a whole batch of 10 rows. If rows were stamped with it,
// ten consecutive 30s draws would share a timestamp and any "recorded before the draw" test would be
// meaningless. drawTimeFor() derives the true draw moment from the issue number instead.

function loadDrawTime() {
  const code = `
    ${extractConstLine('ROUND_MS')}
    ${extractFunction('drawTimeFor')}
    ;({drawTimeFor, ROUND_MS});
  `;
  return vm.runInNewContext(code, makeContext());
}

test('draw time is derived from the issue number, not the batch serviceTime', () => {
  const { drawTimeFor } = loadDrawTime();
  // 20261124 | 10005 | 0352  ->  352 * 30s after UTC midnight on 2026-11-24
  const t = drawTimeFor('20261124100050352');
  assert.equal(t, Date.UTC(2026, 10, 24) + 352 * 30000);
  assert.equal(new Date(t).toISOString(), '2026-11-24T02:56:00.000Z');
});

test('consecutive issues are exactly 30 seconds apart', () => {
  const { drawTimeFor } = loadDrawTime();
  const a = drawTimeFor('20261124100050352');
  const b = drawTimeFor('20261124100050353');
  assert.equal(b - a, 30000);
});

test('ten consecutive issues get ten distinct times instead of one shared batch stamp', () => {
  const { drawTimeFor } = loadDrawTime();
  const times = [];
  for (let i = 360; i < 370; i++) times.push(drawTimeFor(`20261124100050${i}`));
  assert.equal(new Set(times).size, 10, 'every row must have its own draw time');
});

test('draw time derivation rejects malformed or non-matching periods', () => {
  const { drawTimeFor } = loadDrawTime();
  assert.equal(drawTimeFor(''), null);
  assert.equal(drawTimeFor('123'), null);
  assert.equal(drawTimeFor('2026112410005035'), null);      // 16 digits
  assert.equal(drawTimeFor('20261124999990352'), null);     // wrong game constant
  assert.equal(drawTimeFor('20260231100050001'), null);     // Feb 31 does not exist
  assert.equal(drawTimeFor('20261324100050001'), null);     // month 13
  assert.equal(drawTimeFor('20261124100050abc'), null);     // non-numeric index
});

test('a round just before UTC midnight and one just after land on different days', () => {
  const { drawTimeFor } = loadDrawTime();
  // 2879 * 30s = 23:59:30, and round 0 of the next day is 00:00:00.
  const last = drawTimeFor('20261124100052879');
  const firstNext = drawTimeFor('20261125100050000');
  assert.equal(new Date(last).toISOString(), '2026-11-24T23:59:30.000Z');
  assert.equal(new Date(firstNext).toISOString(), '2026-11-25T00:00:00.000Z');
  assert.equal(firstNext - last, 30000, 'the day boundary must not create a fake gap');
});

test('next issue resets the round index at UTC midnight', () => {
  const code = `
    ${extractConstLine('ROUND_MS')}
    ${extractFunction('drawTimeFor')}
    ${extractFunction('nextIssue')}
    ;nextIssue
  `;
  const nextIssue = vm.runInNewContext(code, makeContext());
  assert.equal(nextIssue('20261124100052878'), '20261124100052879');
  assert.equal(nextIssue('20261124100052879'), '20261125100050000');
});

/* ---------------------------------------------------------------- eligibility rule */

// Before this rule existed, three code paths disagreed: the summary filtered on `!retroactive`,
// marketStats filtered on `commitmentOrigin !== 'backfilled'`, and resultRowsFor filtered on the
// backfill flag alone. The same ledger could therefore show three different hit rates.

function loadEligibility() {
  const code = `${extractFunction('eligiblePrediction')};eligiblePrediction;`;
  return vm.runInNewContext(code, makeContext());
}

const eligibleBase = () => ({
  actual: 7, correctBigSmall: true, retroactive: false, commitmentOrigin: 'live',
});

test('a clean resolved prediction is eligible', () => {
  const eligible = loadEligibility();
  assert.equal(eligible(eligibleBase()), true);
});

test('eligibility rejects every reason a hit rate could be inflated', () => {
  const eligible = loadEligibility();
  const cases = [
    ['unresolved round', { actual: null }],
    ['abandoned to a data gap', { abandoned: true }],
    ['recorded at or after the draw', { retroactive: true }],
    ['commitment generated after the fact', { commitmentOrigin: 'backfilled' }],
  ];
  for (const [label, patch] of cases) {
    assert.equal(eligible({ ...eligibleBase(), ...patch }), false, `${label} must be excluded`);
  }
});

test('eligibility is the only filter, so all surfaces agree by construction', () => {
  const eligible = loadEligibility();
  const ledger = [
    { ...eligibleBase() },
    { ...eligibleBase(), retroactive: true },
    { ...eligibleBase(), commitmentOrigin: 'backfilled' },
    { ...eligibleBase(), abandoned: true },
    { ...eligibleBase(), actual: null },
    { ...eligibleBase(), correctBigSmall: false },
  ];
  const counted = ledger.filter(eligible);
  assert.equal(counted.length, 2, 'only the two clean resolved records may count');
  assert.equal(counted.filter((p) => p.correctBigSmall).length, 1);
  assert.equal(counted.filter((p) => p.correctBigSmall).length / counted.length, 0.5);
});

/* ---------------------------------------------------------------- gap accounting */

// Gaps are computed from derived draw times. A plain issue-number difference would miss an overnight
// outage entirely, because issue indexes restart at 0 each day.

test('gap accounting measures holes in time, including across the day boundary', () => {
  const { drawTimeFor } = loadDrawTime();
  const rows = [
    { period: '20261124100052878', time: drawTimeFor('20261124100052878') },
    { period: '20261125100050003', time: drawTimeFor('20261125100050003') },
  ];
  const delta = rows[1].time - rows[0].time;
  const missing = Math.round(delta / 30000) - 1;
  // 23:59:00 on the 24th to 00:01:30 on the 25th leaves 4 rounds unaccounted for.
  assert.equal(missing, 4);
  assert.ok(missing > 0, 'the overnight hole must be detected, not skipped as a numeric jump');
});

/* ---------------------------------------------------------------- provider normalisation */

// Number('') === 0 and Number(null) === 0, so a blank or missing `number` field was stored as a
// verified "0" draw that never happened.
function loadNormalize() {
  const code = `
    ${extractConstLine('ROUND_MS')}
    ${extractFunction('colorsFor')}
    ${extractFunction('drawTimeFor')}
    ${extractFunction('normalize')}
    ;normalize
  `;
  return vm.runInNewContext(code, makeContext());
}

test('a blank or missing digit is rejected instead of being stored as a 0', () => {
  const normalize = loadNormalize();
  const issue = '20261124100050352';
  for (const bad of ['', '   ', null, undefined]) {
    assert.equal(normalize({ issueNumber: issue, number: bad }, 0, 1), null,
      `number=${JSON.stringify(bad)} must not become a verified 0`);
  }
  // A genuine zero must still pass.
  assert.equal(normalize({ issueNumber: issue, number: 0 }, 0, 1).digit, 0);
  assert.equal(normalize({ issueNumber: issue, number: '0' }, 0, 1).digit, 0);
});

test('an out-of-range or fractional digit is rejected', () => {
  const normalize = loadNormalize();
  const issue = '20261124100050352';
  for (const bad of [10, -1, 4.5, 'NaN', {}, 'x']) {
    assert.equal(normalize({ issueNumber: issue, number: bad }, 0, 1), null,
      `number=${JSON.stringify(bad)} must be rejected`);
  }
});

test('a provider-supplied draw time is marked explicit so it is never overwritten', () => {
  const normalize = loadNormalize();
  const explicit = normalize({ issueNumber: '20261124100050352', number: 4, time: 1795440000000 }, 0, 1);
  assert.equal(explicit.timeExplicit, true);
  assert.equal(explicit.timeDerived, false);
  assert.equal(explicit.time, 1795440000000);

  const derived = normalize({ issueNumber: '20261124100050352', number: 4 }, 0, 1795440000000);
  assert.equal(derived.timeExplicit, false);
  assert.equal(derived.timeDerived, true);
  assert.equal(derived.time, Date.UTC(2026, 10, 24) + 352 * 30000);
});

/* ---------------------------------------------------------------- dashboard window param */

// Math.min/max pass floats through, so ?window=-5 used to produce a one-row "Last N" window and
// ?window=abc silently fell back without saying so.
test('dashboard window parameter is floored to an integer and never returns a fractional slice', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // The clamp must floor; slice() with a float is the bug this guards against.
  assert.match(src, /Math\.floor\(requestedWindow\)/);
  assert.ok(!/Math\.max\(1,\s*Math\.min\(1000,\s*Number\(req\.query\.window\)/.test(src),
    'the old unfloored clamp must not come back');
});

test('dashboard publishes one window with rows and only summaries for the other markets', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /lastNWindow\('bigSmall',limit,market==='bigSmall'\)/,
    'only the selected market may ship row arrays');
});

/* ---------------------------------------------------------------- open forecast selection */

// An abandoned prediction never resolves, so including it in the "open" filter leaves a dead pick
// on screen as the live LOCKED IN forecast forever.
test('the open forecast excludes abandoned predictions', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /p\.actual===null&&!p\.abandoned/,
    'the dashboard current-period lookup must skip abandoned records');
});

/* ---------------------------------------------------------------- documented routes */

test('every documented API route is actually registered', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const documented = [...readme.matchAll(/`(GET|POST) (\/api\/[a-z/:.-]+)`/g)].map((m) => m[2]);
  assert.ok(documented.length > 0, 'the README should document routes');
  for (const route of new Set(documented)) {
    const pattern = route.replace(/:[a-zA-Z]+/g, ':');
    const found = src.includes(`'${pattern.split('/:')[0]}`) || src.includes(`'${route}`);
    assert.ok(found, `documented route ${route} is not registered in server.js`);
  }
});

/* ---------------------------------------------------------------- malformed JSON handling */

test('a malformed JSON body is answered as JSON, not an HTML stack trace', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /entity\.parse\.failed/,
    'body-parser errors must be handled so paths are not leaked in a stack trace');
  assert.ok(src.indexOf('entity.parse.failed') < src.indexOf('app.listen('),
    'the error handler must be registered before the server starts listening');
});

/* ---------------------------------------------------------------- settled forecast */

// The cheapest honest fix for "LOCKED IN" outliving its round is a client-side re-evaluation, so
// the tick must call it and the server must supply the boundary.
test('the dashboard publishes a draw boundary for the open forecast', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /drawAt:drawTimeFor\(open\.issue\)/,
    'the client cannot tell when a locked forecast settles without the server draw time');
});

test('the client re-evaluates the locked label on the tick, not only on poll', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /AWAITING RESULT/,
    'a drawn round must stop being presented as an open forecast');
  assert.match(app, /function settledAt/, 'the settle boundary must pick the earlier known instant');
  // renderClock is the 250ms ticker; it must drive the label or the state lags a full poll interval.
  const tick = app.slice(app.indexOf('function renderClock'));
  assert.match(tick.slice(0, 1200), /renderCurrentState/,
    'renderClock must re-render the current-period state each tick');
});

test('the settle boundary uses the earlier of nominal draw and measured rollover', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /Math\.min\(\.\.\.cands\)/,
    'publishing runs ahead of the nominal draw time, so the earlier instant must win');
});

/* ---------------------------------------------------------------- poller concurrency */

// setInterval does not await an async callback, so a poll slower than POLL_MS used to start a second
// refresh on the same mutable db, interleaving two merges and two saveDB() writes.
test('the poller is single-flight so two refreshes cannot mutate the ledger at once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /let refreshInFlight=null;/,
    'the refresh path needs an in-flight guard');
  const run = src.slice(src.indexOf('function runRefresh'), src.indexOf('function schedulePoll'));
  assert.match(run, /if\(refreshInFlight\)return refreshInFlight;/,
    'a second caller must join the in-flight refresh instead of starting another');
  assert.match(src, /setInterval\(\(\)=>\{pollOnce\(\)\.catch\(\(\)=>\{\}\);\},/,
    'the timer must not leave an unhandled rejection');
});

test('/api/history shares the single-flight path instead of refreshing directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf("app.get('/api/history'"), src.indexOf('// Server-side polling keeps'));
  assert.match(route, /await pollOnce\(\)/,
    'a manual refresh must serialize against the poller');
  assert.ok(!/await refreshHistory\(\)/.test(route),
    '/api/history must not bypass the in-flight guard');
});

// pollOnce rejects so /api/history can answer 502. Every unattended caller must catch, or Node
// terminates the process on an unhandled rejection — which is exactly what an offline provider
// triggered: the server died instead of retrying.
test('no unattended poller call can crash the process', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const starter = src.slice(src.indexOf('function startPoller'), src.indexOf("app.get('/api/analysis'"));
  assert.match(starter, /pollOnce\(\)\.catch\(/,
    'startPoller must catch, or a provider outage crashes the server at boot');
  assert.match(src, /setInterval\(\(\)=>\{pollOnce\(\)\.catch\(\(\)=>\{\}\);\},/,
    'the interval must catch as well');
});
/* ---------------------------------------------------------------- summary text */

// predictionSummary is served by both /api/predictions and /api/predictions/summary, so it cannot
// point at either one as "where the full breakdown lives" — that is a dead reference.
test('the shared prediction summary does not point at one of its own routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fn = src.slice(src.indexOf('function predictionSummary'), src.indexOf('// ---- Honest accuracy'));
  assert.ok(!/See \/api\/predictions\/summary for/.test(fn),
    'the summary text is served by that same route, so it cannot defer to it');
});

/* ---------------------------------------------------------------- config */

test('a malformed POLL_MS cannot turn the poller into a busy loop', () => {
  // Math.max(2000, NaN) is NaN, and setInterval(fn, NaN) coerces to a 1ms timer. A typo such as
  // POLL_MS=abc therefore hammered the provider continuously instead of honouring the 2.2s cadence.
  const fn = extractFunction('envMs');
  const run = (env) => vm.runInNewContext(`${fn};envMs`, makeContext({ process: { env } }));
  for (const bad of ['abc', '2400ms', 'NaN', 'Infinity', '']) {
    const poll = run({ POLL_MS: bad })('POLL_MS', 2200, 2000, 2500);
    assert.ok(Number.isFinite(poll), `POLL_MS=${JSON.stringify(bad)} produced ${poll}`);
    assert.ok(poll >= 2000 && poll <= 2500, `POLL_MS=${JSON.stringify(bad)} produced ${poll}, outside the documented range`);
  }
});

test('POLL_MS cannot be raised past the point where draws are silently lost', () => {
  // The provider serves only the 10 newest issues (~5 min). An interval of 1e9 passed the old floor
  // untouched, leaving one poll every ~11 days and losing every draw in between.
  const fn = extractFunction('envMs');
  const run = (env) => vm.runInNewContext(`${fn};envMs`, makeContext({ process: { env } }));
  assert.equal(run({ POLL_MS: '1e9' })('POLL_MS', 2200, 2000, 2500), 2500);
  assert.equal(run({ POLL_MS: '2501' })('POLL_MS', 2200, 2000, 2500), 2500);
  assert.equal(run({ POLL_MS: '2499' })('POLL_MS', 2200, 2000, 2500), 2499);
  assert.equal(run({ POLL_MS: '-5' })('POLL_MS', 2200, 2000, 2500), 2000);
});

/* ---------------------------------------------------------------- clock */

test('round clock reports a countdown inside one round', () => {
  const code = `
    ${extractConstLine('ROUND_MS')}
    ${extractConstLine('DEFAULT_PHASE_MS')}
    let db = { timing: { phaseMs: 27250, samples: 10 } };
    ${extractFunction('roundClock')}
    ;roundClock
  `;
  const roundClock = vm.runInNewContext(code, makeContext());
  for (const t of [0, 1000, 15000, 27000, 27250, 29000]) {
    const c = roundClock(t);
    assert.equal(c.roundMs, 30000);
    assert.ok(c.msToNext >= 0 && c.msToNext <= 30000, `msToNext ${c.msToNext} out of range at t=${t}`);
    assert.ok(c.elapsedFraction >= 0 && c.elapsedFraction <= 1);
    // Countdown and elapsed must always sum to exactly one round.
    assert.equal(c.msToNext + c.elapsedMs, 30000);
  }
});
