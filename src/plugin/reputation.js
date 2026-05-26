import { matchesExpectedTransfer } from '../hedera/mirror.js';
import { readEnvelopes } from '../hedera/hcs.js';

/**
 * Build a verifiable reputation profile for `counterparty` by:
 *   1. reading every envelope on the Sentinel topic via mirror REST
 *   2. dropping anything that isn't a Sentinel envelope (malformed / third-party)
 *   3. for SETTLEMENT envelopes mentioning this counterparty, independently
 *      verifying the referenced txId against the mirror node — and confirming
 *      the actual transfer set matches the envelope's claim
 *   4. scoring only the verified subset
 *
 * This is the trust-boundary core of the project — see LIMITATIONS.md.
 *
 * @param {object} params
 * @param {import('../hedera/mirror.js').MirrorClient} params.mirror
 * @param {string} params.topicId
 * @param {string} params.counterparty                       0.0.x — usually the seller from the buyer's POV
 * @param {string} [params.viewer]                           0.0.x — usually the buyer asking. Restricts to envelopes
 *                                                          where {viewer, counterparty} are the parties.
 * @param {object} [params.opts]
 * @param {number} [params.opts.recencyHalfLifeDays]         decay weight for recency, default 30
 * @param {(amount: number) => number} [params.opts.volumeWeight]
 * @returns {Promise<import('./types.js').ReputationProfile>}
 */
export async function buildReputationProfile({ mirror, topicId, counterparty, viewer, opts = {} }) {
  const recencyHalfLifeDays = opts.recencyHalfLifeDays ?? 30;
  const items = await readEnvelopes(mirror, topicId);

  const relevant = items.filter(({ envelope }) => {
    if (!envelope) return false;
    if (envelope.buyer !== counterparty && envelope.seller !== counterparty) return false;
    if (viewer && envelope.buyer !== viewer && envelope.seller !== viewer) return false;
    return true;
  });

  const settlementClaims = relevant.filter(({ envelope }) => envelope?.type === 'SETTLEMENT');
  const denials = relevant.filter(({ envelope }) => envelope?.type === 'DENIAL');

  /** @type {import('./types.js').SettlementRecord[]} */
  const verifiedRecords = [];
  const verificationFailures = [];

  for (const { envelope } of settlementClaims) {
    if (!envelope || envelope.type !== 'SETTLEMENT') continue;
    const v = await mirror.verifyTransaction(envelope.txId);
    const match = matchesExpectedTransfer(v, {
      buyer: envelope.buyer,
      seller: envelope.seller,
      amountHbar: envelope.amountHbar,
    });
    if (match.ok) {
      verifiedRecords.push({
        buyer: envelope.buyer,
        seller: envelope.seller,
        service: envelope.service,
        amountHbar: envelope.amountHbar,
        ts: envelope.ts,
        txId: envelope.txId,
        verified: true,
      });
    } else {
      verificationFailures.push({ txId: envelope.txId, reason: match.reason });
    }
  }

  verifiedRecords.sort((a, b) => a.ts.localeCompare(b.ts));

  const verifiedCount = verifiedRecords.length;
  const totalClaims = settlementClaims.length;
  const claimToVerifiedRatio = totalClaims === 0 ? 1 : verifiedCount / totalClaims;

  const verifiedVolumeHbar = verifiedRecords.reduce((a, r) => a + r.amountHbar, 0);
  const oldestVerifiedTs = verifiedRecords[0]?.ts ?? null;
  const newestVerifiedTs = verifiedRecords[verifiedRecords.length - 1]?.ts ?? null;

  // Score: bounded 0..100. Built from four independent components, then capped.
  // Each component is deliberately conservative — a thin-but-clean history
  // shouldn't read as "deep clean history."
  const reasons = [];

  // Component A — count of verified settlements (logarithmic).
  // 0 → 0pts, 1 → ~8, 5 → ~25, 20 → ~40, capped at 40.
  const countComponent = Math.min(40, Math.round(Math.log2(verifiedCount + 1) * 8));
  reasons.push(`count: ${verifiedCount} verified settlements → ${countComponent} pts`);

  // Component B — total verified volume (logarithmic).
  // 0 HBAR → 0, 1 HBAR → ~5, 10 HBAR → ~15, 100 HBAR → ~25, capped at 30.
  const volumeComponent = Math.min(
    30,
    Math.round(Math.log10(verifiedVolumeHbar + 1) * 12),
  );
  reasons.push(`volume: ${verifiedVolumeHbar.toFixed(2)} HBAR verified → ${volumeComponent} pts`);

  // Component C — recency. Most recent verified settlement decays with half-life.
  let recencyComponent = 0;
  if (newestVerifiedTs) {
    const ageMs = Date.now() - new Date(newestVerifiedTs).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const decay = Math.pow(0.5, ageDays / recencyHalfLifeDays);
    recencyComponent = Math.round(15 * decay);
    reasons.push(
      `recency: last verified settlement ${ageDays.toFixed(1)}d ago → ${recencyComponent} pts (half-life ${recencyHalfLifeDays}d)`,
    );
  } else {
    reasons.push('recency: no verified settlements ever → 0 pts');
  }

  // Component D — verifiability ratio penalty. Claims we couldn't confirm
  // hurt the most: they suggest the counterparty fabricates HCS entries.
  let verifiabilityComponent = 0;
  if (totalClaims > 0) {
    verifiabilityComponent = Math.round(15 * claimToVerifiedRatio);
    reasons.push(
      `verifiability: ${verifiedCount}/${totalClaims} claims confirmed → ${verifiabilityComponent} pts`,
    );
    if (verificationFailures.length > 0) {
      reasons.push(
        `WARN: ${verificationFailures.length} claim(s) failed mirror verification` +
          (verificationFailures.length <= 3
            ? ` (${verificationFailures.map((f) => `${f.txId}: ${f.reason}`).join('; ')})`
            : ''),
      );
    }
  } else {
    reasons.push('verifiability: no claims to verify');
  }

  // Denials drop the score slightly (counterparty was caught misbehaving before).
  const denialPenalty = Math.min(20, denials.length * 4);
  if (denials.length > 0) {
    reasons.push(`-${denialPenalty} pts: ${denials.length} prior DENIAL/ESCALATE events on this counterparty`);
  }

  let score = countComponent + volumeComponent + recencyComponent + verifiabilityComponent - denialPenalty;
  score = Math.max(0, Math.min(100, score));

  return {
    counterparty,
    score,
    verifiedSettlementCount: verifiedCount,
    totalSettlementClaims: totalClaims,
    verifiedVolumeHbar,
    oldestVerifiedTs,
    newestVerifiedTs,
    denialCount: denials.length,
    claimToVerifiedRatio,
    reasons,
  };
}
