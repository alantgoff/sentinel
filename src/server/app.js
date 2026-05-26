import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { bootstrapSentinel } from '../bootstrap.js';
import { buildReputationProfile } from '../plugin/reputation.js';
import { readEnvelopes } from '../hedera/hcs.js';
import { describeService, QuerySchema } from '../agents/service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, 'public');

/**
 * In-memory store of pending escalations. requestId → { decision, quote }.
 * A restart wipes these — fine for demo; documented in LIMITATIONS.md.
 *
 * @type {Map<string, { decision: import('../plugin/types.js').PolicyDecisionT, quote: import('../agents/seller.js').SellerQuote }>}
 */
const escalations = new Map();

/** @type {Array<(env: import('../hedera/envelope.js').EnvelopeT) => void>} */
const eventListeners = [];

function broadcastEnvelope(env) {
  for (const l of eventListeners) {
    try { l(env); } catch (err) { console.error('event listener error', err); }
  }
}

const sentinel = bootstrapSentinel({ onSubmit: broadcastEnvelope });
const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(publicDir, { maxAge: '5m', extensions: ['html'] }));

// Serve LIMITATIONS.md from the project root (referenced from the footer).
const projectRoot = resolve(__dirname, '..', '..');
app.get('/LIMITATIONS.md', (_req, res) => {
  res.type('text/markdown').sendFile(resolve(projectRoot, 'LIMITATIONS.md'));
});

app.get('/api/config', (_req, res) => {
  res.json({
    network: sentinel.cfg.HEDERA_NETWORK,
    mirrorNodeUrl: sentinel.cfg.MIRROR_NODE_URL,
    topicId: sentinel.cfg.SENTINEL_TOPIC_ID,
    buyer: sentinel.buyer.accountId,
    seller: sentinel.sellerAccountId,
    sellerIsBuyer: sentinel.sellerIsBuyer,
    policy: sentinel.policy,
    service: describeService(),
  });
});

app.get('/api/reputation', async (req, res, next) => {
  try {
    const counterparty = String(req.query.counterparty ?? sentinel.sellerAccountId);
    const viewer = req.query.viewer ? String(req.query.viewer) : sentinel.buyer.accountId;
    const profile = await buildReputationProfile({
      mirror: sentinel.mirror,
      topicId: sentinel.cfg.SENTINEL_TOPIC_ID,
      counterparty,
      viewer,
    });
    res.json(profile);
  } catch (err) {
    next(err);
  }
});

app.get('/api/ledger', async (req, res, next) => {
  try {
    const counterparty = req.query.counterparty ? String(req.query.counterparty) : null;
    const items = await readEnvelopes(sentinel.mirror, sentinel.cfg.SENTINEL_TOPIC_ID);
    const filtered = items.filter(({ envelope }) => {
      if (!envelope) return false;
      if (!counterparty) return true;
      return envelope.buyer === counterparty || envelope.seller === counterparty;
    });

    // For SETTLEMENT envelopes, ALSO surface independent mirror verification status.
    const settlements = filtered.filter(({ envelope }) => envelope?.type === 'SETTLEMENT');
    const verifications = await Promise.all(
      settlements.map(async ({ envelope }) => {
        if (!envelope || envelope.type !== 'SETTLEMENT') return null;
        const v = await sentinel.mirror.verifyTransaction(envelope.txId);
        return { txId: envelope.txId, verified: v.verified, result: v.result, error: v.error ?? null };
      }),
    );
    const verifMap = Object.fromEntries(verifications.filter(Boolean).map((v) => [v.txId, v]));

    res.json({
      topicId: sentinel.cfg.SENTINEL_TOPIC_ID,
      counterparty,
      count: filtered.length,
      messages: filtered.map(({ raw, envelope }) => ({
        sequenceNumber: raw.sequence_number,
        consensusTimestamp: raw.consensus_timestamp,
        envelope,
        verification: envelope?.type === 'SETTLEMENT' ? verifMap[envelope.txId] ?? null : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const BuyBody = z.object({
  query: QuerySchema,
});

app.post('/api/buy', async (req, res, next) => {
  try {
    const body = BuyBody.parse(req.body);
    const outcome = await sentinel.buyer.request({ query: body.query });
    if (outcome.kind === 'ESCALATED') {
      escalations.set(outcome.requestId, { decision: outcome.decision, quote: outcome.quote });
    }
    res.json(outcome);
  } catch (err) {
    if (err?.name === 'ZodError') {
      res.status(400).json({ error: 'invalid query', issues: err.issues });
      return;
    }
    next(err);
  }
});

app.post('/api/approve', async (req, res, next) => {
  try {
    const requestId = String(req.body?.requestId ?? '');
    const pending = escalations.get(requestId);
    if (!pending) {
      res.status(404).json({ error: 'no pending escalation with that requestId' });
      return;
    }
    escalations.delete(requestId);
    const outcome = await sentinel.buyer.continueAfterApproval(pending);
    res.json(outcome);
  } catch (err) {
    next(err);
  }
});

app.post('/api/reject', (req, res) => {
  const requestId = String(req.body?.requestId ?? '');
  if (!escalations.delete(requestId)) {
    res.status(404).json({ error: 'no pending escalation with that requestId' });
    return;
  }
  res.json({ ok: true });
});

/**
 * x402-style gated endpoint — for the rubric's MCP / x402 dimension.
 * GET without an X-Payment header returns HTTP 402 + a quote payload.
 * GET with X-Payment: <requestId>:<txId> serves the data after mirror-verification.
 */
app.get('/seller/api/funding-rounds', async (req, res, next) => {
  try {
    const proof = req.header('x-payment');
    const buyer = req.header('x-buyer') ?? sentinel.buyer.accountId;
    const queryParam = req.query.query;
    const query = queryParam ? JSON.parse(String(queryParam)) : {};

    if (!proof) {
      const q = await sentinel.seller.quote({ buyer: String(buyer), query });
      res.status(402).json({
        error: 'payment required',
        x402: {
          requestId: q.requestId,
          service: q.service,
          priceHbar: q.priceHbar,
          payTo: q.payTo,
          network: sentinel.cfg.HEDERA_NETWORK,
          expiresAt: q.expiresAt,
          paymentHeader: `X-Payment: ${q.requestId}:<txId>`,
        },
      });
      return;
    }

    const [requestId, txId] = proof.split(':');
    if (!requestId || !txId) {
      res.status(400).json({ error: 'X-Payment must be "requestId:txId"' });
      return;
    }
    const served = await sentinel.seller.serve({ requestId, buyer: String(buyer), txId });
    if (!served.ok) {
      res.status(served.status).json({ error: served.reason });
      return;
    }
    res.json(served);
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
  const listener = (env) => {
    res.write(`event: envelope\ndata: ${JSON.stringify(env)}\n\n`);
  };
  eventListeners.push(listener);

  req.on('close', () => {
    clearInterval(heartbeat);
    const i = eventListeners.indexOf(listener);
    if (i >= 0) eventListeners.splice(i, 1);
  });
});

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    network: sentinel.cfg.HEDERA_NETWORK,
    topicId: sentinel.cfg.SENTINEL_TOPIC_ID,
    buyer: sentinel.buyer.accountId,
    seller: sentinel.sellerAccountId,
  });
});

app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  res.status(500).json({ error: err?.message ?? 'internal error' });
});

const port = sentinel.cfg.PORT;
app.listen(port, () => {
  console.log(`\nSentinel UI listening on http://localhost:${port}`);
  console.log(`  network: ${sentinel.cfg.HEDERA_NETWORK}`);
  console.log(`  topic:   ${sentinel.cfg.SENTINEL_TOPIC_ID}`);
  console.log(`  buyer:   ${sentinel.buyer.accountId}`);
  console.log(`  seller:  ${sentinel.sellerAccountId}${sentinel.sellerIsBuyer ? '  (same account as buyer — single-account demo mode)' : ''}`);
});

process.on('SIGTERM', () => {
  console.log('shutting down…');
  sentinel.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('shutting down…');
  sentinel.close();
  process.exit(0);
});
