import { randomUUID } from 'node:crypto';
import { matchesExpectedTransfer } from '../hedera/mirror.js';
import { submitEnvelope } from '../hedera/hcs.js';
import { runQuery, SERVICE_NAME, PRICE_HBAR_PER_QUERY, describeService, QuerySchema } from './service.js';

/**
 * Seller agent — vends the funding-round-lookup service.
 *
 * The seller is paid PRICE_HBAR_PER_QUERY in HBAR per query. It:
 *   - issues quotes with a short TTL (and a requestId the buyer must echo back)
 *   - posts a QUOTE envelope to the Sentinel topic
 *   - on serve, INDEPENDENTLY verifies the buyer's txId against the mirror node
 *     before answering. (Trust boundary: the seller never trusts that a buyer-
 *     submitted txId "actually paid" — it re-checks.)
 *
 * @typedef {object} SellerQuote
 * @property {string} requestId
 * @property {string} service
 * @property {number} priceHbar
 * @property {string} payTo            seller's account id
 * @property {string} expiresAt        ISO
 * @property {string} query            stringified original query (so we can rebind it on serve)
 *
 * @typedef {object} SellerServeResult
 * @property {true} ok
 * @property {string} requestId
 * @property {string} service
 * @property {string} txId
 * @property {{ count: number, results: any[] }} data
 *
 * @typedef {object} SellerServeError
 * @property {false} ok
 * @property {string} reason
 * @property {number} status          HTTP-friendly status code (402 = payment missing/insufficient)
 */

const QUOTE_TTL_MS = 5 * 60 * 1000;
const PAYMENT_WINDOW_MS = 10 * 60 * 1000; // settlement must have happened within this window

/**
 * @param {object} params
 * @param {import('@hashgraph/sdk').Client} params.client      seller's operator client
 * @param {import('../hedera/mirror.js').MirrorClient} params.mirror
 * @param {string} params.accountId                           seller account id
 * @param {string} params.topicId                             Sentinel topic
 * @param {(env: import('../hedera/envelope.js').EnvelopeT) => void} [params.onSubmit]
 */
export function createSeller({ client, mirror, accountId, topicId, onSubmit }) {
  /** @type {Map<string, SellerQuote & { servedTxId?: string }>} */
  const openQuotes = new Map();

  /**
   * Issue a quote. Posts a QUOTE envelope.
   *
   * @param {object} args
   * @param {string} args.buyer
   * @param {unknown} args.query
   */
  async function quote({ buyer, query }) {
    const validatedQuery = QuerySchema.parse(query);
    const requestId = randomUUID();
    const expiresAt = new Date(Date.now() + QUOTE_TTL_MS).toISOString();
    /** @type {SellerQuote} */
    const q = {
      requestId,
      service: SERVICE_NAME,
      priceHbar: PRICE_HBAR_PER_QUERY,
      payTo: accountId,
      expiresAt,
      query: JSON.stringify(validatedQuery),
    };
    openQuotes.set(requestId, q);

    /** @type {import('../hedera/envelope.js').EnvelopeT} */
    const env = {
      v: 1,
      type: 'QUOTE',
      ts: new Date().toISOString(),
      buyer,
      seller: accountId,
      service: SERVICE_NAME,
      amountHbar: PRICE_HBAR_PER_QUERY,
      requestId,
      quoteExpiresAt: expiresAt,
    };
    await submitEnvelope(client, topicId, env);
    onSubmit?.(env);

    return q;
  }

  /**
   * Serve a paid request. Verifies txId on the mirror node before answering.
   *
   * @param {object} args
   * @param {string} args.requestId
   * @param {string} args.buyer
   * @param {string} args.txId
   * @returns {Promise<SellerServeResult | SellerServeError>}
   */
  async function serve({ requestId, buyer, txId }) {
    const q = openQuotes.get(requestId);
    if (!q) return { ok: false, reason: 'unknown requestId or quote already served', status: 410 };

    if (q.servedTxId) {
      return { ok: false, reason: 'this quote was already served', status: 409 };
    }
    if (Date.parse(q.expiresAt) < Date.now()) {
      openQuotes.delete(requestId);
      return { ok: false, reason: 'quote expired; please re-request a quote', status: 410 };
    }

    const verification = await mirror.verifyTransaction(txId);
    if (!verification.verified) {
      return { ok: false, reason: `payment not verified: ${verification.error ?? verification.result}`, status: 402 };
    }
    if (verification.consensusTimestamp) {
      const consensusMs = Math.floor(Number(verification.consensusTimestamp) * 1000);
      if (Date.now() - consensusMs > PAYMENT_WINDOW_MS) {
        return { ok: false, reason: `payment is too old (consensus at ${verification.consensusTimestamp})`, status: 402 };
      }
    }
    const match = matchesExpectedTransfer(verification, {
      buyer,
      seller: accountId,
      amountHbar: q.priceHbar,
    });
    if (!match.ok) return { ok: false, reason: `payment does not match quote: ${match.reason}`, status: 402 };

    q.servedTxId = txId;
    const data = runQuery(JSON.parse(q.query));

    return {
      ok: true,
      requestId,
      service: q.service,
      txId,
      data,
    };
  }

  function describe() {
    return { ...describeService(), payTo: accountId };
  }

  function getQuote(requestId) {
    return openQuotes.get(requestId);
  }

  return { quote, serve, describe, getQuote, accountId };
}
