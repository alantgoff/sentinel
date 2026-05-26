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
// Mirror nodes lag the network by 2–6s in normal operation; retry transient
// "not found" responses with backoff before declaring the payment unverified.
const MIRROR_LAG_RETRIES = 8;
const MIRROR_LAG_BASE_DELAY_MS = 1500;

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

    // Mirror nodes lag the network — retry transient 404s before giving up.
    // We re-call verifyTransaction (it bakes the right URL); a 404 surfaces in
    // the `error` field as "mirror 404 …" so we detect that and back off.
    let verification = await mirror.verifyTransaction(txId);
    for (let i = 0; i < MIRROR_LAG_RETRIES; i++) {
      if (verification.verified) break;
      const looksLikeLag =
        verification.result === null && /mirror 404|no transaction record/i.test(verification.error ?? '');
      if (!looksLikeLag) break;
      await new Promise((r) => setTimeout(r, MIRROR_LAG_BASE_DELAY_MS * (i + 1)));
      verification = await mirror.verifyTransaction(txId);
    }
    if (!verification.verified) {
      return { ok: false, reason: `payment not verified: ${verification.error ?? verification.result}`, status: 402 };
    }
    if (verification.consensusTimestamp) {
      const consensusMs = Math.floor(Number(verification.consensusTimestamp) * 1000);
      if (Date.now() - consensusMs > PAYMENT_WINDOW_MS) {
        return { ok: false, reason: `payment is too old (consensus at ${verification.consensusTimestamp})`, status: 402 };
      }
    }
    if (buyer !== accountId) {
      // Normal case: distinct buyer and seller. Mirror reports both legs of
      // the transfer + the network fee; matchesExpectedTransfer asserts the
      // seller credit and buyer debit each within 1 tinybar of the quote.
      const match = matchesExpectedTransfer(verification, {
        buyer,
        seller: accountId,
        amountHbar: q.priceHbar,
      });
      if (!match.ok) return { ok: false, reason: `payment does not match quote: ${match.reason}`, status: 402 };
    } else {
      // Single-account demo mode (buyer === seller): the Hedera ledger nets
      // self-transfers entirely, so the mirror's transfers array contains
      // only the network fee debit — there's no way to assert "+0.5 HBAR".
      // The transaction-succeeded check + the consensus-window check above
      // are still enforced; this is acknowledged in LIMITATIONS.md as a
      // demo-only shortcut.
      console.warn('[seller] buyer === seller — skipping transfer-set match (single-account demo mode)');
    }

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
