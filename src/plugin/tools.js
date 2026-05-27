import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { submitEnvelope } from '../hedera/hcs.js';
import { matchesExpectedTransfer, verifyWithRetry } from '../hedera/mirror.js';
import { pricePremium, maxLikelyPayoutHbar } from '../pricing/pricer.js';
import { calibrate, H100_MONTHLY } from '../pricing/calibration.js';
import { emCalibrate } from '../pricing/em-calibration.js';
import { poolBalanceHbar } from '../pool/pool.js';

const AccountId = z.string().regex(/^\d+\.\d+\.\d+$/);
const TxId = z.string().regex(/^\d+\.\d+\.\d+[@\-]\d+[\.\-]\d+$/);

export const TOOL_NAMES = Object.freeze({
  QUOTE: 'aegis_quote_policy',
  ISSUE: 'aegis_issue_policy',
  RECORD_PRICE_REF: 'aegis_record_price_ref',
  SETTLE: 'aegis_settle_policy',
  POST_CAPACITY: 'aegis_post_provider_capacity',
  POOL_STATUS: 'aegis_pool_status',
  LIST_POLICIES: 'aegis_list_policies',
  GET_PARAMS: 'aegis_get_price_params',
});

/**
 * Build kit-compatible Tool[]. Closes over the underwriter context (mirror,
 * topic, exposure book, pricing knobs).
 *
 * The plugin doesn't move HBAR itself — premium / payout transfers go through
 * the kit's `transfer_hbar_tool` so the same RETURN_BYTES path applies on
 * payouts. These tools handle quoting, exposure-checked issuance, the
 * settlement state machine, and HCS recording.
 *
 * @param {object} deps
 * @param {import('../hedera/mirror.js').MirrorClient} deps.mirror
 * @param {string} deps.topicId
 * @param {string} deps.underwriterAccountId
 * @param {ReturnType<typeof import('../pool/exposure.js').createExposureBook>} deps.exposure
 * @param {{ getRT: () => number, getSource: () => string }} deps.priceFeed
 *        Live R(t) and the source label posted to PRICE_REF envelopes.
 * @param {number} deps.hbarUsdPrice
 * @param {import('../pricing/price-model.js').PriceModelParams} [deps.params]
 * @param {number} [deps.paths]
 * @param {(env: import('../hedera/envelope.js').EnvelopeT) => void} [deps.onSubmit]
 * @returns {import('hedera-agent-kit').Plugin['tools'] extends (c: any) => infer R ? R : never}
 */
export function buildTools({
  mirror,
  topicId,
  underwriterAccountId,
  exposure,
  priceFeed,
  hbarUsdPrice,
  params: priceParams,
  paths = 5000,
  onSubmit,
}) {
  const QuoteSchema = z.object({
    buyer: AccountId,
    strikeUsdHr: z.number().positive().finite(),
    qtyGpuHr: z.number().positive().finite(),
    windowDays: z.number().int().min(1).max(180),
    maxPayoutUsd: z.number().positive().finite().optional(),
    seed: z.union([z.number().int().nonnegative(), z.bigint()]).optional(),
  });

  /**
   * Helper: quote a policy without issuing it. Pure function over the price
   * model + current R0; doesn't touch HCS or the pool.
   */
  function quoteInternal(q) {
    const R0 = priceFeed.getRT();
    const result = pricePremium({
      K: q.strikeUsdHr,
      Q: q.qtyGpuHr,
      windowDays: q.windowDays,
      R0,
      hbarUsdPrice,
      maxPayoutCapUsd: q.maxPayoutUsd,
      paths,
      params: priceParams,
      seed: q.seed,
    });
    const maxPayoutHbar = q.maxPayoutUsd
      ? q.maxPayoutUsd / hbarUsdPrice
      : maxLikelyPayoutHbar({
          K: q.strikeUsdHr,
          Q: q.qtyGpuHr,
          windowDays: q.windowDays,
          R0,
          hbarUsdPrice,
          paths: 1000,
          params: priceParams,
          seed: q.seed,
        });
    return { ...result, maxPayoutHbar, R0 };
  }

  return [
    {
      method: TOOL_NAMES.QUOTE,
      name: TOOL_NAMES.QUOTE,
      description:
        'Quote a cost-cap policy. Given a buyer, strike (USD/hr), notional (GPU-hours), and coverage window in days, returns the Monte Carlo premium in HBAR with the expected payout, risk load, ops load, 95% CI, and probability in-the-money — plus the worst-case payout obligation the pool would have to reserve. Does NOT issue the policy.',
      parameters: QuoteSchema,
      execute: async (_client, _ctx, params) => quoteInternal(params),
    },

    {
      method: TOOL_NAMES.ISSUE,
      name: TOOL_NAMES.ISSUE,
      description:
        'Issue a policy after the buyer has paid the premium on-chain. Requires the premium tx id to be verifiable on the mirror node (transfer succeeded, amount matches the quoted premium, parties match). Checks aggregate-exposure against the pool BEFORE posting the POLICY envelope; refuses with a clear reason if the policy would push the pool over its exposure cap.',
      parameters: QuoteSchema.extend({
        premiumHbar: z.number().positive().finite(),
        premiumTxId: TxId,
        maxPayoutHbar: z.number().positive().finite(),
      }),
      execute: async (client, _ctx, input) => {
        const R0 = priceFeed.getRT();
        // Verify the premium transfer (within 1 tinybar; sender = buyer; recipient = underwriter).
        // Use retry-with-backoff because mirror nodes lag 2–6s behind consensus
        // and a 404 immediately after the transfer is normal propagation, not fraud.
        const v = await verifyWithRetry(mirror, input.premiumTxId);
        if (!v.verified) {
          throw new Error(`premium tx not verified: ${v.error ?? v.result}`);
        }
        const m = matchesExpectedTransfer(v, {
          buyer: input.buyer,
          seller: underwriterAccountId,
          amountHbar: input.premiumHbar,
        });
        if (!m.ok) throw new Error(`premium transfer does not match quote: ${m.reason}`);

        const balance = await poolBalanceHbar(mirror, underwriterAccountId);
        const exposureCheck = exposure.checkIssuance({
          poolBalanceHbar: balance,
          proposedMaxPayoutHbar: input.maxPayoutHbar,
        });
        if (!exposureCheck.ok) {
          throw new Error(`exposure check failed: ${exposureCheck.reason}`);
        }

        const policyId = `pol-${randomUUID()}`;
        const windowEndsTs = new Date(Date.now() + input.windowDays * 86_400_000).toISOString();

        // Snapshot pricing for auditability.
        const pricing = pricePremium({
          K: input.strikeUsdHr,
          Q: input.qtyGpuHr,
          windowDays: input.windowDays,
          R0,
          hbarUsdPrice,
          maxPayoutCapUsd: input.maxPayoutUsd,
          paths,
          params: priceParams,
          seed: input.seed,
        });

        /** @type {import('../hedera/envelope.js').EnvelopeT} */
        const env = {
          v: 1,
          type: 'POLICY',
          ts: new Date().toISOString(),
          policyId,
          buyer: input.buyer,
          underwriter: underwriterAccountId,
          class: 'H100',
          strikeUsdHr: input.strikeUsdHr,
          qtyGpuHr: input.qtyGpuHr,
          windowEndsTs,
          premiumHbar: input.premiumHbar,
          premiumTxId: input.premiumTxId,
          maxPayoutHbar: input.maxPayoutHbar,
          pricing: {
            r0UsdHr: R0,
            expectedPayoutHbar: pricing.expectedPayoutHbar,
            riskLoadHbar: pricing.riskLoadHbar,
            opsLoadHbar: pricing.opsLoadHbar,
            paths: pricing.paths,
            ci95Hbar: pricing.ci95Hbar,
          },
        };
        const { sequenceNumber } = await submitEnvelope(client, topicId, env);
        onSubmit?.(env);

        // Reserve the worst-case payout in the exposure book.
        exposure.add({
          policyId,
          buyer: input.buyer,
          maxPayoutHbar: input.maxPayoutHbar,
          windowEndsTs,
        });

        return { sequenceNumber, envelope: env, exposure: exposure.snapshot(balance) };
      },
    },

    {
      method: TOOL_NAMES.RECORD_PRICE_REF,
      name: TOOL_NAMES.RECORD_PRICE_REF,
      description:
        'Post a PRICE_REF envelope: an observed (or labeled-simulated) reference price R for the underlying. The source field MUST be "sim:labeled", "sim:shock", or "calibration:<dataset-id>" so we can never accidentally claim derivatives-grade index data.',
      parameters: z.object({
        observedUsdHr: z.number().positive().finite(),
        source: z.string().regex(/^(sim:labeled|sim:shock|calibration:[a-z0-9-]+)$/),
        policyId: z.string().optional(),
      }),
      execute: async (client, _ctx, params) => {
        /** @type {import('../hedera/envelope.js').EnvelopeT} */
        const env = {
          v: 1,
          type: 'PRICE_REF',
          ts: new Date().toISOString(),
          observedUsdHr: params.observedUsdHr,
          source: params.source,
          ...(params.policyId ? { policyId: params.policyId } : {}),
        };
        const { sequenceNumber } = await submitEnvelope(client, topicId, env);
        onSubmit?.(env);
        return { sequenceNumber, envelope: env };
      },
    },

    {
      method: TOOL_NAMES.SETTLE,
      name: TOOL_NAMES.SETTLE,
      description:
        'Settle a policy at expiry. Given the policyId, the observed R at expiry, and (if PAID_OUT) the payout transfer tx id, posts a SETTLEMENT envelope and releases the policy from the active exposure book. EXPIRED = no payout; PAID_OUT requires payoutHbar > 0 + a valid payoutTxId. Does NOT itself transfer HBAR — the caller signs the payout transfer first (via kit transfer_hbar_tool, with AgentMode.RETURN_BYTES above the payout autonomous cap).',
      parameters: z.object({
        policyId: z.string().min(1).max(128),
        result: z.enum(['EXPIRED', 'PAID_OUT']),
        observedUsdHr: z.number().positive().finite(),
        observationWindowDays: z.number().int().positive().default(1),
        payoutHbar: z.number().nonnegative().finite(),
        payoutTxId: z.union([TxId, z.null()]),
      }),
      execute: async (client, _ctx, params) => {
        /** @type {import('../hedera/envelope.js').EnvelopeT} */
        const env = {
          v: 1,
          type: 'SETTLEMENT',
          ts: new Date().toISOString(),
          policyId: params.policyId,
          result: params.result,
          observedUsdHr: params.observedUsdHr,
          observationWindowDays: params.observationWindowDays,
          payoutHbar: params.payoutHbar,
          payoutTxId: params.payoutTxId,
        };
        const { sequenceNumber } = await submitEnvelope(client, topicId, env);
        onSubmit?.(env);
        exposure.remove(params.policyId);
        return { sequenceNumber, envelope: env };
      },
    },

    {
      method: TOOL_NAMES.POST_CAPACITY,
      name: TOOL_NAMES.POST_CAPACITY,
      description:
        'Provider hook: post a PROVIDER_CAPACITY envelope advertising H100 capacity + ask price (USD/hr). Used by mock supply-side agents to demonstrate the in-kind settlement roadmap surface. Not used by cash settlement.',
      parameters: z.object({
        provider: AccountId,
        qtyGpuHr: z.number().positive().finite(),
        askUsdHr: z.number().positive().finite(),
        availableUntilTs: z.string().datetime({ offset: true }).optional(),
      }),
      execute: async (client, _ctx, params) => {
        /** @type {import('../hedera/envelope.js').EnvelopeT} */
        const env = {
          v: 1,
          type: 'PROVIDER_CAPACITY',
          ts: new Date().toISOString(),
          provider: params.provider,
          class: 'H100',
          qtyGpuHr: params.qtyGpuHr,
          askUsdHr: params.askUsdHr,
          ...(params.availableUntilTs ? { availableUntilTs: params.availableUntilTs } : {}),
        };
        const { sequenceNumber } = await submitEnvelope(client, topicId, env);
        onSubmit?.(env);
        return { sequenceNumber, envelope: env };
      },
    },

    {
      method: TOOL_NAMES.POOL_STATUS,
      name: TOOL_NAMES.POOL_STATUS,
      description:
        'Return the live pool balance (HBAR, read from the mirror node), the active-policy exposure summary, and headroom for new policies.',
      parameters: z.object({}),
      execute: async () => {
        const balance = await poolBalanceHbar(mirror, underwriterAccountId);
        return exposure.snapshot(balance);
      },
    },

    {
      method: TOOL_NAMES.LIST_POLICIES,
      name: TOOL_NAMES.LIST_POLICIES,
      description:
        'Return the currently-active policies (in-memory list, sorted by window end ascending).',
      parameters: z.object({}),
      execute: async () => exposure.list(),
    },

    {
      method: TOOL_NAMES.GET_PARAMS,
      name: TOOL_NAMES.GET_PARAMS,
      description:
        'Return the price-model parameters being used (κ, θ, σ, λ, jumpMean, jumpStd) and the calibration provenance — sample size, source window, jumps identified. Lets a buyer audit the underwriter\'s pricing assumptions before paying premium.',
      parameters: z.object({}),
      execute: async () => ({
        active: priceParams,
        // Method-of-moments calibration on bundled H100 monthly medians.
        // Threshold-based jump detection (>μ+2σ).
        momCalibratedFromBundledData: calibrate(H100_MONTHLY),
        // EM (Expectation-Maximization) calibration — Press-Ball-Torous
        // jump-diffusion mixture likelihood. Soft posterior probabilities
        // per observation, monotonic log-likelihood guarantee. The "right"
        // way to calibrate jump-diffusion when the dataset is small enough
        // that threshold detection is brittle.
        emCalibratedFromBundledData: emCalibrate(H100_MONTHLY),
        feedSource: priceFeed.getSource(),
        currentRT: priceFeed.getRT(),
        hbarUsdPrice,
      }),
    },
  ];
}
