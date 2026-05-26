#!/usr/bin/env node
/**
 * HCS roundtrip smoke test — task M1c in HANDOFF.
 *
 * If SENTINEL_TOPIC_ID is unset, creates a new Sentinel topic on testnet and
 * prints the id to paste into .env. Otherwise reuses the existing one.
 *
 * Then submits a sample SETTLEMENT envelope and reads the topic back via the
 * mirror REST API (the same path the reputation scorer will use).
 */
import { loadConfig } from '../src/config.js';
import { buildClient } from '../src/hedera/client.js';
import { createMirrorClient } from '../src/hedera/mirror.js';
import { createSentinelTopic, submitEnvelope, readEnvelopes } from '../src/hedera/hcs.js';

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

/**
 * Poll the mirror node for our message — mirror lag is usually 2–6 seconds.
 *
 * @param {import('../src/hedera/mirror.js').MirrorClient} mirror
 * @param {string} topicId
 * @param {number} sequenceNumber
 * @param {number} timeoutMs
 */
async function waitForMessage(mirror, topicId, sequenceNumber, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await readEnvelopes(mirror, topicId);
    const hit = items.find((i) => i.raw.sequence_number === sequenceNumber);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`mirror lag: message #${sequenceNumber} did not appear within ${timeoutMs} ms`);
}

async function main() {
  const cfg = loadConfig();
  const client = buildClient({
    network: cfg.HEDERA_NETWORK,
    accountId: cfg.BUYER_ACCOUNT_ID,
    privateKey: cfg.BUYER_PRIVATE_KEY,
  });
  const mirror = createMirrorClient({ baseUrl: cfg.MIRROR_NODE_URL });

  let topicId = cfg.SENTINEL_TOPIC_ID;
  if (!topicId) {
    log('No SENTINEL_TOPIC_ID set — creating a new topic', '');
    topicId = await createSentinelTopic(client, { memo: 'sentinel.v1' });
    log('Created topic', topicId);
    console.log(`\n→ Paste this into your .env:    SENTINEL_TOPIC_ID=${topicId}\n`);
  } else {
    log('Reusing existing topic', topicId);
  }

  const seller = cfg.SELLER_ACCOUNT_ID ?? cfg.BUYER_ACCOUNT_ID;
  /** @type {import('../src/hedera/envelope.js').EnvelopeT} */
  const sample = {
    v: 1,
    type: 'QUOTE',
    ts: new Date().toISOString(),
    buyer: cfg.BUYER_ACCOUNT_ID,
    seller,
    service: 'funding-round-lookup',
    amountHbar: 0.5,
    requestId: `smoke-${Date.now()}`,
    quoteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  log('Submitting envelope', sample);

  const { sequenceNumber, transactionId } = await submitEnvelope(client, topicId, sample);
  log('Submit receipt', { sequenceNumber, transactionId });

  log('Polling mirror REST for the message…', '');
  const hit = await waitForMessage(mirror, topicId, sequenceNumber);
  log('Mirror returned', { raw: hit.raw, envelope: hit.envelope });

  if (!hit.envelope || hit.envelope.requestId !== sample.requestId) {
    throw new Error('mirror returned a different message than we submitted');
  }

  client.close();
  console.log('\nHCS roundtrip OK.');
}

main().catch((err) => {
  console.error('\nHCS roundtrip FAILED:\n');
  console.error(err?.stack ?? err);
  process.exit(1);
});
