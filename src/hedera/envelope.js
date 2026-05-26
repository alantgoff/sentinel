import { z } from 'zod';

/**
 * Sentinel HCS message envelope (v1).
 *
 * Posted to the Sentinel topic for every step of the buyer/seller flow:
 *   QUOTE            — seller quotes a price for a request
 *   POLICY_DECISION  — Sentinel plugin returns ALLOW / ESCALATE
 *   SETTLEMENT       — on-chain HBAR transfer succeeded; carries the txId
 *   DENIAL           — policy denied (or human escalation rejected)
 *
 * The envelope is INDEX, not proof. Reputation is computed only over SETTLEMENT
 * records whose txId resolves to a confirmed transfer on the mirror node — see
 * LIMITATIONS.md.
 */

const AccountId = z.string().regex(/^\d+\.\d+\.\d+$/, 'expected 0.0.xxxxxx');

// Hedera SDK serializes transaction IDs as "0.0.123@seconds.nanos" or "0.0.123-seconds-nanos".
// Mirror node REST exposes the dashed form. We accept both and normalize on the way out.
const TxId = z.string().regex(
  /^\d+\.\d+\.\d+[@\-]\d+[\.\-]\d+$/,
  'expected 0.0.x@seconds.nanos or 0.0.x-seconds-nanos',
);

const Iso = z.string().datetime({ offset: true });

const PolicyResult = z.enum(['ALLOW', 'DENY', 'ESCALATE']);

const PolicySnapshot = z.object({
  ruleId: z.string().min(1),
  result: PolicyResult,
  reason: z.string().min(1),
});

const Base = z.object({
  v: z.literal(1),
  ts: Iso,
  buyer: AccountId,
  seller: AccountId,
  service: z.string().min(1).max(128),
  amountHbar: z.number().nonnegative().finite(),
  /** Optional free-form identifier linking QUOTE → POLICY_DECISION → SETTLEMENT for one request. */
  requestId: z.string().min(1).max(128).optional(),
});

const Quote = Base.extend({
  type: z.literal('QUOTE'),
  quoteExpiresAt: Iso.optional(),
});

const PolicyDecision = Base.extend({
  type: z.literal('POLICY_DECISION'),
  policy: PolicySnapshot,
});

const Settlement = Base.extend({
  type: z.literal('SETTLEMENT'),
  txId: TxId,
  policy: PolicySnapshot.optional(),
});

const Denial = Base.extend({
  type: z.literal('DENIAL'),
  policy: PolicySnapshot.refine((p) => p.result === 'DENY' || p.result === 'ESCALATE', {
    message: 'DENIAL must carry a DENY or ESCALATE policy snapshot',
  }),
});

export const Envelope = z.discriminatedUnion('type', [Quote, PolicyDecision, Settlement, Denial]);

/** @typedef {z.infer<typeof Envelope>} EnvelopeT */

/**
 * Normalize a transaction ID to the dashed mirror-node form.
 * "0.0.1234@1700000000.123456789" -> "0.0.1234-1700000000-123456789"
 *
 * @param {string} txId
 * @returns {string}
 */
export function normalizeTxId(txId) {
  return txId.replace('@', '-').replace(/\.(\d+)$/, '-$1');
}

/**
 * Parse and validate an envelope. Throws ZodError on failure.
 *
 * @param {unknown} raw
 * @returns {EnvelopeT}
 */
export function parseEnvelope(raw) {
  return Envelope.parse(raw);
}

/**
 * Safe-parse — returns { success: true, data } or { success: false, error }.
 *
 * @param {unknown} raw
 */
export function safeParseEnvelope(raw) {
  return Envelope.safeParse(raw);
}

/**
 * Encode an envelope as the UTF-8 JSON string that will be submitted to HCS.
 * Keeps key order stable so the same logical message hashes identically.
 *
 * @param {EnvelopeT} env
 * @returns {string}
 */
export function encodeEnvelope(env) {
  const validated = Envelope.parse(env);
  return JSON.stringify(validated);
}

/**
 * Decode an HCS message body (base64-encoded UTF-8 JSON from mirror node, or
 * raw JSON string) into a validated envelope, or null if it isn't a Sentinel
 * envelope. We deliberately swallow parse errors here — third parties may
 * write garbage to the same topic and the reputation engine must shrug it off.
 *
 * @param {string} body            mirror-node `message` field or a JSON string
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
