import { z } from 'zod';
import { submitEnvelope } from '../hedera/hcs.js';
import { buildReputationProfile } from './reputation.js';
import { evaluatePayment, decidePolicy } from './policy.js';

const AccountId = z.string().regex(/^\d+\.\d+\.\d+$/, 'expected 0.0.xxxxxx');
const TxId = z.string().regex(/^\d+\.\d+\.\d+[@\-]\d+[\.\-]\d+$/);

const PaymentSchema = z.object({
  buyer: AccountId,
  seller: AccountId,
  service: z.string().min(1).max(128),
  amountHbar: z.number().nonnegative().finite(),
});

const PolicySnapshotSchema = z.object({
  ruleId: z.string(),
  result: z.enum(['ALLOW', 'DENY', 'ESCALATE']),
  reason: z.string(),
});

export const TOOL_NAMES = Object.freeze({
  GET_REPUTATION: 'sentinel_get_counterparty_reputation',
  EVALUATE_PAYMENT: 'sentinel_evaluate_payment',
  RECORD_SETTLEMENT: 'sentinel_record_settlement',
  RECORD_POLICY_DECISION: 'sentinel_record_policy_decision',
  RECORD_DENIAL: 'sentinel_record_denial',
  GET_VERIFIED_LEDGER: 'sentinel_get_verified_ledger',
});

/**
 * Build the array of kit-compatible Tool objects.
 *
 * @param {object} deps
 * @param {import('../hedera/mirror.js').MirrorClient} deps.mirror
 * @param {string} deps.topicId
 * @param {import('./types.js').PolicyConfig} deps.policy
 * @param {(envelope: import('../hedera/envelope.js').EnvelopeT) => void} [deps.onSubmit]
 *        Optional observer — useful for the UI to stream events live.
 * @returns {import('hedera-agent-kit').Plugin['tools'] extends (c: any) => infer R ? R : never}
 */
export function buildTools({ mirror, topicId, policy, onSubmit }) {
  return [
    {
      method: TOOL_NAMES.GET_REPUTATION,
      name: TOOL_NAMES.GET_REPUTATION,
      description:
        'Return the verified-history reputation profile for a counterparty account, based ONLY on settlements whose tx id was independently confirmed on the Hedera mirror node.',
      parameters: z.object({
        counterparty: AccountId,
        viewer: AccountId.optional(),
      }),
      execute: async (_client, _ctx, params) => {
        const profile = await buildReputationProfile({
          mirror,
          topicId,
          counterparty: params.counterparty,
          viewer: params.viewer,
        });
        return profile;
      },
    },

    {
      method: TOOL_NAMES.EVALUATE_PAYMENT,
      name: TOOL_NAMES.EVALUATE_PAYMENT,
      description:
        'Given a proposed HBAR payment from buyer to seller for a named service, return the Sentinel policy decision (ALLOW / DENY / ESCALATE) with the rule that fired and the counterparty reputation context.',
      parameters: PaymentSchema,
      execute: async (_client, _ctx, params) => {
        const decision = await evaluatePayment({
          mirror,
          topicId,
          request: params,
          policy,
        });
        return decision;
      },
    },

    {
      method: TOOL_NAMES.RECORD_POLICY_DECISION,
      name: TOOL_NAMES.RECORD_POLICY_DECISION,
      description:
        'Submit a POLICY_DECISION envelope to the Sentinel HCS topic. This is the immutable audit trail of "why did we choose to proceed (or escalate / deny)". Required: payment fields + policy snapshot.',
      parameters: PaymentSchema.extend({
        policy: PolicySnapshotSchema,
        requestId: z.string().optional(),
      }),
      execute: async (client, _ctx, params) => {
        const env = {
          v: /** @type {1} */ (1),
          type: /** @type {'POLICY_DECISION'} */ ('POLICY_DECISION'),
          ts: new Date().toISOString(),
          buyer: params.buyer,
          seller: params.seller,
          service: params.service,
          amountHbar: params.amountHbar,
          policy: params.policy,
          ...(params.requestId ? { requestId: params.requestId } : {}),
        };
        const r = await submitEnvelope(client, topicId, env);
        onSubmit?.(env);
        return { ...r, envelope: env };
      },
    },

    {
      method: TOOL_NAMES.RECORD_SETTLEMENT,
      name: TOOL_NAMES.RECORD_SETTLEMENT,
      description:
        'Submit a SETTLEMENT envelope to the Sentinel HCS topic after a successful HBAR transfer. Carries the transaction id; reputation will recompute against this txId at the next evaluation by re-verifying it against the mirror node.',
      parameters: PaymentSchema.extend({
        txId: TxId,
        policy: PolicySnapshotSchema.optional(),
        requestId: z.string().optional(),
      }),
      execute: async (client, _ctx, params) => {
        const env = {
          v: /** @type {1} */ (1),
          type: /** @type {'SETTLEMENT'} */ ('SETTLEMENT'),
          ts: new Date().toISOString(),
          buyer: params.buyer,
          seller: params.seller,
          service: params.service,
          amountHbar: params.amountHbar,
          txId: params.txId,
          ...(params.policy ? { policy: params.policy } : {}),
          ...(params.requestId ? { requestId: params.requestId } : {}),
        };
        const r = await submitEnvelope(client, topicId, env);
        onSubmit?.(env);
        return { ...r, envelope: env };
      },
    },

    {
      method: TOOL_NAMES.RECORD_DENIAL,
      name: TOOL_NAMES.RECORD_DENIAL,
      description:
        'Submit a DENIAL envelope. Posted when policy denies or escalation is rejected. Transparent record so counterparty reputation reflects "this seller had requests denied."',
      parameters: PaymentSchema.extend({
        policy: PolicySnapshotSchema.refine(
          (p) => p.result === 'DENY' || p.result === 'ESCALATE',
          { message: 'DENIAL must carry DENY or ESCALATE' },
        ),
        requestId: z.string().optional(),
      }),
      execute: async (client, _ctx, params) => {
        const env = {
          v: /** @type {1} */ (1),
          type: /** @type {'DENIAL'} */ ('DENIAL'),
          ts: new Date().toISOString(),
          buyer: params.buyer,
          seller: params.seller,
          service: params.service,
          amountHbar: params.amountHbar,
          policy: params.policy,
          ...(params.requestId ? { requestId: params.requestId } : {}),
        };
        const r = await submitEnvelope(client, topicId, env);
        onSubmit?.(env);
        return { ...r, envelope: env };
      },
    },

    {
      method: TOOL_NAMES.GET_VERIFIED_LEDGER,
      name: TOOL_NAMES.GET_VERIFIED_LEDGER,
      description:
        'Rebuild the verified portion of the Sentinel ledger for a counterparty: every SETTLEMENT envelope whose tx id was confirmed on the mirror node, plus the un-verifiable ones (flagged) and DENIAL records. Useful for transparency in the UI.',
      parameters: z.object({
        counterparty: AccountId,
        viewer: AccountId.optional(),
      }),
      execute: async (_client, _ctx, params) => {
        const profile = await buildReputationProfile({
          mirror,
          topicId,
          counterparty: params.counterparty,
          viewer: params.viewer,
        });
        return profile;
      },
    },
  ];
}

export { decidePolicy };
