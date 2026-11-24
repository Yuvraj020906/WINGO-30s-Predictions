/* 30 Seconds Dashboard — presentation only.
   All prediction and statistics logic lives on the server; this file renders what
   /api/dashboard returns and never invents a number. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 8;   // results per page, per the layout spec
  const state = {
    market: 'bigSmall',
    data: null,
    clockOffset: 0,      // serverTime - clientTime, so the countdown tracks the server
    clock: null,
    page: 1,             // 1-based page index; survives the 10s auto-refresh
  };

  /* ---------------- helpers ---------------- */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x, d = 0) => (x == null || Number.isNaN(x) ? '—' : (x * 100).toFixed(d) + '%');
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const clockNow = () => Date.now() + state.clockOffset;

  function fmtStamp(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  const ICON = {
    check: '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    x: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  };

  async function api(url, opts) {
    const r = await fetch(url, { cache: 'no-store', ...opts });
    let j;
    try { j = await r.json(); } catch { throw new Error(`Server returned non-JSON (HTTP ${r.status})`); }
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  function showError(msg) {
    const el = $('err');
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  /* ---------------- countdown (client-side, server-anchored) ---------------- */
  // The server measures the publish phase; the browser only interpolates between polls so the
  // digits move every second. Nothing here decides a prediction.
  let tickTimer = null;
  function startTicking() {
    if (tickTimer) return;
    tickTimer = setInterval(renderClock, 250);
  }

  function roundClockClient() {
    if (!state.clock) return null;
    const { roundMs, phaseMs, msToNext } = state.clock;
    // Re-derive from server time each tick so a slow response cannot accumulate drift.
    const nowMod = ((clockNow() % roundMs) + roundMs) % roundMs;
    let left;
    if (nowMod < phaseMs) left = phaseMs - nowMod;
    else left = roundMs - nowMod + phaseMs;
    // How long was left at serverTime, decayed by real time since that response.
    // The page polls every 10s but a round is only 30s, so this value goes negative well before
    // the next poll arrives. Clamping a negative to 0 — which is what the previous version did —
    // froze the display at "0s / 100%" until the next poll landed, i.e. for up to a whole round
    // whenever a poll was slow. Draws are periodic, so a negative remainder wraps to the same
    // position inside the following round.
    let anch = msToNext - (Date.now() - (state.data ? state.data.serverTime : Date.now()));
    if (!Number.isFinite(anch)) return { msLeft: left, elapsed: roundMs - left, roundMs };
    if (anch < 0) anch = ((anch % roundMs) + roundMs) % roundMs;
    const msLeft = Math.max(0, Math.min(roundMs, anch));
    return { msLeft, elapsed: roundMs - msLeft, roundMs, derived: left };
  }

  function renderClock() {
    const c = roundClockClient();
    if (!c) return;
    const secs = Math.max(0, Math.ceil(c.msLeft / 1000));
    const p = Math.min(1, Math.max(0, c.elapsed / c.roundMs));
    $('timer-secs').textContent = `${secs}s`;
    $('timer-pct').textContent = `${Math.round(p * 100)}%`;
    $('timer-bar').style.width = `${(p * 100).toFixed(1)}%`;
    // Do not overwrite a feed-down notice with a countdown that is no longer being fed.
    const failed = state.data && state.data.pollError && state.data.pollError.message;
    $('next-in').textContent = failed ? 'Feed down' : `Next in ${secs}s`;
    // The card's own label is time-dependent (a round stops being an open forecast at its draw),
    // so it has to be re-evaluated on the tick, not only when a poll lands.
    if (state.data) renderCurrentState(state.data);
  }

  /* ---------------- current period ---------------- */
  // A round that has already drawn is not an open forecast. The poll only arrives every 10s, so
  // between the draw and the next poll the card would otherwise keep saying "LOCKED IN" about a
  // settled round.
  //
  // Which instant counts as drawn: the nominal drawAt is derived from the period number, while
  // clock.nextDrawAt is the *measured* publish rollover. The provider publishes slightly ahead of
  // the nominal draw time (observed ~2.2-2.8s), so the measured boundary is the earlier of the two
  // and is the one that actually makes the result public. Take whichever comes first, so the card
  // never claims an open forecast for a round whose outcome is already published.
  function settledAt(cur) {
    if (!cur) return null;
    const cands = [];
    if (Number.isFinite(cur.drawAt)) cands.push(cur.drawAt);
    const n = state.clock && state.clock.nextDrawAt;
    if (Number.isFinite(n)) cands.push(n);
    return cands.length ? Math.min(...cands) : null;
  }

  function forecastSettled(cur) {
    const at = settledAt(cur);
    return at !== null && clockNow() >= at;
  }

  // Cheap, idempotent, and called from the 250ms tick as well as from the poll: only the two
  // time-dependent labels are touched, so it never fights the rest of the card.
  function renderCurrentState(d) {
    const cur = d && d.current;
    if (!cur) return;
    const settled = forecastSettled(cur);
    $('cp-state').textContent = settled ? 'AWAITING RESULT' : 'LOCKED IN';
    if (settled) {
      const at = settledAt(cur);
      $('cp-made').textContent = `Drawn ${fmtStamp(new Date(at).toISOString())} — reconciling`;
    } else {
      $('cp-made').textContent = `Recorded ${fmtStamp(cur.predictionTime)}`;
    }
  }

  function renderCurrent(d) {
    const cur = d.current;
    if (!cur) {
      $('cp-state').textContent = 'NO OPEN FORECAST';
      $('cp-period').textContent = d.latest ? d.latest.period : '—';
      $('cp-made').textContent = 'Waiting for the ledger to open a round.';
      $('pick-bs-tile').textContent = '–';
      $('pick-bs-cap').textContent = 'Big/Small';
      $('pick-color-cap').textContent = 'Colour';
      return;
    }

    renderCurrentState(d);
    $('cp-period').textContent = cur.period;

    const bs = cur.predictedBigSmall === 'Small' ? 'Small' : 'Big';
    const tile = $('pick-bs-tile');
    const wrap = $('pick-bs');
    tile.textContent = bs === 'Big' ? 'B' : 'S';
    $('pick-bs-cap').textContent = bs.toUpperCase();
    wrap.classList.toggle('small', bs === 'Small');

    const colour = String(cur.predictedColor || '').toLowerCase();
    const sw = $('pick-color-sw');
    sw.className = colour === 'green' ? 'sw-green' : colour === 'violet' ? 'sw-violet' : 'sw-red';
    $('pick-color-cap').textContent = colour ? colour.toUpperCase() : 'COLOUR';
  }

  /* ---------------- result rows ---------------- */
  function rowHTML(r) {
    const cls = r.win ? 'win' : 'loss';
    const oc = String(r.type || '').toLowerCase() === 'big' ? 'big' : 'small';
    const pill = r.win
      ? `<span class="pill win">${ICON.check}Win</span>`
      : `<span class="pill loss">${ICON.x}Loss</span>`;
    return `<div class="row ${cls}">
      <div class="digit">${esc(r.digit)}</div>
      <div class="mid">
        <div class="pid">${esc(r.period)}</div>
        <div class="meta">
          <span class="outcome ${oc}">${esc(r.type)}</span>
          <span class="predict">Predict: <b>${esc(r.prediction)}</b></span>
        </div>
      </div>
      <div>${pill}</div>
    </div>`;
  }

  function renderRows(d) {
    const w = d.window;
    const label = w.shown === w.requested ? `Last ${w.requested}` : `Last ${w.shown}`;
    $('lastn-title').textContent = `${label} Results`;
    $('wl-w').textContent = `${w.wins}W`;
    $('wl-l').textContent = `${w.losses}L`;

    // The window header still counts every fetched result (that is the honest total);
    // only the rows are paged, so W/L never changes as you page through.
    const total = w.rows.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    // A new draw arrives every 30s. Keep the reader on their page unless it no longer exists.
    if (state.page > pages) state.page = pages;
    if (state.page < 1) state.page = 1;

    const box = $('rows');
    if (!total) {
      box.innerHTML = `<div class="empty">No verified results yet.<br>Results appear here only after the round resolves and the prediction is reconciled — nothing is filled in or inferred.</div>`;
    } else {
      const start = (state.page - 1) * PAGE_SIZE;
      box.innerHTML = w.rows.slice(start, start + PAGE_SIZE).map(rowHTML).join('');
    }

    renderPager(total, pages);

    const parts = [];
    if (total) {
      const start = (state.page - 1) * PAGE_SIZE;
      const end = Math.min(start + PAGE_SIZE, total);
      parts.push(`Showing ${start + 1}–${end} of ${total}`);
    }
    if (w.available > w.shown) parts.push(`${w.available} verified rows available, showing ${w.shown}`);
    // State the exclusions where the numbers are, not in a footnote nobody reads. A reader who sees
    // "182W 138L" is entitled to know which records were left out and why.
    const acc = d.accuracy;
    if (acc) {
      const ex = [];
      if (acc.excludedRetroactive) ex.push(`${acc.excludedRetroactive} recorded after the draw`);
      if (acc.excludedLegacyCommitment) ex.push(`${acc.excludedLegacyCommitment} with a commitment generated after the fact`);
      if (acc.abandoned) ex.push(`${acc.abandoned} lost to collection gaps`);
      if (ex.length) parts.push(`Excluded from accuracy: ${ex.join(', ')}`);
    }
    $('rows-note').textContent = parts.length
      ? parts.join(' · ') + '.'
      : `Win means the ${d.market === 'colour' ? 'colour' : d.market === 'number' ? 'number' : 'Big/Small'} pick matched the draw. Losses are never hidden.`;
  }

  /* ---------------- pagination ---------------- */
  function renderPager(total, pages) {
    const pager = $('pager');
    // Nothing to page through — stay out of the way rather than showing "1 / 1".
    pager.hidden = total <= PAGE_SIZE;
    $('page-prev').disabled = state.page <= 1;
    $('page-next').disabled = state.page >= pages;
    $('page-info').textContent = `${state.page} / ${pages}`;
  }

  function gotoPage(n, pages) {
    const next = Math.min(Math.max(1, n), Math.max(1, pages));
    if (next === state.page) return;
    state.page = next;
    // Re-render only the list and pager: no network call, no page reload, no scroll jump.
    if (state.data) renderRows(state.data);
    $('rows').scrollTop = 0;
  }

  /* ---------------- tabs ---------------- */
  function renderTabs(d) {
    // Percentages describe the same "Last N" window as the list, so the header and the rows agree.
    const w = d.windows || {};
    $('tab-colour-pct').textContent = w.colour ? pct(w.colour.accuracy, 0) : '—';
    $('tab-bs-pct').textContent = w.bigSmall ? pct(w.bigSmall.accuracy, 0) : '—';
    document.querySelectorAll('.tab').forEach((t) => {
      t.setAttribute('aria-selected', String(t.dataset.market === state.market));
    });
  }

  /* ---------------- header/status ---------------- */
  function renderStatus(d) {
    // Three distinct states, because "Live" when the provider is unreachable would be a lie:
    //   Live      - last poll succeeded and is recent
    //   Delayed   - the last poll succeeded but is older than 90s (poller stalled)
    //   Stale     - the most recent poll attempt failed outright
    const failed = d.pollError && d.pollError.message;
    $('livedot').classList.toggle('stale', d.stale === true || !!failed);
    $('live-label').textContent = failed ? 'Stale' : d.stale ? 'Delayed' : 'Live';
    if (failed) {
      $('next-in').textContent = 'Feed down';
      $('next-in').title = `${failed} (retrying)`;
    } else {
      $('next-in').title = '';
    }

    // The badge reports the live streak in the selected market — a fact from resolved rounds,
    // not a claim about the next one.
    const s = d.window && d.window.streak;
    const badge = $('streak-badge');
    if (s && s.length > 0) {
      badge.classList.remove('muted');
      badge.classList.toggle('loss', s.kind === 'loss');
      const n = s.length;
      const noun = s.kind === 'win' ? (n === 1 ? 'win' : 'wins') : (n === 1 ? 'loss' : 'losses');
      $('streak-text').textContent = `${n} ${noun} in a row`;
    } else {
      badge.classList.add('muted');
      $('streak-text').textContent = 'No resolved rounds';
    }
  }

  /* ---------------- coverage ---------------- */
  // Coverage is not accuracy. It says how much of the game's timeline is actually stored, so a
  // partial dataset is never presented as complete. The provider only serves the 10 newest issues,
  // so every server outage leaves a permanent hole.
  function renderCoverage(d) {
    const c = d.coverage;
    const el = $('coverage-note');
    if (!c || !c.storedResults) { el.textContent = ''; return; }
    const parts = [];
    if (c.coverage != null) parts.push(`${pct(c.coverage, 0)} of rounds in span stored`);
    if (c.missingRounds) parts.push(`${c.missingRounds.toLocaleString()} missing in ${c.gapCount} gap${c.gapCount === 1 ? '' : 's'}`);
    el.textContent = parts.length ? `Coverage: ${parts.join(' · ')}.` : '';
  }

  /* ---------------- data flow ---------------- */
  async function load(opts = {}) {
    const btn = $('btn-refresh');
    if (opts.spin) btn.classList.add('spinning');
    try {
      if (opts.refreshHistory) {
        // Ask the server to pull the provider before rendering, so Refresh means refresh.
        await fetch('/api/history', { cache: 'no-store' }).catch(() => {});
      }
      const d = await api(`/api/dashboard?window=1000&market=${state.market}`);
      state.data = d;
      // Anchor the browser clock to the server's, rounded to avoid jitter on slow links.
      state.clockOffset = d.serverTime - Date.now();
      state.clock = d.clock;
      $('cp-state').textContent = '';
      renderCurrent(d);
      renderRows(d);
      renderTabs(d);
      renderStatus(d);
      renderCoverage(d);
      renderClock();
      startTicking();
      showError(null);
    } catch (e) {
      showError(`Cannot reach the server: ${e.message}`);
      $('live-label').textContent = 'Offline';
      $('livedot').classList.add('stale');
    } finally {
      if (opts.spin) setTimeout(() => btn.classList.remove('spinning'), 400);
    }
  }

  /* ---------------- events ---------------- */
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      if (state.market === t.dataset.market) return;
      state.market = t.dataset.market;
      // A different market is a different list; start it at its newest result.
      state.page = 1;
      document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      load();
    });
  });

  $('page-prev').addEventListener('click', () => {
    const total = state.data ? state.data.window.rows.length : 0;
    gotoPage(state.page - 1, Math.ceil(total / PAGE_SIZE) || 1);
  });
  $('page-next').addEventListener('click', () => {
    const total = state.data ? state.data.window.rows.length : 0;
    gotoPage(state.page + 1, Math.ceil(total / PAGE_SIZE) || 1);
  });

  $('btn-refresh').addEventListener('click', () => load({ spin: true, refreshHistory: true }));

  // Re-render when the tab comes back so the numbers are not stale after being hidden.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  load();
  setInterval(() => load(), 10000);
})();
