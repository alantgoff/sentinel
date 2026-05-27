import { normalizeTxId } from './envelope.js';

/**
 * Thin HTTP client for the Hedera mirror node REST API.
 *
 * Aegis uses this for the parts of the trust boundary that the operator's
 * own keys can't fake:
 *   - confirming a referenced `txId` actually settled and matches the parties/amount
 *   - reading topic messages (which the operator never wrote to via the kit's
 *     authenticated path — third parties may have)
 *
 * The fetch function is injectable so unit tests can mock responses without
 * monkey-patching globals.
 */

/**
 * @typedef {object} MirrorClient
 * @property {string} baseUrl
 * @property {(path: string, query?: Record<string, string|number|undefined>) => Promise<any>} getJson
 * @property {(txId: string) => Promise<TxVerification>} verifyTransaction
 * @property {(topicId: string, opts?: TopicMessagesOpts) => AsyncIterable<TopicMessage>} streamTopicMessages
 *
 * @typedef {object} TopicMessage
 * @property {string} consensus_timestamp
 * @property {number} sequence_number
 * @property {string} topic_id
 * @property {string} message              base64-encoded message payload
 * @property {string} [payer_account_id]
 *
 * @typedef {object} TopicMessagesOpts
 * @property {number} [limit]
 * @property {string} [sinceTimestamp]     consensus timestamp, exclusive lower bound
 * @property {'asc'|'desc'} [order]
 *
 * @typedef {object} TxVerification
 * @property {boolean} verified            true only if the mirror node returned a SUCCESS transaction
 * @property {string} normalizedTxId
 * @property {string|null} result          e.g. 'SUCCESS' | 'INSUFFICIENT_PAYER_BALANCE' | null
 * @property {string|null} consensusTimestamp
 * @property {Array<{ account: string, amount: number, isApproval: boolean }>} hbarTransfers
 * @property {string} [error]              human-readable reason verification failed
 */

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Build a mirror client.
 *
 * @param {object} params
 * @param {string} params.baseUrl
 * @param {typeof fetch} [params.fetchImpl]   inject for tests
 * @param {number} [params.timeoutMs]
 * @returns {MirrorClient}
 */
export function createMirrorClient({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!fetchImpl) {
    throw new Error('createMirrorClient requires a fetch implementation (node >= 18 has one globally)');
  }
  const root = baseUrl.replace(/\/+$/, '');

  /**
   * @param {string} path
   * @param {Record<string, string|number|undefined>} [query]
   */
  async function getJson(path, query) {
    const url = new URL(root + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url.toString(), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`mirror ${res.status} for ${path}${text ? `: ${text}` : ''}`);
        // @ts-expect-error attach status
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(to);
    }
  }

  /**
   * @param {string} txId
   * @returns {Promise<TxVerification>}
   */
  async function verifyTransaction(txId) {
    const normalizedTxId = normalizeTxId(txId);
    /** @type {TxVerification} */
    const base = {
      verified: false,
      normalizedTxId,
      result: null,
      consensusTimestamp: null,
      hbarTransfers: [],
    };
    let payload;
    try {
      payload = await getJson(`/api/v1/transactions/${normalizedTxId}`);
    } catch (err) {
      return { ...base, error: err?.message ?? String(err) };
    }
    const tx = payload?.transactions?.[0];
    if (!tx) {
      return { ...base, error: 'no transaction record returned by mirror node' };
    }
    /** @type {TxVerification} */
    const out = {
      verified: tx.result === 'SUCCESS',
      normalizedTxId,
      result: tx.result ?? null,
      consensusTimestamp: tx.consensus_timestamp ?? null,
      hbarTransfers: Array.isArray(tx.transfers)
        ? tx.transfers.map((t) => ({
            account: t.account,
            amount: Number(t.amount),
            isApproval: Boolean(t.is_approval),
          }))
        : [],
    };
    if (!out.verified) {
      out.error = `transaction result is ${out.result ?? 'unknown'}`;
    }
    return out;
  }

  /**
   * Async iterator over a topic's messages, transparently following pagination.
   *
   * @param {string} topicId
   * @param {TopicMessagesOpts} [opts]
   * @returns {AsyncIterable<TopicMessage>}
   */
  async function* streamTopicMessages(topicId, opts = {}) {
    const limit = opts.limit ?? 100;
    const order = opts.order ?? 'asc';
    /** @type {Record<string, string|number|undefined>} */
    let query = { limit, order };
    if (opts.sinceTimestamp) {
      query['timestamp'] = `gt:${opts.sinceTimestamp}`;
    }
    let path = `/api/v1/topics/${encodeURIComponent(topicId)}/messages`;
    while (path) {
      const page = await getJson(path, query);
      query = {};
      for (const msg of page?.messages ?? []) yield msg;
      const next = page?.links?.next;
      if (!next) break;
      // next is given as a relative URL (path + query) — re-issue with no extra query.
      path = next;
    }
  }

  return { baseUrl: root, getJson, verifyTransaction, streamTopicMessages };
}

/**
 * Confirm an expected HBAR transfer of `amountHbar` to `seller`, paid by
 * `buyer`. The seller-credit assertion is exact (within 1 tinybar); the
 * buyer-debit assertion is "at least the transfer amount" because the buyer
 * (as the transaction payer) ALSO pays the network fee, which shows up as
 * an additional debit on the same row.
 *
 * Example mirror transfers array for a real settled buy:
 *   { account: '0.0.802',     amount:  +115_151    }   // network fee
 *   { account: BUYER,         amount: -50_115_151  }   // -0.5 HBAR - fee
 *   { account: SELLER,        amount: +50_000_000  }   // +0.5 HBAR
 *
 * The seller side is what matters for "did we get paid"; the buyer side is
 * a sanity check that the right account funded it.
 *
 * @param {TxVerification} v
 * @param {object} expected
 * @param {string} expected.buyer
 * @param {string} expected.seller
 * @param {number} expected.amountHbar
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function matchesExpectedTransfer(v, { buyer, seller, amountHbar }) {
  if (!v.verified) return { ok: false, reason: v.error ?? 'transaction not verified' };
  const tinybars = Math.round(amountHbar * 1e8);
  const TOLERANCE = 1;

  const sellerCredit = v.hbarTransfers.find(
    (t) => t.account === seller && Math.abs(t.amount - tinybars) <= TOLERANCE,
  );
  if (!sellerCredit) {
    return { ok: false, reason: `seller ${seller} did not receive ${amountHbar} HBAR (within 1 tinybar)` };
  }

  // Buyer was charged at least the transfer amount. Allow extra for the
  // network fee, but reject if the buyer's net debit is below `tinybars` —
  // that means the funds didn't come from the claimed buyer.
  const buyerDebit = v.hbarTransfers.find(
    (t) => t.account === buyer && t.amount <= -(tinybars - TOLERANCE),
  );
  if (!buyerDebit) {
    return { ok: false, reason: `buyer ${buyer} did not fund ${amountHbar} HBAR` };
  }
  return { ok: true };
}
