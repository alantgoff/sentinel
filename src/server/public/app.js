// Sentinel UI — vanilla JS, no framework. Talks to the Express API in src/server/app.js.

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  /** @type {null | { network: string, mirrorNodeUrl: string, topicId: string, buyer: string, seller: string, policy: any, service: any }} */
  config: null,
  /** @type {null | { kind: string, requestId: string, decision: any, quote?: any, unsignedTxBase64?: string, txId?: string, data?: any }} */
  lastOutcome: null,
};

function mirrorTxUrl(txId) {
  if (!state.config) return '#';
  const base = state.config.mirrorNodeUrl.replace(/\/+$/, '');
  return `${base}/api/v1/transactions/${txId.replace('@', '-').replace(/\.(\d+)$/, '-$1')}`;
}

function scoreClass(score) {
  if (score >= 70) return 'hi';
  if (score >= 40) return 'mid';
  return 'lo';
}

async function loadConfig() {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error('failed to load config');
  state.config = await res.json();

  const cfg = state.config;
  $('#meta').innerHTML = `
    <span>network <strong>${cfg.network}</strong></span>
    <span>buyer <strong>${cfg.buyer}</strong></span>
    <span>seller <strong>${cfg.seller}</strong></span>
    <span>topic <strong>${cfg.topicId}</strong></span>
  `;
  $('#price').textContent = String(cfg.service.priceHbarPerQuery);

  const sectorSelect = /** @type {HTMLSelectElement} */ ($('#buy-form select[name=sector]'));
  for (const s of cfg.service.sectors) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sectorSelect.appendChild(opt);
  }

  const ledgerInput = /** @type {HTMLInputElement} */ ($('#ledger-counterparty'));
  ledgerInput.placeholder = `0.0.xxxxxx — defaults to seller (${cfg.seller})`;
  ledgerInput.value = cfg.seller;
}

function readBuyForm() {
  const form = /** @type {HTMLFormElement} */ ($('#buy-form'));
  const fd = new FormData(form);
  /** @type {Record<string, any>} */
  const q = {};
  const company = String(fd.get('company') ?? '').trim();
  if (company) q.company = company;
  const sector = String(fd.get('sector') ?? '').trim();
  if (sector) q.sector = sector;
  const minAmt = String(fd.get('minAmountUsdM') ?? '').trim();
  if (minAmt) q.minAmountUsdM = Number(minAmt);
  const sinceDate = String(fd.get('sinceDate') ?? '').trim();
  if (sinceDate) q.sinceDate = sinceDate;
  const limit = Number(fd.get('limit') ?? '10');
  q.limit = limit;
  return q;
}

function renderDecision(outcome) {
  state.lastOutcome = outcome;
  $('#decision-card').hidden = false;
  $('#decision-card').classList.add('flash');
  setTimeout(() => $('#decision-card').classList.remove('flash'), 1500);

  const d = outcome.decision;
  $('#decision').innerHTML = `
    <span class="badge ${d.decision}">${d.decision}</span>
    <span>${d.ruleId}</span>
    <p class="hint" style="margin-top:6px">${d.reason}</p>
    <dl class="kv">
      <dt>counterparty</dt><dd>${d.reputation.counterparty}</dd>
      <dt>score</dt><dd>${d.reputation.score} / 100</dd>
      <dt>verified settlements</dt><dd>${d.reputation.verifiedSettlementCount} / ${d.reputation.totalSettlementClaims}</dd>
      <dt>verified volume</dt><dd>${d.reputation.verifiedVolumeHbar.toFixed(2)} HBAR</dd>
      <dt>effective autonomous cap</dt><dd>${d.effective.autonomousCapHbar} HBAR</dd>
      <dt>effective daily limit</dt><dd>${d.effective.dailyLimitHbar} HBAR</dd>
    </dl>
  `;
  if (d.reputation.reasons?.length) {
    $('#reasons-wrap').hidden = false;
    $('#reputation-reasons').textContent = d.reputation.reasons.join('\n');
  } else {
    $('#reasons-wrap').hidden = true;
  }

  $('#escalation').hidden = outcome.kind !== 'ESCALATED';
  $('#result').hidden = outcome.kind !== 'ALLOWED';

  if (outcome.kind === 'ESCALATED') {
    $('#unsigned-bytes').textContent = outcome.unsignedTxBase64;
  }
  if (outcome.kind === 'ALLOWED') {
    $('#result-data').textContent = JSON.stringify(outcome.data, null, 2);
    const a = /** @type {HTMLAnchorElement} */ ($('#result-tx'));
    a.href = mirrorTxUrl(outcome.txId);
    a.textContent = outcome.txId;
  }
}

async function submitBuy(ev) {
  ev.preventDefault();
  const btn = /** @type {HTMLButtonElement} */ ($('#buy-btn'));
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const query = readBuyForm();
    const res = await fetch('/api/buy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      alert(`Request failed: ${err.error}`);
      return;
    }
    const outcome = await res.json();
    renderDecision(outcome);
    await refreshLedger();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Request quote & settle';
  }
}

async function approve() {
  if (!state.lastOutcome || state.lastOutcome.kind !== 'ESCALATED') return;
  const btn = /** @type {HTMLButtonElement} */ ($('#approve-btn'));
  btn.disabled = true;
  btn.textContent = 'Signing…';
  try {
    const res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: state.lastOutcome.requestId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      alert(`Approve failed: ${err.error}`);
      return;
    }
    const outcome = await res.json();
    renderDecision(outcome);
    await refreshLedger();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Approve & sign';
  }
}

async function reject() {
  if (!state.lastOutcome || state.lastOutcome.kind !== 'ESCALATED') return;
  await fetch('/api/reject', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: state.lastOutcome.requestId }),
  });
  $('#escalation').hidden = true;
  state.lastOutcome = null;
}

async function refreshLedger() {
  const counterparty = /** @type {HTMLInputElement} */ ($('#ledger-counterparty')).value.trim() || state.config?.seller;
  const [ledgerRes, repRes] = await Promise.all([
    fetch(`/api/ledger?counterparty=${encodeURIComponent(counterparty)}`),
    fetch(`/api/reputation?counterparty=${encodeURIComponent(counterparty)}`),
  ]);
  const ledger = await ledgerRes.json();
  const rep = await repRes.json();
  renderLedger(ledger);
  renderRepChip(rep);
}

function renderRepChip(rep) {
  const chip = $('#rep-chip');
  chip.hidden = false;
  chip.innerHTML = `
    <span class="muted">${rep.counterparty}</span>
    <span class="score ${scoreClass(rep.score)}">${rep.score}/100</span>
    <span>· ${rep.verifiedSettlementCount}/${rep.totalSettlementClaims} verified</span>
    <span>· ${rep.verifiedVolumeHbar.toFixed(2)} HBAR</span>
  `;
}

function renderLedger(ledger) {
  const tbody = $('#ledger-body');
  tbody.innerHTML = '';
  for (const m of ledger.messages) {
    const env = m.envelope;
    if (!env) continue;
    const tr = document.createElement('tr');
    tr.classList.add(`type-${env.type}`);
    const verif = m.verification;
    if (verif && !verif.verified) tr.classList.add('unverified');

    const ruleOrTx =
      env.type === 'SETTLEMENT' ? env.txId :
      env.type === 'POLICY_DECISION' || env.type === 'DENIAL' ? `${env.policy.ruleId} (${env.policy.result})` :
      env.type === 'QUOTE' ? `expires ${env.quoteExpiresAt ?? '—'}` :
      '';

    const verifCell =
      env.type !== 'SETTLEMENT' ? '<span class="verif-pill skip">n/a</span>' :
      !verif ? '<span class="verif-pill skip">checking…</span>' :
      verif.verified ? '<span class="verif-pill ok">on mirror</span>' :
      `<span class="verif-pill bad">${verif.result ?? 'unverified'}</span>`;

    tr.innerHTML = `
      <td>${m.sequenceNumber}</td>
      <td class="mono">${env.ts}</td>
      <td class="type-cell">${env.type}</td>
      <td class="mono">${env.buyer} → ${env.seller}</td>
      <td>${env.amountHbar}</td>
      <td class="mono">${ruleOrTx}</td>
      <td>${verifCell}</td>
    `;
    tbody.appendChild(tr);
  }
}

function bindEvents() {
  $('#buy-form').addEventListener('submit', submitBuy);
  $('#approve-btn').addEventListener('click', approve);
  $('#reject-btn').addEventListener('click', reject);
  $('#refresh-btn').addEventListener('click', refreshLedger);
  $('#ledger-counterparty').addEventListener('change', refreshLedger);
}

function attachEventStream() {
  const es = new EventSource('/api/events');
  es.addEventListener('envelope', () => {
    // The server already submitted to HCS — but mirror-node lag means it
    // may not appear in a refreshed ledger immediately. Poll a few times
    // with backoff so the new row appears within ~10s.
    let attempt = 0;
    const tryRefresh = async () => {
      await refreshLedger();
      attempt += 1;
      if (attempt < 4) setTimeout(tryRefresh, 1500 * attempt);
    };
    tryRefresh();
  });
  es.onerror = () => {
    // Reconnect handled by browser; ignore.
  };
}

(async function main() {
  try {
    await loadConfig();
    bindEvents();
    await refreshLedger();
    attachEventStream();
  } catch (err) {
    document.body.innerHTML = `<pre style="padding:24px;color:#f88">${String(err?.message ?? err)}</pre>`;
  }
})();
