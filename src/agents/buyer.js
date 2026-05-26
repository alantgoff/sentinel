import { AgentMode, HederaLangchainToolkit } from 'hedera-agent-kit';
import { Transaction } from '@hashgraph/sdk';
import { randomUUID } from 'node:crypto';
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

  /**
   * Execute the transfer via the kit. Returns either a tx id (AUTONOMOUS) or
   * an unsigned bytes blob (RETURN_BYTES).
   *
   * @param {'AUTONOMOUS'|'RETURN_BYTES'} mode
   * @param {string} sellerAccount
   * @param {number} amountHbar
   * @param {string} requestId
   */
  async function transfer(mode, sellerAccount, amountHbar, requestId) {
    const api = mode === 'AUTONOMOUS' ? autonomousApi : returnBytesApi;
    const out = await api.run('transfer_hbar_tool', {
      transfers: [{ accountId: sellerAccount, amount: amountHbar }],
      sourceAccountId: accountId,
      transactionMemo: `sentinel/${requestId}`,
    });
    return out;
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
      // result.raw.bytes is a Uint8Array; serialize for transport
      const raw = result?.raw ?? result;
      const bytes =
        raw?.bytes instanceof Uint8Array
          ? raw.bytes
          : raw?.bytes
            ? Uint8Array.from(raw.bytes)
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
      // Quote expired between escalation and approval — fail loud.
      const denied = {
        ...decision,
        decision: /** @type {'DENY'} */ ('DENY'),
        ruleId: 'quote-expired-during-escalation',
        reason: 'quote expired while waiting for human approval; please retry',
      };
      await postDenial(denied, quote);
      return { kind: 'DENIED', requestId: quote.requestId, decision: denied };
    }
    return await settleAndServe(decision, q);
  }

  /**
   * Common settlement + serve path used by both ALLOW and post-approval.
   *
   * @param {import('../plugin/types.js').PolicyDecisionT} decision
   * @param {import('./seller.js').SellerQuote} q
   */
  async function settleAndServe(decision, q) {
    const transferOut = await transfer('AUTONOMOUS', seller.accountId, q.priceHbar, q.requestId);
    const raw = transferOut?.raw ?? transferOut;
    const txId = raw?.transactionId ?? raw?.txId;
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

  return { request, continueAfterApproval, accountId };
}
