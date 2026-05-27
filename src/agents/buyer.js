import { AgentMode, HederaLangchainToolkit, coreAccountPlugin } from 'hedera-agent-kit';

/**
 * Cap-buyer agent. Pays premiums in HBAR via the kit's transfer_hbar_tool,
 * then asks the underwriter to issue the policy (the underwriter independently
 * verifies the on-chain premium before issuing).
 *
 * The buyer-side is intentionally thin — most of the integrity work lives
 * on the underwriter side. Buyer's responsibilities:
 *
 *   1. requestQuote(K, Q, windowDays) — calls underwriter.quote
 *   2. payPremium(quote, underwriterAccountId) — transfer_hbar_tool
 *   3. requestIssue(quote, premiumTxId) — calls underwriter.issue with the
 *      premium tx id (which the underwriter re-verifies on the mirror)
 *
 * Above-cap premium payments could in principle use RETURN_BYTES, but since
 * premiums are bounded by the underwriter's pricing (and shouldn't ever be
 * "surprisingly huge"), we don't expose that path here. The bounty's
 * human-in-loop guarantee lives on payouts, which is the underwriter's side.
 */

/**
 * @param {object} deps
 * @param {import('@hashgraph/sdk').Client} deps.client
 * @param {string} deps.buyerAccountId
 * @param {ReturnType<typeof import('./underwriter.js').createUnderwriter>} deps.underwriter
 */
export function createBuyer({ client, buyerAccountId, underwriter }) {
  const kit = new HederaLangchainToolkit({
    client,
    configuration: {
      plugins: [coreAccountPlugin],
      context: { accountId: buyerAccountId, mode: AgentMode.AUTONOMOUS },
    },
  });
  const api = kit.getHederaAgentKitAPI();
  const transferTool = api.tools.find((t) => t.method === 'transfer_hbar_tool');
  if (!transferTool) throw new Error('transfer_hbar_tool missing from kit');

  /**
   * Step 1: get a Monte Carlo quote.
   * @param {object} q
   * @param {number} q.strikeUsdHr
   * @param {number} q.qtyGpuHr
   * @param {number} q.windowDays
   * @param {number} [q.maxPayoutUsd]
   * @param {number | bigint} [q.seed]
   */
  async function requestQuote(q) {
    return underwriter.quote({ buyer: buyerAccountId, ...q });
  }

  /**
   * Step 2: pay the premium on-chain.
   * @param {object} args
   * @param {number} args.premiumHbar
   * @param {string} args.memo            should include the quote/policy intent
   * @returns {Promise<{ txId: string, raw: any }>}
   */
  async function payPremium({ premiumHbar, memo }) {
    // The SDK rejects amounts that aren't whole tinybars; quantize the
    // pricer's float to 8 decimals (round up so the buyer never under-pays).
    const amount = Math.ceil(premiumHbar * 1e8) / 1e8;
    const out = await transferTool.execute(api.client, api.context, {
      transfers: [{ accountId: underwriter.accountId, amount }],
      sourceAccountId: buyerAccountId,
      transactionMemo: memo ?? 'aegis/premium',
    });
    const raw = out?.raw;
    if (raw?.status && raw.status !== 'SUCCESS') {
      throw new Error(`premium transfer did not succeed: ${raw.status}`);
    }
    const txId = raw?.transactionId;
    if (!txId) throw new Error('premium transfer returned no transactionId');
    return { txId, raw };
  }

  /**
   * Step 3: ask the underwriter to issue. Underwriter re-verifies the
   * premiumTxId on the mirror node + runs exposure check, so this can fail
   * even after we paid — in which case the buyer just got a free donation
   * to the pool. (Production: the underwriter would refund. For the demo
   * we surface the failure clearly and never retry-with-existing-txid.)
   *
   * @param {object} args
   * @param {number} args.strikeUsdHr
   * @param {number} args.qtyGpuHr
   * @param {number} args.windowDays
   * @param {number} args.premiumHbar
   * @param {string} args.premiumTxId
   * @param {number} args.maxPayoutHbar
   * @param {number} [args.maxPayoutUsd]
   * @param {number | bigint} [args.seed]
   */
  async function requestIssue(args) {
    return underwriter.issue({ buyer: buyerAccountId, ...args });
  }

  /**
   * Convenience: full flow in one call. quote → pay → issue.
   * Returns the issued POLICY envelope (or throws on any failure).
   */
  async function requestPolicy({ strikeUsdHr, qtyGpuHr, windowDays, maxPayoutUsd, seed }) {
    const quote = await requestQuote({ strikeUsdHr, qtyGpuHr, windowDays, maxPayoutUsd, seed });
    const { txId } = await payPremium({
      premiumHbar: quote.premiumHbar,
      memo: `aegis/premium/K=${strikeUsdHr}/Q=${qtyGpuHr}/W=${windowDays}d`,
    });
    const issued = await requestIssue({
      strikeUsdHr, qtyGpuHr, windowDays, maxPayoutUsd, seed,
      premiumHbar: quote.premiumHbar,
      premiumTxId: txId,
      maxPayoutHbar: quote.maxPayoutHbar,
    });
    return { quote, premiumTxId: txId, issued };
  }

  return {
    requestQuote,
    payPremium,
    requestIssue,
    requestPolicy,
    accountId: buyerAccountId,
  };
}
