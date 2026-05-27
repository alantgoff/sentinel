import { AgentMode, HederaLangchainToolkit, coreAccountPlugin } from 'hedera-agent-kit';

/**
 * Underwriter agent (the Aegis pool).
 *
 * The underwriter doesn't move HBAR for premium — that's the buyer's job
 * (buyer.payPremium uses the kit's transfer_hbar_tool). What the underwriter
 * does:
 *
 *   1. quote(buyer, K, Q, windowDays) — pure MC pricing through the plugin
 *   2. issue({buyer, K, Q, windowDays, premiumHbar, premiumTxId, maxPayoutHbar})
 *      — verifies the premium tx on the mirror, checks exposure, posts POLICY
 *   3. recordPriceRef(observedUsdHr, source, policyId?) — posts PRICE_REF
 *   4. settle(policyId, R_observed) — computes payout; if PAID_OUT, transfers
 *      via the kit (AUTONOMOUS below cap, RETURN_BYTES above), then posts
 *      SETTLEMENT
 *
 * The underwriter's RETURN_BYTES path is the human-in-loop guarantee for
 * payouts — large payouts hand back unsigned bytes for a human to sign,
 * exactly the safety contract the bounty terms require.
 */

/**
 * @typedef {object} SettleResultAutonomous
 * @property {'AUTONOMOUS_PAID_OUT' | 'EXPIRED' | 'PAID_OUT'} kind
 *
 * @typedef {object} UnsignedPayout
 * @property {'PAYOUT_AWAITING_APPROVAL'} kind
 * @property {string} policyId
 * @property {number} payoutHbar
 * @property {number} observedUsdHr
 * @property {string} unsignedTxBase64
 */

/**
 * @param {object} deps
 * @param {import('@hashgraph/sdk').Client} deps.client            underwriter operator client
 * @param {string} deps.underwriterAccountId
 * @param {import('hedera-agent-kit').Plugin} deps.plugin           the Aegis plugin
 * @param {import('../pool/exposure.js').ActivePolicy extends infer T ? any : never} [_]
 * @param {number} deps.payoutAutonomousCapHbar                    above this → RETURN_BYTES
 * @param {string} deps.topicId
 */
export function createUnderwriter({
  client,
  underwriterAccountId,
  plugin,
  payoutAutonomousCapHbar,
  topicId,
}) {
  // Two toolkits — one autonomous for small payouts, one RETURN_BYTES for
  // payouts above the autonomous cap (so the human-in-loop guarantee is a
  // function of the cap, not a separate code path).
  // The kit ships a PluginRegistry that auto-loads ALL core plugins iff the
  // caller passes ZERO custom plugins. We pass our Aegis plugin, so we must
  // also opt in to the core plugins we need (transfer_hbar_tool lives in
  // coreAccountPlugin). Keeping the surface minimal — we don't pull in the
  // token/consensus/query plugins the underwriter has no need for.
  const autonomousKit = new HederaLangchainToolkit({
    client,
    configuration: {
      plugins: [coreAccountPlugin, plugin],
      context: { accountId: underwriterAccountId, mode: AgentMode.AUTONOMOUS },
    },
  });
  const returnBytesKit = new HederaLangchainToolkit({
    client,
    configuration: {
      plugins: [coreAccountPlugin, plugin],
      context: { accountId: underwriterAccountId, mode: AgentMode.RETURN_BYTES },
    },
  });

  const autonomousApi = autonomousKit.getHederaAgentKitAPI();
  const returnBytesApi = returnBytesKit.getHederaAgentKitAPI();

  function findTool(api, method) {
    const t = api.tools.find((x) => x.method === method);
    if (!t) throw new Error(`tool not found on api: ${method}`);
    return t;
  }
  const autonomousTransferTool = findTool(autonomousApi, 'transfer_hbar_tool');
  const returnBytesTransferTool = findTool(returnBytesApi, 'transfer_hbar_tool');
  const quoteTool = findTool(autonomousApi, 'aegis_quote_policy');
  const issueTool = findTool(autonomousApi, 'aegis_issue_policy');
  const settleTool = findTool(autonomousApi, 'aegis_settle_policy');
  const recordPriceRefTool = findTool(autonomousApi, 'aegis_record_price_ref');
  const poolStatusTool = findTool(autonomousApi, 'aegis_pool_status');
  const listPoliciesTool = findTool(autonomousApi, 'aegis_list_policies');

  async function quote({ buyer, strikeUsdHr, qtyGpuHr, windowDays, maxPayoutUsd, seed }) {
    return quoteTool.execute(autonomousApi.client, autonomousApi.context, {
      buyer, strikeUsdHr, qtyGpuHr, windowDays, maxPayoutUsd, seed,
    });
  }

  async function issue(args) {
    return issueTool.execute(autonomousApi.client, autonomousApi.context, args);
  }

  async function recordPriceRef({ observedUsdHr, source, policyId }) {
    return recordPriceRefTool.execute(autonomousApi.client, autonomousApi.context, {
      observedUsdHr, source, policyId,
    });
  }

  async function poolStatus() {
    return poolStatusTool.execute(autonomousApi.client, autonomousApi.context, {});
  }

  async function listPolicies() {
    return listPoliciesTool.execute(autonomousApi.client, autonomousApi.context, {});
  }

  /**
   * Settle a policy. Given the policyId, observed R, and the active policy's
   * stored maxPayoutHbar/strike/qty, computes the payout in USD, converts to
   * HBAR, transfers (AUTONOMOUS or RETURN_BYTES per cap), then posts SETTLEMENT.
   *
   * @param {object} args
   * @param {string} args.policyId
   * @param {string} args.buyer
   * @param {number} args.observedUsdHr
   * @param {number} args.strikeUsdHr
   * @param {number} args.qtyGpuHr
   * @param {number} args.maxPayoutHbar
   * @param {number} args.hbarUsdPrice
   * @returns {Promise<SettleResultAutonomous | UnsignedPayout>}
   */
  async function settle({
    policyId, buyer, observedUsdHr, strikeUsdHr, qtyGpuHr, maxPayoutHbar, hbarUsdPrice,
  }) {
    // Freeze the observed R as a PRICE_REF tied to this policy — the audit
    // anchor for the settlement amount.
    await recordPriceRef({ observedUsdHr, source: 'sim:labeled', policyId });

    const payoutUsd = Math.max(0, observedUsdHr - strikeUsdHr) * qtyGpuHr;
    const payoutHbarUncapped = payoutUsd / hbarUsdPrice;
    // Round DOWN to whole tinybars (8 decimals) — the SDK rejects amounts
    // that don't quantize cleanly. Always rounding down keeps the underwriter
    // on the safe side of any rounding.
    const payoutHbar = Math.floor(Math.min(payoutHbarUncapped, maxPayoutHbar) * 1e8) / 1e8;

    if (payoutHbar <= 0) {
      const settled = await settleTool.execute(autonomousApi.client, autonomousApi.context, {
        policyId,
        result: 'EXPIRED',
        observedUsdHr,
        payoutHbar: 0,
        payoutTxId: null,
      });
      return { kind: 'EXPIRED', settled };
    }

    if (payoutHbar > payoutAutonomousCapHbar) {
      // RETURN_BYTES — build the transfer without signing.
      const out = await returnBytesTransferTool.execute(returnBytesApi.client, returnBytesApi.context, {
        transfers: [{ accountId: buyer, amount: payoutHbar }],
        sourceAccountId: underwriterAccountId,
        transactionMemo: `aegis/payout/${policyId}`,
      });
      const bytes = out?.bytes instanceof Uint8Array ? out.bytes : out?.bytes ? Uint8Array.from(out.bytes) : null;
      if (!bytes) throw new Error('RETURN_BYTES path produced no bytes blob');
      return {
        kind: 'PAYOUT_AWAITING_APPROVAL',
        policyId,
        payoutHbar,
        observedUsdHr,
        unsignedTxBase64: Buffer.from(bytes).toString('base64'),
      };
    }

    // AUTONOMOUS payout (below the cap).
    const transferOut = await autonomousTransferTool.execute(autonomousApi.client, autonomousApi.context, {
      transfers: [{ accountId: buyer, amount: payoutHbar }],
      sourceAccountId: underwriterAccountId,
      transactionMemo: `aegis/payout/${policyId}`,
    });
    const raw = transferOut?.raw;
    if (raw?.status && raw.status !== 'SUCCESS') {
      throw new Error(`payout transfer did not succeed: ${raw.status}`);
    }
    const payoutTxId = raw?.transactionId;
    if (!payoutTxId) throw new Error('payout transfer returned no transactionId');

    const settled = await settleTool.execute(autonomousApi.client, autonomousApi.context, {
      policyId,
      result: 'PAID_OUT',
      observedUsdHr,
      payoutHbar,
      payoutTxId,
    });
    return { kind: 'AUTONOMOUS_PAID_OUT', payoutTxId, payoutHbar, settled };
  }

  /**
   * Complete a payout that the human approved out-of-band. We re-run the
   * settlement in AUTONOMOUS mode to actually move HBAR + post SETTLEMENT.
   * (For the demo the "human signer" is the same operator key, so we just
   * re-execute. Production would receive a signed-tx blob from a wallet.)
   *
   * @param {object} args  same as `settle` but skipping the cap check
   * @returns {Promise<SettleResultAutonomous>}
   */
  async function finalizeApprovedPayout({
    policyId, buyer, observedUsdHr, payoutHbar,
  }) {
    const transferOut = await autonomousTransferTool.execute(autonomousApi.client, autonomousApi.context, {
      transfers: [{ accountId: buyer, amount: payoutHbar }],
      sourceAccountId: underwriterAccountId,
      transactionMemo: `aegis/payout/${policyId}`,
    });
    const raw = transferOut?.raw;
    if (raw?.status && raw.status !== 'SUCCESS') {
      throw new Error(`payout transfer did not succeed: ${raw.status}`);
    }
    const payoutTxId = raw?.transactionId;
    if (!payoutTxId) throw new Error('payout transfer returned no transactionId');

    const settled = await settleTool.execute(autonomousApi.client, autonomousApi.context, {
      policyId,
      result: 'PAID_OUT',
      observedUsdHr,
      payoutHbar,
      payoutTxId,
    });
    return { kind: 'PAID_OUT', payoutTxId, payoutHbar, settled };
  }

  return {
    quote,
    issue,
    settle,
    finalizeApprovedPayout,
    recordPriceRef,
    poolStatus,
    listPolicies,
    accountId: underwriterAccountId,
    topicId,
  };
}
