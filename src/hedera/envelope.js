import { z } from 'zod';

/**
 * Aegis HCS message envelope (v1).
 *
 * Posted to the Aegis topic for every step of the cost-cap-option lifecycle:
 *
 *   POLICY              issued by the underwriter when a buyer pays premium.
 *                       Carries the contract terms (strike, notional, window)
 *                       and the on-chain premium transfer's txId.
 *
 *   PRICE_REF           an observed (or simulated-and-labeled) reference price
 *                       for the underlying R. Posted continuously by the
 *                       price-feed adapter; also posted at expiry to freeze
 *                       the R_observed that drives settlement.
 *
 *   SETTLEMENT          terminal state of a policy at expiry. Either
 *                       EXPIRED (no payout, R stayed ≤ K) or PAID_OUT
 *                       (carries the payout transfer's txId).
 *
 *   PROVIDER_CAPACITY   posted by a supply-side provider agent advertising
 *                       capacity + ask price. Supports the in-kind settlement
 *                       roadmap; for the demo we may run 1–2 mock providers.
 *
 * The envelope is INDEX, not proof. Trust substrate = the on-chain HBAR
 * transfers (premium and payout) referenced by `premiumTxId` / `payoutTxId`,
 * independently re-verified against the mirror node. See LIMITATIONS.md.
 */

const AccountId = z.string().regex(/^\d+\.\d+\.\d+$/, 'expected 0.0.xxxxxx');

const TxId = z.string().regex(
  /^\d+\.\d+\.\d+[@\-]\d+[\.\-]\d+$/,
  'expected 0.0.x@seconds.nanos or 0.0.x-seconds-nanos',
);

const Iso = z.string().datetime({ offset: true });

const GpuClass = z.enum(['H100']); // expand later (A100, H200, etc.) when calibrated

const PriceSource = z.string().regex(
  /^(sim:labeled|sim:shock|calibration:[a-z0-9-]+)$/,
  'price source must be "sim:labeled" (default simulated path), "sim:shock" (post-shock-injection), or "calibration:<dataset-id>"',
);

const Base = z.object({
  v: z.literal(1),
  ts: Iso,
});

const Policy = Base.extend({
  type: z.literal('POLICY'),
  policyId: z.string().min(1).max(128),
  buyer: AccountId,
  underwriter: AccountId,
  class: GpuClass,
  strikeUsdHr: z.number().positive().finite(),
  qtyGpuHr: z.number().positive().finite(),
  windowEndsTs: Iso,
  premiumHbar: z.number().positive().finite(),
  premiumTxId: TxId,
  maxPayoutHbar: z.number().positive().finite(),
  /** Snapshot of pricing inputs at issuance — auditability. */
  pricing: z.object({
    r0UsdHr: z.number().positive(),
    expectedPayoutHbar: z.number().nonnegative(),
    riskLoadHbar: z.number().nonnegative(),
    opsLoadHbar: z.number().nonnegative(),
    paths: z.number().int().positive(),
    ci95Hbar: z.tuple([z.number().nonnegative(), z.number().nonnegative()]),
  }).optional(),
});

const PriceRef = Base.extend({
  type: z.literal('PRICE_REF'),
  /** Optional — `policyId` ties this reference to a specific policy at expiry. */
  policyId: z.string().min(1).max(128).optional(),
  observedUsdHr: z.number().positive().finite(),
  source: PriceSource,
});

const SettlementResult = z.enum(['EXPIRED', 'PAID_OUT']);

const Settlement = Base.extend({
  type: z.literal('SETTLEMENT'),
  policyId: z.string().min(1).max(128),
  result: SettlementResult,
  /**
   * Settlement reference price. For Asian-style settlement (the default),
   * this is the arithmetic mean of R over the trailing `observationWindowDays`
   * — manipulation-resistant, the same construction CME/ICE commodity
   * contracts use. Single-point settlement (the original European form)
   * is observationWindowDays = 1.
   */
  observedUsdHr: z.number().positive().finite(),
  observationWindowDays: z.number().int().positive().default(1),
  payoutHbar: z.number().nonnegative().finite(),
  payoutTxId: z.union([TxId, z.null()]),
}).superRefine((s, ctx) => {
  if (s.result === 'PAID_OUT') {
    if (s.payoutHbar <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PAID_OUT requires payoutHbar > 0', path: ['payoutHbar'] });
    }
    if (!s.payoutTxId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PAID_OUT requires payoutTxId', path: ['payoutTxId'] });
    }
  } else if (s.result === 'EXPIRED') {
    if (s.payoutHbar !== 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EXPIRED implies payoutHbar === 0', path: ['payoutHbar'] });
    }
    if (s.payoutTxId !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EXPIRED implies payoutTxId === null', path: ['payoutTxId'] });
    }
  }
});

const ProviderCapacity = Base.extend({
  type: z.literal('PROVIDER_CAPACITY'),
  provider: AccountId,
  class: GpuClass,
  qtyGpuHr: z.number().positive().finite(),
  askUsdHr: z.number().positive().finite(),
  /** Optional window during which the capacity is available. */
  availableUntilTs: Iso.optional(),
});

// Zod 4: discriminatedUnion can't include a refined member directly. Use a
// union with a manual discriminator-style narrow at the top + the refined
// Settlement schema separately.
export const Envelope = z.union([Policy, PriceRef, Settlement, ProviderCapacity]);

/** @typedef {z.infer<typeof Envelope>} EnvelopeT */

export const ENVELOPE_TYPES = /** @type {const} */ (['POLICY', 'PRICE_REF', 'SETTLEMENT', 'PROVIDER_CAPACITY']);

/** Normalize tx ids to the dashed mirror-node form. */
export function normalizeTxId(txId) {
  return txId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
}

export function parseEnvelope(raw) {
  return Envelope.parse(raw);
}

export function safeParseEnvelope(raw) {
  return Envelope.safeParse(raw);
}

export function encodeEnvelope(env) {
  const validated = Envelope.parse(env);
  return JSON.stringify(validated);
}

/**
 * Decode a body the mirror returns (base64-encoded UTF-8 JSON) or a raw JSON
 * string into a validated envelope, or null if the body isn't an Aegis
 * envelope. Returns null silently for unknown content so the underwriter can
 * tolerate junk posted to the same topic.
 *
 * @param {string} body
 * @param {{ alreadyDecoded?: boolean }} [opts]
 * @returns {EnvelopeT | null}
 */
export function decodeEnvelope(body, opts = {}) {
  let json;
  try {
    const text = opts.alreadyDecoded ? body : Buffer.from(body, 'base64').toString('utf8');
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const result = Envelope.safeParse(json);
  return result.success ? result.data : null;
}
