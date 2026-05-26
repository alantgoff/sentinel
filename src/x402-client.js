/**
 * Tiny x402 client.
 *
 * Pattern:
 *   1. GET the resource. If HTTP 402 returns, parse the quote payload.
 *   2. Settle the payment on-chain (caller-supplied — this client doesn't
 *      know about Hedera).
 *   3. Re-GET with X-Payment: "<requestId>:<txId>". If 200, return the data.
 *
 * Why hand-roll? The x402 spec is intentionally tiny — a 402 response, a
 * quote payload describing what to pay, and an X-Payment header on the retry.
 * Anything more is a leaky abstraction.
 *
 * @typedef {object} X402Quote
 * @property {string} requestId
 * @property {string} service
 * @property {number} priceHbar
 * @property {string} payTo
 * @property {string} network
 * @property {string} expiresAt
 *
 * @typedef {object} X402ClientOpts
 * @property {typeof fetch} [fetchImpl]
 *
 * @typedef {object} X402PaySigner
 * @property {(quote: X402Quote) => Promise<string>} payQuote   returns the resulting tx id
 */

/**
 * Fetch a resource, settling the 402 challenge if one comes back.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {RequestInit} [args.init]
 * @param {X402PaySigner} args.signer       knows how to settle a quote
 * @param {string} [args.buyer]             buyer account id, surfaced via X-Buyer
 * @param {X402ClientOpts} [args.opts]
 * @returns {Promise<{ status: number, data: any, txId?: string }>}
 */
export async function x402Fetch({ url, init = {}, signer, buyer, opts = {} }) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('x402Fetch requires a fetch impl (node >= 18 has one)');

  const baseHeaders = new Headers(init.headers ?? {});
  if (buyer) baseHeaders.set('x-buyer', buyer);

  const first = await fetchImpl(url, { ...init, headers: baseHeaders });
  if (first.status !== 402) {
    return { status: first.status, data: await first.json().catch(() => null) };
  }

  const quoteResponse = await first.json();
  const quote = quoteResponse?.x402;
  if (!quote?.requestId || !quote?.payTo || typeof quote?.priceHbar !== 'number') {
    throw new Error('server returned 402 but the quote payload is malformed');
  }

  const txId = await signer.payQuote(quote);

  const paidHeaders = new Headers(init.headers ?? {});
  paidHeaders.set('x-payment', `${quote.requestId}:${txId}`);
  if (buyer) paidHeaders.set('x-buyer', buyer);
  const paid = await fetchImpl(url, { ...init, headers: paidHeaders });
  return { status: paid.status, data: await paid.json().catch(() => null), txId };
}
