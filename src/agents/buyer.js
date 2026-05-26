import { AgentMode, HederaLangchainToolkit } from 'hedera-agent-kit';
import { submitEnvelope } from '../hedera/hcs.js';
import { evaluatePayment } from '../plugin/policy.js';

/**
 * Buyer agent — pays the seller per query, enforced by the Sentinel plugin.
 *
 * Flow:
 *   1. Ask the seller for a quote.
 *   2. Evaluate the proposed payment via the Sentinel plugin's policy combiner
 *      (reputation profile of the seller is rebuilt from mirror-verified HCS history).
 *   3. ALLOW  → execute the transfer through the kit's transfer_hbar_tool
 *               in AUTONOMOUS mode, then settle.
 *      DENY  → post a DENIAL envelope. Abort.
 *      ESCALATE → switch the kit's mode to RETURN_BYTES, build the same
 *                 transfer, return the unsigned tx bytes to the caller for
 *                 a human signer. (For the local demo the human signer is
 *                 also the operator — pressing "approve" in the UI calls
 *                 continueAfterApproval which re-runs the transfer in
 *                 AUTONOMOUS mode.)
 *   4. Post POLICY_DECISION envelope.
 *   5. Call seller.serve(txId) → answer.
 *   6. Post SETTLEMENT envelope (so this seller's reputation goes up).
 */

/**
 * @typedef {object} BuyOutcomeAllowed
 * @property {'ALLOWED'} kind
 * @property {string} requestId
 * @property {import('../plugin/types.js').PolicyDecisionT} decision
 * @property {string} txId
 * @property {{ count: number, results: any[] }} data
 *
 * @typedef {object} BuyOutcomeDenied
 * @property {'DENIED'} kind
 * @property {string} requestId
 * @property {import('../plugin/types.js').PolicyDecisionT} decision
 *
 * @typedef {object} BuyOutcomePending
 * @property {'ESCALATED'} kind
 * @property {string} requestId
 * @property {import('../plugin/types.js').PolicyDecisionT} decision
 * @property {string} unsignedTxBase64                       opaque bytes blob; human approval re-runs the flow
 * @property {import('./seller.js').SellerQuote} quote
 *
 * @typedef {BuyOutcomeAllowed | BuyOutcomeDenied | BuyOutcomePending} BuyOutcome
 */

/**
 * @param {object} params
 * @param {import('@hashgraph/sdk').Client} params.client    buyer's operator client
 * @param {import('../hedera/mirror.js').MirrorClient} params.mirror
 * @param {string} params.accountId                          buyer account id
 * @param {string} params.topicId                            Sentinel topic
 * @param {import('../plugin/types.js').PolicyConfig} params.policy
 * @param {ReturnType<typeof import('./seller.js').createSeller>} params.seller
 * @param {(env: import('../hedera/envelope.js').EnvelopeT) => void} [params.onSubmit]
 */
export function createBuyer({ client, mirror, accountId, topicId, policy, seller, onSubmit }) {
  // Two toolkits — the buyer needs both modes available.
  const autonomousKit = new HederaLangchainToolkit({
    client,
    configuration: {
      context: { accountId, mode: AgentMode.AUTONOMOUS },
    },
  });
  const returnBytesKit = new HederaLangchainToolkit({
    client,
    configuration: {
      context: { accountId, mode: AgentMode.RETURN_BYTES },
    },
  });

  const autonomousApi = autonomousKit.getHederaAgentKitAPI();
  const returnBytesApi = returnBytesKit.getHederaAgentKitAPI();

  // We deliberately bypass api.run() — it JSON-stringifies the result, which
  // mangles the Uint8Array on the RETURN_BYTES path. The tool's own execute
  // returns the structured { raw, humanMessage } | { bytes } shape directly.
  function findTransferTool(api) {
    const t = api.tools.find((tool) => tool.method === 'transfer_hbar_tool');
    if (!t) throw new Error('transfer_hbar_tool not found on the toolkit');
    return t;
  }
  const autonomousTransferTool = findTransferTool(autonomousApi);
  const returnBytesTransferTool = findTransferTool(returnBytesApi);

  /**
   * Execute the transfer via the kit. Returns the kit's structured result —
   * either { raw: { transactionId, status, ... }, humanMessage } in AUTONOMOUS
   * mode, or { bytes: Uint8Array } in RETURN_BYTES mode.
   *
   * @param {'AUTONOMOUS'|'RETURN_BYTES'} mode
   * @param {string} sellerAccount
   * @param {number} amountHbar
   * @param {string} requestId
   */
  async function transfer(mode, sellerAccount, amountHbar, requestId) {
    const api = mode === 'AUTONOMOUS' ? autonomousApi : returnBytesApi;
    const tool = mode === 'AUTONOMOUS' ? autonomousTransferTool : returnBytesTransferTool;
    return tool.execute(api.client, api.context, {
      transfers: [{ accountId: sellerAccount, amount: amountHbar }],
      sourceAccountId: accountId,
      transactionMemo: `sentinel/${requestId}`,
    });
  }

  /**
   * The full buy flow. Returns one of three outcomes.
   *
   * @param {object} args
   * @param {unknown} args.query
   * @returns {Promise<BuyOutcome>}
   */
  async function request({ query }) {
    const q = await seller.quote({ buyer: accountId, query });

    const decision = await evaluatePayment({
      mirror,
      topicId,
      request: {
        buyer: accountId,
        seller: seller.accountId,
        service: q.service,
        amountHbar: q.priceHbar,
      },
      policy,
    });

    // Audit-trail envelope before we move money.
    await postPolicyDecision(decision, q);

    if (decision.decision === 'DENY') {
      await postDenial(decision, q);
      return { kind: 'DENIED', requestId: q.requestId, decision };
    }

    if (decision.decision === 'ESCALATE') {
      const result = await transfer('RETURN_BYTES', seller.accountId, q.priceHbar, q.requestId);
      const bytes =
        result?.bytes instanceof Uint8Array
          ? result.bytes
          : result?.bytes
            ? Uint8Array.from(result.bytes)
            : null;
      if (!bytes) {
        throw new Error('RETURN_BYTES path produced no bytes blob');
      }
      return {
        kind: 'ESCALATED',
        requestId: q.requestId,
        decision,
        unsignedTxBase64: Buffer.from(bytes).toString('base64'),
        quote: q,
      };
    }

    // ALLOW
    return await settleAndServe(decision, q);
  }

  /**
   * Continue an escalated request after a human approves. Replays the transfer
   * in AUTONOMOUS mode using the original quote, then settles.
   *
   * @param {object} args
   * @param {import('./seller.js').SellerQuote} args.quote
   * @param {import('../plugin/types.js').PolicyDecisionT} args.decision
   * @returns {Promise<BuyOutcomeAllowed | BuyOutcomeDenied>}
   */
  async function continueAfterApproval({ quote, decision }) {
    const q = seller.getQuote(quote.requestId);
    if (!q) {
      const denied = {
        ...decision,
        decision: /** @type {'DENY'} */ ('DENY'),
        ruleId: 'quote-expired-during-escalation',
        reason: 'quote expired while waiting for human approval; please retry',
      };
      await postDenial(denied, quote);
      return { kind: 'DENIED', requestId: quote.requestId, decision: denied };
    }
    // After the human approves, the effective decision becomes ALLOW with a
    // ruleId that records the override — so the SETTLEMENT envelope's policy
    // snapshot is auditable as "escalated + human-approved" rather than the
    // original ESCALATE.
    const approved = {
      ...decision,
      decision: /** @type {'ALLOW'} */ ('ALLOW'),
      ruleId: `${decision.ruleId}+human-approved`,
      reason: `escalation resolved by human approval (original rule: ${decision.reason})`,
    };
    return await settleAndServe(approved, q);
  }

  /**
   * Common settlement + serve path used by both ALLOW and post-approval.
   *
   * @param {import('../plugin/types.js').PolicyDecisionT} decision
   * @param {import('./seller.js').SellerQuote} q
   */
  async function settleAndServe(decision, q) {
    const transferOut = await transfer('AUTONOMOUS', seller.accountId, q.priceHbar, q.requestId);
    const raw = transferOut?.raw;
    if (raw?.status && raw.status !== 'SUCCESS') {
      throw new Error(`transfer did not succeed: ${raw.status}`);
    }
    const txId = raw?.transactionId;
    if (!txId) {
      throw new Error('AUTONOMOUS transfer returned no transactionId');
    }

    const served = await seller.serve({ requestId: q.requestId, buyer: accountId, txId });
    if (!served.ok) {
      // Seller refused to serve despite us paying. Record the DENIAL so the
      // seller's reputation registers the misbehavior.
      const denial = {
        ...decision,
        decision: /** @type {'DENY'} */ ('DENY'),
        ruleId: 'seller-refused-after-payment',
        reason: served.reason,
      };
      await postDenial(denial, q);
      return { kind: 'DENIED', requestId: q.requestId, decision: denial };
    }

    await postSettlement(decision, q, txId);

    return {
      kind: 'ALLOWED',
      requestId: q.requestId,
      decision,
      txId,
      data: served.data,
    };
  }

  async function postPolicyDecision(decision, q) {
    /** @type {import('../hedera/envelope.js').EnvelopeT} */
    const env = {
      v: 1,
      type: 'POLICY_DECISION',
      ts: new Date().toISOString(),
      buyer: accountId,
      seller: seller.accountId,
      service: q.service,
      amountHbar: q.priceHbar,
      policy: {
        ruleId: decision.ruleId,
        result: decision.decision,
        reason: decision.reason,
      },
      requestId: q.requestId,
    };
    await submitEnvelope(client, topicId, env);
    onSubmit?.(env);
  }

  async function postDenial(decision, q) {
    /** @type {import('../hedera/envelope.js').EnvelopeT} */
    const env = {
      v: 1,
      type: 'DENIAL',
      ts: new Date().toISOString(),
      buyer: accountId,
      seller: seller.accountId,
      service: q.service,
      amountHbar: q.priceHbar,
      policy: {
        ruleId: decision.ruleId,
        result: decision.decision,
        reason: decision.reason,
      },
      requestId: q.requestId,
    };
    await submitEnvelope(client, topicId, env);
    onSubmit?.(env);
  }

  async function postSettlement(decision, q, txId) {
    /** @type {import('../hedera/envelope.js').EnvelopeT} */
    const env = {
      v: 1,
      type: 'SETTLEMENT',
      ts: new Date().toISOString(),
      buyer: accountId,
      seller: seller.accountId,
      service: q.service,
      amountHbar: q.priceHbar,
      txId,
      policy: {
        ruleId: decision.ruleId,
        result: decision.decision,
        reason: decision.reason,
      },
      requestId: q.requestId,
    };
    await submitEnvelope(client, topicId, env);
    onSubmit?.(env);
  }

  /**
   * Settle a quote that was issued out-of-band (e.g. via an HTTP 402 challenge
   * from a different client). The Sentinel policy plugin still runs — same
   * decision matrix — but the quote is used as-is instead of being re-issued.
   *
   * @param {object} args
   * @param {{ requestId: string, service: string, priceHbar: number, payTo: string, expiresAt: string }} args.quote
   * @returns {Promise<BuyOutcome>}
   */
  async function payQuote({ quote }) {
    const decision = await evaluatePayment({
      mirror,
      topicId,
      request: {
        buyer: accountId,
        seller: quote.payTo,
        service: quote.service,
        amountHbar: quote.priceHbar,
      },
      policy,
    });

    // Make the decision auditable on-chain before transferring.
    const auditEnv = {
      v: /** @type {1} */ (1),
      type: /** @type {'POLICY_DECISION'} */ ('POLICY_DECISION'),
      ts: new Date().toISOString(),
      buyer: accountId,
      seller: quote.payTo,
      service: quote.service,
      amountHbar: quote.priceHbar,
      policy: { ruleId: decision.ruleId, result: decision.decision, reason: decision.reason },
      requestId: quote.requestId,
    };
    await submitEnvelope(client, topicId, auditEnv);
    onSubmit?.(auditEnv);

    if (decision.decision === 'DENY') {
      const env = { ...auditEnv, type: /** @type {'DENIAL'} */ ('DENIAL') };
      await submitEnvelope(client, topicId, env);
      onSubmit?.(env);
      return { kind: 'DENIED', requestId: quote.requestId, decision };
    }

    if (decision.decision === 'ESCALATE') {
      const result = await transfer('RETURN_BYTES', quote.payTo, quote.priceHbar, quote.requestId);
      const bytes =
        result?.bytes instanceof Uint8Array
          ? result.bytes
          : result?.bytes
            ? Uint8Array.from(result.bytes)
            : null;
      if (!bytes) throw new Error('RETURN_BYTES path produced no bytes blob');
      return {
        kind: 'ESCALATED',
        requestId: quote.requestId,
        decision,
        unsignedTxBase64: Buffer.from(bytes).toString('base64'),
        // synthesize a minimal SellerQuote shape so continueAfterApproval can work
        quote: {
          requestId: quote.requestId,
          service: quote.service,
          priceHbar: quote.priceHbar,
          payTo: quote.payTo,
          expiresAt: quote.expiresAt,
          query: '{}',
        },
      };
    }

    // ALLOW — transfer + post SETTLEMENT. Caller is responsible for the
    // actual service call (e.g. the x402 retry); the txId is what the seller
    // verifies on the other end.
    const transferOut = await transfer('AUTONOMOUS', quote.payTo, quote.priceHbar, quote.requestId);
    const raw = transferOut?.raw;
    if (raw?.status && raw.status !== 'SUCCESS') {
      throw new Error(`transfer did not succeed: ${raw.status}`);
    }
    const txId = raw?.transactionId;
    if (!txId) throw new Error('AUTONOMOUS transfer returned no transactionId');

    const settleEnv = {
      v: /** @type {1} */ (1),
      type: /** @type {'SETTLEMENT'} */ ('SETTLEMENT'),
      ts: new Date().toISOString(),
      buyer: accountId,
      seller: quote.payTo,
      service: quote.service,
      amountHbar: quote.priceHbar,
      txId,
      policy: { ruleId: decision.ruleId, result: decision.decision, reason: decision.reason },
      requestId: quote.requestId,
    };
    await submitEnvelope(client, topicId, settleEnv);
    onSubmit?.(settleEnv);

    return {
      kind: 'ALLOWED',
      requestId: quote.requestId,
      decision,
      txId,
      data: { count: 0, results: [] }, // not served here — caller does the service GET
    };
  }

  return { request, continueAfterApproval, payQuote, accountId };
}
