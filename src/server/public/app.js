// Aegis UI — vanilla JS, no framework.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  /** @type {null | any} */ config: null,
  /** @type {number[]} */    path: [],
  /** @type {number} */      day: 0,
  /** @type {null | any} */  lastQuote: null,
};

// --- HashScan deep-links ---
function normalizeTxId(txId) { return txId.replace('@', '-').replace(/\.(\d+)$/, '-$1'); }
function hashScanBase() { return `https://hashscan.io/${state.config?.network ?? 'testnet'}`; }
function accountLink(id) { return `<a href="${hashScanBase()}/account/${id}" target="_blank" rel="noreferrer noopener" class="mono">${id}</a>`; }
function txLink(txId) { return `<a href="${hashScanBase()}/transaction/${normalizeTxId(txId)}" target="_blank" rel="noreferrer noopener" class="mono">${txId}</a>`; }
function topicLink(id) { return `<a href="${hashScanBase()}/topic/${id}" target="_blank" rel="noreferrer noopener" class="mono">${id}</a>`; }
function fmt(n, dp = 2) { return Number(n).toFixed(dp); }

// --- API helpers ---
async function api(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? res.statusText);
  }
  return res.json();
}

// --- Boot ---
async function loadConfig() {
  state.config = await api('GET', '/api/config');
  const c = state.config;
  $('#meta').innerHTML = `
    <span>net <strong>${c.network}</strong></span>
    <span>buyer <strong>${accountLink(c.buyer)}</strong></span>
    <span>underwriter <strong>${accountLink(c.underwriter)}</strong></span>
    <span>topic <strong>${topicLink(c.topicId)}</strong></span>
  `;
  $('#autocap').textContent = String(c.payoutAutonomousCapHbar);
}

async function refreshFeed() {
  const f = await api('GET', '/api/feed');
  state.path = f.visiblePath;
  state.day = f.day;
  $('#rt').textContent = fmt(f.RT);
  $('#day').textContent = String(f.day);
  $('#feed-source').textContent = f.source;
  drawChart();
}

function drawChart() {
  const path = state.path;
  if (!path || path.length < 2) return;
  const W = 800, H = 180, padL = 40, padR = 12, padT = 10, padB = 22;
  const minY = Math.min(...path) * 0.95;
  const maxY = Math.max(...path) * 1.05;
  const xs = (i) => padL + (W - padL - padR) * (i / Math.max(1, path.length - 1));
  const ys = (v) => padT + (H - padT - padB) * (1 - (v - minY) / (maxY - minY || 1));
  const lineD = path.map((v, i) => `${i === 0 ? 'M' : 'L'}${xs(i).toFixed(1)} ${ys(v).toFixed(1)}`).join(' ');
  const areaD = `${lineD} L${xs(path.length - 1).toFixed(1)} ${ys(minY).toFixed(1)} L${xs(0).toFixed(1)} ${ys(minY).toFixed(1)} Z`;
  // strike marker: if there's a current open policy, draw its K
  let strikeMarker = '';
  if (state.lastQuote?.strikeUsdHr) {
    const y = ys(state.lastQuote.strikeUsdHr);
    strikeMarker = `<line class="strike-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}"/><text x="${(W - padR - 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="end">K=${state.lastQuote.strikeUsdHr}</text>`;
  }
  $('#chart').innerHTML = `
    <line class="axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" />
    <line class="axis" x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" />
    <text x="${padL - 4}" y="${(padT + 8).toFixed(1)}" text-anchor="end">${fmt(maxY)}</text>
    <text x="${padL - 4}" y="${(H - padB + 4).toFixed(1)}" text-anchor="end">${fmt(minY)}</text>
    <text x="${padL}" y="${H - 6}" text-anchor="start">day 0</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end">day ${path.length - 1}</text>
    <path class="area" d="${areaD}" />
    <path class="line" d="${lineD}" />
    ${strikeMarker}
  `;
}

async function submitQuote(ev) {
  ev.preventDefault();
  const fd = new FormData($('#quote-form'));
  const body = {
    strikeUsdHr: Number(fd.get('strikeUsdHr')),
    qtyGpuHr: Number(fd.get('qtyGpuHr')),
    windowDays: Number(fd.get('windowDays')),
    seed: 42,
  };
  const btn = $('#quote-btn');
  btn.disabled = true; btn.textContent = 'Pricing…';
  try {
    const q = await api('POST', '/api/quote', body);
    state.lastQuote = { ...body, ...q };
    $('#quote-out').hidden = false;
    $('#quote-kv').innerHTML = `
      <dt>R(t) at quote</dt><dd>$${fmt(q.R0)} / hr</dd>
      <dt>premium</dt><dd>${fmt(q.premiumHbar, 4)} HBAR <span class="muted">(\$${fmt(q.premiumUsd)})</span></dd>
      <dt>expected payout</dt><dd>${fmt(q.expectedPayoutHbar, 4)} HBAR <span class="muted">(P(ITM) ${(q.probInTheMoney * 100).toFixed(1)}%)</span></dd>
      <dt>risk load</dt><dd>${fmt(q.riskLoadHbar, 4)} HBAR</dd>
      <dt>ops load</dt><dd>${fmt(q.opsLoadHbar, 4)} HBAR</dd>
      <dt>CI 95%</dt><dd>[${fmt(q.ci95Hbar[0], 4)}, ${fmt(q.ci95Hbar[1], 4)}] HBAR</dd>
      <dt>max payout (p99)</dt><dd>${fmt(q.maxPayoutHbar, 2)} HBAR</dd>
      <dt>paths</dt><dd>${q.paths}</dd>
    `;
    drawChart();
  } catch (err) {
    alert(`Quote failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Quote';
  }
}

async function buyPolicy() {
  if (!state.lastQuote) return;
  const btn = $('#buy-btn');
  btn.disabled = true; btn.textContent = 'Settling premium…';
  try {
    const body = {
      strikeUsdHr: state.lastQuote.strikeUsdHr,
      qtyGpuHr: state.lastQuote.qtyGpuHr,
      windowDays: state.lastQuote.windowDays,
      seed: state.lastQuote.seed ?? 42,
    };
    const out = await api('POST', '/api/buy', body);
    alert(`Policy ${out.issued.envelope.policyId}\npremium tx: ${out.premiumTxId}\nseq #${out.issued.sequenceNumber}`);
    state.lastQuote = null;
    $('#quote-out').hidden = true;
    await refreshAll();
  } catch (err) {
    alert(`Buy failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Pay premium & issue policy';
  }
}

async function refreshPool() {
  const p = await api('GET', '/api/pool');
  $('#pool-balance').textContent = fmt(p.poolBalanceHbar);
  $('#pool-max').textContent = fmt(p.maxExposureHbar);
  $('#pool-current').textContent = fmt(p.currentExposureHbar);
  $('#pool-headroom').textContent = fmt(p.headroomHbar);
  $('#pool-count').textContent = String(p.activePolicyCount);
  const pct = p.maxExposureHbar > 0 ? Math.min(100, (p.currentExposureHbar / p.maxExposureHbar) * 100) : 0;
  $('#pool-bar-fill').style.width = `${pct}%`;
}

async function refreshPolicies() {
  const list = await api('GET', '/api/policies');
  const body = $('#policy-body');
  if (!list || list.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="muted">none yet</td></tr>`;
    return;
  }
  const now = Date.now();
  body.innerHTML = list.map((p) => {
    const expired = Date.parse(p.windowEndsTs) < now;
    return `<tr class="${expired ? 'expired' : ''}">
      <td class="mono">${p.policyId.slice(0, 14)}…</td>
      <td>${accountLink(p.buyer)}</td>
      <td>—</td><td>—</td>
      <td class="mono">${fmt(p.maxPayoutHbar)}</td>
      <td class="mono">${p.windowEndsTs.slice(0, 16).replace('T', ' ')}</td>
      <td><button class="ghost" data-settle="${p.policyId}">Settle</button></td>
    </tr>`;
  }).join('');
  for (const btn of body.querySelectorAll('button[data-settle]')) {
    btn.addEventListener('click', () => settle(btn.getAttribute('data-settle')));
  }
}

async function settle(policyId) {
  try {
    const out = await api('POST', '/api/settle', { policyId });
    if (out.kind === 'PAYOUT_AWAITING_APPROVAL') {
      $('#approval-card').hidden = false;
      $('#approval-kv').innerHTML = `
        <dt>policyId</dt><dd>${out.policyId}</dd>
        <dt>observed R</dt><dd>$${fmt(out.observedUsdHr)} / hr</dd>
        <dt>payout</dt><dd>${fmt(out.payoutHbar, 4)} HBAR</dd>
      `;
      $('#approval-bytes').textContent = out.unsignedTxBase64;
      $('#approve-btn').dataset.policy = out.policyId;
      $('#reject-btn').dataset.policy = out.policyId;
    } else if (out.kind === 'EXPIRED') {
      alert(`Policy ${policyId} expired with no payout (R=${out.settled.envelope.observedUsdHr.toFixed(2)} ≤ K)`);
    } else if (out.kind === 'AUTONOMOUS_PAID_OUT') {
      alert(`Paid out ${fmt(out.payoutHbar, 4)} HBAR\ntx: ${out.payoutTxId}`);
    }
    await refreshAll();
  } catch (err) {
    alert(`Settle failed: ${err.message}`);
  }
}

async function approvePayout() {
  const policyId = $('#approve-btn').dataset.policy;
  if (!policyId) return;
  const btn = $('#approve-btn');
  btn.disabled = true; btn.textContent = 'Signing…';
  try {
    const out = await api('POST', '/api/payout/approve', { policyId });
    alert(`Paid out ${fmt(out.payoutHbar, 4)} HBAR\ntx: ${out.payoutTxId}`);
    $('#approval-card').hidden = true;
    await refreshAll();
  } catch (err) {
    alert(`Approve failed: ${err.message}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Approve & sign';
  }
}

function rejectPayout() {
  $('#approval-card').hidden = true;
}

async function refreshLedger() {
  const ledger = await api('GET', '/api/ledger');
  const body = $('#ledger-body');
  if (!ledger.messages.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">empty</td></tr>`;
    return;
  }
  body.innerHTML = ledger.messages.map((m) => {
    const e = m.envelope;
    if (!e) return '';
    let summary = '';
    if (e.type === 'POLICY') summary = `${accountLink(e.buyer)} → ${accountLink(e.underwriter)} · K=$${e.strikeUsdHr} · Q=${e.qtyGpuHr} · ${fmt(e.premiumHbar, 4)} HBAR premium · expires ${e.windowEndsTs.slice(0, 10)} · premium ${txLink(e.premiumTxId)}`;
    else if (e.type === 'PRICE_REF') summary = `R=$${fmt(e.observedUsdHr)} · source <code>${e.source}</code>${e.policyId ? ' · for ' + e.policyId.slice(0, 14) + '…' : ''}`;
    else if (e.type === 'SETTLEMENT') summary = `<strong>${e.result}</strong> · ${e.policyId.slice(0, 14)}… · R=$${fmt(e.observedUsdHr)} · payout ${fmt(e.payoutHbar, 4)} HBAR${e.payoutTxId ? ' · ' + txLink(e.payoutTxId) : ''}`;
    else if (e.type === 'PROVIDER_CAPACITY') summary = `${accountLink(e.provider)} · ${e.qtyGpuHr} GPU-h @ $${e.askUsdHr}/hr`;
    return `<tr><td>${m.sequenceNumber}</td><td class="mono">${e.ts.slice(0, 19).replace('T', ' ')}</td><td class="type-cell ${e.type}">${e.type}</td><td>${summary}</td></tr>`;
  }).join('');
}

async function injectShock() {
  await api('POST', '/api/feed/shock', { magnitude: 1.6 });
  await refreshFeed();
}

async function advance(days) {
  await api('POST', '/api/feed/advance', { days });
  await refreshFeed();
  // Surface any newly-expired policies (UI prompt to settle).
  await refreshPolicies();
}

async function refreshAll() {
  await Promise.all([refreshFeed(), refreshPool(), refreshPolicies(), refreshLedger()]);
}

function attachEventStream() {
  const es = new EventSource('/api/events');
  es.addEventListener('tick', (ev) => {
    try {
      const t = JSON.parse(ev.data);
      // Update R(t) without re-fetching the whole path every tick.
      $('#rt').textContent = fmt(t.RT);
      $('#day').textContent = String(t.day);
      $('#feed-source').textContent = t.source;
      // Extend the local path so the chart keeps growing.
      if (state.path.length < t.day + 1) state.path.push(t.RT);
      else state.path[t.day] = t.RT;
      drawChart();
    } catch {}
  });
  es.addEventListener('envelope', () => {
    // Refresh the ledger + pool a few times with backoff to ride mirror lag.
    let n = 0;
    const tick = async () => {
      await Promise.all([refreshLedger(), refreshPool(), refreshPolicies()]);
      if (++n < 3) setTimeout(tick, 1500 * n);
    };
    tick();
  });
  es.onerror = () => {/* browser auto-reconnects */};
}

function bindEvents() {
  $('#quote-form').addEventListener('submit', submitQuote);
  $('#buy-btn').addEventListener('click', buyPolicy);
  $('#shock-btn').addEventListener('click', injectShock);
  $('#advance-btn').addEventListener('click', () => advance(5));
  $('#advance-30-btn').addEventListener('click', () => advance(30));
  $('#refresh-btn').addEventListener('click', refreshAll);
  $('#approve-btn').addEventListener('click', approvePayout);
  $('#reject-btn').addEventListener('click', rejectPayout);
}

(async function main() {
  try {
    await loadConfig();
    bindEvents();
    await refreshAll();
    attachEventStream();
  } catch (err) {
    document.body.innerHTML = `<pre style="padding:24px;color:#f88">${String(err?.message ?? err)}</pre>`;
  }
})();
