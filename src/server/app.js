import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { bootstrapAegis } from '../bootstrap.js';
import { readEnvelopes } from '../hedera/hcs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, 'public');
const projectRoot = resolve(__dirname, '..', '..');

/**
 * In-memory map of payouts awaiting human approval.
 *   key:   policyId
 *   value: { policyId, buyer, observedUsdHr, payoutHbar, unsignedTxBase64 }
 * A restart wipes them — fine for demo, documented in LIMITATIONS.md.
 *
 * @type {Map<string, any>}
 */
const pendingPayouts = new Map();

/** @type {Array<(env: any) => void>} */
const envelopeListeners = [];
/** @type {Array<(tick: any) => void>} */
const tickListeners = [];

function broadcastEnvelope(env) {
  for (const l of envelopeListeners) {
    try { l(env); } catch (err) { console.error('envelope listener error', err); }
  }
}
function broadcastTick(tick) {
  for (const l of tickListeners) {
    try { l(tick); } catch (err) { console.error('tick listener error', err); }
  }
}

const aegis = bootstrapAegis({
  onSubmit: broadcastEnvelope,
  onTick: broadcastTick,
});

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(publicDir, { maxAge: '5m', extensions: ['html'] }));

app.get('/LIMITATIONS.md', (_req, res) => {
  res.type('text/markdown').sendFile(resolve(projectRoot, 'LIMITATIONS.md'));
});

app.get('/api/config', (_req, res) => {
  res.json({
    network: aegis.cfg.HEDERA_NETWORK,
    mirrorNodeUrl: aegis.cfg.MIRROR_NODE_URL,
    topicId: aegis.cfg.AEGIS_TOPIC_ID,
    buyer: aegis.buyerAccountId,
    underwriter: aegis.underwriterAccountId,
    provider: aegis.providerAccountId,
    underwriterIsBuyer: aegis.underwriterIsBuyer,
    hbarUsdPrice: aegis.hbarUsdPrice,
    payoutAutonomousCapHbar: aegis.cfg.PAYOUT_AUTONOMOUS_CAP_HBAR,
    maxExposureRatio: aegis.cfg.MAX_EXPOSURE_RATIO,
    priceParams: aegis.priceParams,
  });
});

app.get('/api/feed', (_req, res) => {
  res.json({
    ...aegis.priceFeed.snapshot(),
    visiblePath: aegis.priceFeed.visiblePath(),
  });
});

app.post('/api/feed/shock', (req, res) => {
  const magnitude = Number(req.body?.magnitude ?? 1.6);
  if (!(magnitude > 0)) return res.status(400).json({ error: 'magnitude must be > 0' });
  aegis.priceFeed.injectShock(magnitude);
  res.json({ ok: true, ...aegis.priceFeed.snapshot() });
});

app.post('/api/feed/advance', (req, res) => {
  const days = Math.max(1, Math.floor(Number(req.body?.days ?? 1)));
  aegis.priceFeed.advance(days);
  res.json({ ok: true, ...aegis.priceFeed.snapshot() });
});

const QuoteBody = z.object({
  strikeUsdHr: z.number().positive().finite(),
  qtyGpuHr: z.number().positive().finite(),
  windowDays: z.number().int().min(1).max(180),
  maxPayoutUsd: z.number().positive().finite().optional(),
  seed: z.number().int().nonnegative().optional(),
});

app.post('/api/quote', async (req, res, next) => {
  try {
    const body = QuoteBody.parse(req.body);
    const quote = await aegis.buyer.requestQuote(body);
    res.json(quote);
  } catch (err) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'invalid quote params', issues: err.issues });
    next(err);
  }
});

app.post('/api/buy', async (req, res, next) => {
  try {
    const body = QuoteBody.parse(req.body);
    const result = await aegis.buyer.requestPolicy(body);
    res.json(result);
  } catch (err) {
    if (err?.name === 'ZodError') return res.status(400).json({ error: 'invalid quote params', issues: err.issues });
    next(err);
  }
});

app.post('/api/settle', async (req, res, next) => {
  try {
    const { policyId } = req.body ?? {};
    if (!policyId) return res.status(400).json({ error: 'policyId required' });
    const active = aegis.exposure.get(policyId);
    if (!active) return res.status(404).json({ error: 'policy not active or already settled' });
    // Look up the policy's K/Q from the active set + the original POLICY envelope
    // (the active set only stores maxPayoutHbar + windowEndsTs; we need K/Q for
    // payout math). Fetch from the topic.
    const items = await readEnvelopes(aegis.mirror, aegis.cfg.AEGIS_TOPIC_ID);
    const policyEnv = items.find(({ envelope }) => envelope?.type === 'POLICY' && envelope.policyId === policyId)?.envelope;
    if (!policyEnv || policyEnv.type !== 'POLICY') return res.status(404).json({ error: 'POLICY envelope not found on topic' });

    const result = await aegis.underwriter.settle({
      policyId,
      buyer: policyEnv.buyer,
      observedUsdHr: aegis.priceFeed.getRT(),
      strikeUsdHr: policyEnv.strikeUsdHr,
      qtyGpuHr: policyEnv.qtyGpuHr,
      maxPayoutHbar: policyEnv.maxPayoutHbar,
      hbarUsdPrice: aegis.hbarUsdPrice,
    });

    if (result.kind === 'PAYOUT_AWAITING_APPROVAL') {
      pendingPayouts.set(policyId, {
        ...result,
        buyer: policyEnv.buyer,
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/payout/approve', async (req, res, next) => {
  try {
    const { policyId } = req.body ?? {};
    const pending = pendingPayouts.get(policyId);
    if (!pending) return res.status(404).json({ error: 'no pending payout for that policyId' });
    pendingPayouts.delete(policyId);
    const final = await aegis.underwriter.finalizeApprovedPayout({
      policyId: pending.policyId,
      buyer: pending.buyer,
      observedUsdHr: pending.observedUsdHr,
      payoutHbar: pending.payoutHbar,
    });
    res.json(final);
  } catch (err) {
    next(err);
  }
});

app.get('/api/pool', async (_req, res, next) => {
  try {
    const status = await aegis.underwriter.poolStatus();
    res.json(status);
  } catch (err) {
    next(err);
  }
});

app.get('/api/policies', async (_req, res, next) => {
  try {
    const list = await aegis.underwriter.listPolicies();
    res.json(list);
  } catch (err) {
    next(err);
  }
});

app.get('/api/ledger', async (_req, res, next) => {
  try {
    const items = await readEnvelopes(aegis.mirror, aegis.cfg.AEGIS_TOPIC_ID);
    res.json({
      topicId: aegis.cfg.AEGIS_TOPIC_ID,
      count: items.length,
      messages: items.map(({ raw, envelope }) => ({
        sequenceNumber: raw.sequence_number,
        consensusTimestamp: raw.consensus_timestamp,
        envelope,
      })),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const envListener = (env) => res.write(`event: envelope\ndata: ${JSON.stringify(env)}\n\n`);
  const tickListener = (tick) => res.write(`event: tick\ndata: ${JSON.stringify(tick)}\n\n`);
  envelopeListeners.push(envListener);
  tickListeners.push(tickListener);

  req.on('close', () => {
    clearInterval(heartbeat);
    const i = envelopeListeners.indexOf(envListener);
    if (i >= 0) envelopeListeners.splice(i, 1);
    const j = tickListeners.indexOf(tickListener);
    if (j >= 0) tickListeners.splice(j, 1);
  });
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    network: aegis.cfg.HEDERA_NETWORK,
    topicId: aegis.cfg.AEGIS_TOPIC_ID,
    buyer: aegis.buyerAccountId,
    underwriter: aegis.underwriterAccountId,
  });
});

app.use((err, _req, res, _next) => {
  console.error('[aegis]', err);
  res.status(500).json({ error: err?.message ?? 'internal error' });
});

const port = aegis.cfg.PORT;
app.listen(port, () => {
  console.log(`\nAegis listening on http://localhost:${port}`);
  console.log(`  network:     ${aegis.cfg.HEDERA_NETWORK}`);
  console.log(`  topic:       ${aegis.cfg.AEGIS_TOPIC_ID}`);
  console.log(`  buyer:       ${aegis.buyerAccountId}`);
  console.log(`  underwriter: ${aegis.underwriterAccountId}`);
  console.log(`  R(t):        $${aegis.priceFeed.getRT().toFixed(2)}/hr  (${aegis.priceFeed.getSource()})`);
});

process.on('SIGTERM', () => { aegis.close(); process.exit(0); });
process.on('SIGINT', () => { aegis.close(); process.exit(0); });
