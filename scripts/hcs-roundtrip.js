#!/usr/bin/env node
/**
 * HCS roundtrip smoke test — task M1c → A1 in HANDOFF.
 *
 * If AEGIS_TOPIC_ID is unset, creates a new Aegis topic on testnet and
 * prints the id to paste into .env. Otherwise reuses the existing one.
 *
 * Then submits a sample PRICE_REF envelope (the lightest Aegis envelope —
 * no on-chain transfer required to be honest) and reads the topic back via
 * the mirror REST API.
 */
import { loadConfig } from '../src/config.js';
import { buildClient } from '../src/hedera/client.js';
import { createMirrorClient } from '../src/hedera/mirror.js';
import { createTopic, submitEnvelope, readEnvelopes } from '../src/hedera/hcs.js';

function log(label, value) {
  console.log(`\n=== ${label} ===`);
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

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

  let topicId = cfg.AEGIS_TOPIC_ID;
  if (!topicId) {
    log('No AEGIS_TOPIC_ID set — creating a new topic', '');
    topicId = await createTopic(client, { memo: 'aegis.v1' });
    log('Created topic', topicId);
    console.log(`\n→ Paste this into your .env:    AEGIS_TOPIC_ID=${topicId}\n`);
  } else {
    log('Reusing existing topic', topicId);
  }

  /** @type {import('../src/hedera/envelope.js').EnvelopeT} */
  const sample = {
    v: 1,
    type: 'PRICE_REF',
    ts: new Date().toISOString(),
    observedUsdHr: cfg.DEFAULT_R0_USD_HR,
    source: 'sim:labeled',
  };
  log('Submitting envelope', sample);

  const { sequenceNumber, transactionId } = await submitEnvelope(client, topicId, sample);
  log('Submit receipt', { sequenceNumber, transactionId });

  log('Polling mirror REST for the message…', '');
  const hit = await waitForMessage(mirror, topicId, sequenceNumber);
  log('Mirror returned', { raw: hit.raw, envelope: hit.envelope });

  if (!hit.envelope || hit.envelope.type !== 'PRICE_REF' || hit.envelope.observedUsdHr !== sample.observedUsdHr) {
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
