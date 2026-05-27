import {
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicId,
} from '@hashgraph/sdk';
import { encodeEnvelope, decodeEnvelope, parseEnvelope } from './envelope.js';

/**
 * HCS submit-side wrapper. Reads always go through the mirror node (see
 * src/hedera/mirror.js) — using authenticated submits but unauthenticated reads
 * mirrors the trust boundary: anyone can verify the topic's contents independently.
 */

/**
 * Create a topic for the Aegis envelope stream. Returns the new topic id.
 *
 * @param {import('@hashgraph/sdk').Client} client
 * @param {object} [opts]
 * @param {string} [opts.memo]
 * @returns {Promise<string>}
 */
export async function createTopic(client, opts = {}) {
  const memo = opts.memo ?? 'aegis.v1';
  const tx = await new TopicCreateTransaction().setTopicMemo(memo).execute(client);
  const receipt = await tx.getReceipt(client);
  const id = receipt.topicId;
  if (!id) throw new Error('TopicCreateTransaction returned no topicId');
  return id.toString();
}

/**
 * Submit an Aegis envelope to the topic. Envelope is validated before send.
 *
 * @param {import('@hashgraph/sdk').Client} client
 * @param {string} topicId
 * @param {import('./envelope.js').EnvelopeT} env
 * @returns {Promise<{ sequenceNumber: number, transactionId: string }>}
 */
export async function submitEnvelope(client, topicId, env) {
  parseEnvelope(env); // throws ZodError if shape is bad
  const body = encodeEnvelope(env);
  const submit = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(body)
    .execute(client);
  const receipt = await submit.getReceipt(client);
  return {
    sequenceNumber: receipt.topicSequenceNumber?.toNumber() ?? -1,
    transactionId: submit.transactionId?.toString() ?? '',
  };
}

/**
 * Read all envelopes from a topic via the mirror node. Returns a parallel array
 * of `{ raw, envelope }` — `envelope` is null if the message wasn't an Aegis
 * envelope (someone else posted to the topic, or the JSON was malformed).
 *
 * Heavy lifting (pagination) is in createMirrorClient.streamTopicMessages.
 *
 * @param {import('./mirror.js').MirrorClient} mirror
 * @param {string} topicId
 * @param {{ sinceTimestamp?: string, limit?: number }} [opts]
 * @returns {Promise<Array<{ raw: import('./mirror.js').TopicMessage, envelope: import('./envelope.js').EnvelopeT | null }>>}
 */
export async function readEnvelopes(mirror, topicId, opts = {}) {
  /** @type {Array<{ raw: import('./mirror.js').TopicMessage, envelope: import('./envelope.js').EnvelopeT | null }>} */
  const out = [];
  for await (const raw of mirror.streamTopicMessages(topicId, opts)) {
    const envelope = decodeEnvelope(raw.message);
    out.push({ raw, envelope });
  }
  return out;
}
