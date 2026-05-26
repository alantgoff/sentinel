import { evaluateRules } from './rules.js';
import { buildReputationProfile } from './reputation.js';
import { RULE_IDS } from './types.js';

/**
 * Reputation-aware effective limits.
 *
 * A high-reputation counterparty can be trusted with more autonomy, but only up
 * to the configured hard cap. A counterparty we have no verifiable history with
 * gets the policy defaults — and a thin-history gate (set below).
 *
 * @param {import('./types.js').PolicyConfig} policy
 * @param {import('./types.js').ReputationProfile} rep
 * @returns {{ autonomousCapHbar: number, dailyLimitHbar: number, multiplier: number }}
 */
export function effectiveLimits(policy, rep) {
  const hardCap = policy.hardCapHbar ?? policy.autonomousCapHbar * 5;

  // Map score 0..100 to multiplier 0.5..2.0, applied to both caps. Below 30 we
  // *shrink* the limits (cautious), above 70 we expand them.
  const score = rep.score;
  const multiplier =
    score >= 90 ? 2.0 :
    score >= 70 ? 1.5 :
    score >= 50 ? 1.0 :
    score >= 30 ? 0.75 :
                   0.5;

  return {
    autonomousCapHbar: Math.min(hardCap, policy.autonomousCapHbar * multiplier),
    dailyLimitHbar: policy.dailyLimitHbar * multiplier,
    multiplier,
  };
}

/**
 * The full policy decision: combine reputation + rules.
 *
 * Pre-rule short circuits (these run before evaluateRules so they win even
 * when the amount is "small"):
 *   - "thin history": fewer than 3 verified settlements → ESCALATE. New
 *     counterparties don't get autonomous spend; a human says yes the first
 *     few times.
 *   - "poor verifiability": claim-to-verified ratio < 0.5 with > 2 claims →
 *     DENY. The counterparty has a track record of fabricated HCS entries.
 *
 * After those, we run the rule engine against the EFFECTIVE limits (which
 * may have been raised or lowered by the reputation score).
 *
 * @param {object} params
 * @param {import('./types.js').PaymentRequest} params.request
 * @param {import('./types.js').PolicyConfig} params.policy
 * @param {import('./types.js').ReputationProfile} params.reputation
 * @param {import('./types.js').SettlementRecord[]} [params.recentSettlements]
 * @param {string} [params.now]
 * @returns {import('./types.js').PolicyDecisionT}
 */
export function decidePolicy({ request, policy, reputation, recentSettlements, now }) {
  const limits = effectiveLimits(policy, reputation);
  const effectivePolicy = {
    ...policy,
    autonomousCapHbar: limits.autonomousCapHbar,
    dailyLimitHbar: limits.dailyLimitHbar,
  };

  // Poor verifiability — counterparty has been claiming settlements we can't
  // confirm. This is a stronger fraud signal than "they're new", so it runs
  // before the thin-history gate.
  if (reputation.totalSettlementClaims > 2 && reputation.claimToVerifiedRatio < 0.5) {
    return {
      decision: 'DENY',
      ruleId: RULE_IDS.POOR_VERIFIABILITY,
      reason: `only ${reputation.verifiedSettlementCount}/${reputation.totalSettlementClaims} of this counterparty's settlement claims verify on the mirror node`,
      reputation,
      effective: { autonomousCapHbar: limits.autonomousCapHbar, dailyLimitHbar: limits.dailyLimitHbar },
    };
  }

  // Thin-history gate — new counterparties don't get autonomous spend; a human
  // says yes the first few times.
  const MIN_VERIFIED_FOR_AUTONOMY = 3;
  if (reputation.verifiedSettlementCount < MIN_VERIFIED_FOR_AUTONOMY) {
    return {
      decision: 'ESCALATE',
      ruleId: RULE_IDS.THIN_HISTORY,
      reason: `counterparty has only ${reputation.verifiedSettlementCount} verified settlements (need ≥ ${MIN_VERIFIED_FOR_AUTONOMY} for autonomous spend)`,
      reputation,
      effective: { autonomousCapHbar: limits.autonomousCapHbar, dailyLimitHbar: limits.dailyLimitHbar },
    };
  }

  const ruleResult = evaluateRules(request, {
    policy: effectivePolicy,
    recentSettlements,
    now,
  });

  return {
    decision: ruleResult.decision,
    ruleId: ruleResult.ruleId,
    reason: ruleResult.reason,
    reputation,
    effective: { autonomousCapHbar: limits.autonomousCapHbar, dailyLimitHbar: limits.dailyLimitHbar },
  };
}

/**
 * One-shot helper: fetch the counterparty's reputation, then decide.
 *
 * @param {object} params
 * @param {import('../hedera/mirror.js').MirrorClient} params.mirror
 * @param {string} params.topicId
 * @param {import('./types.js').PaymentRequest} params.request
 * @param {import('./types.js').PolicyConfig} params.policy
 * @param {import('./types.js').SettlementRecord[]} [params.recentSettlements]
 * @param {string} [params.now]
 * @returns {Promise<import('./types.js').PolicyDecisionT>}
 */
export async function evaluatePayment({ mirror, topicId, request, policy, recentSettlements, now }) {
  const reputation = await buildReputationProfile({
    mirror,
    topicId,
    counterparty: request.seller,
    viewer: request.buyer,
  });
  return decidePolicy({ request, policy, reputation, recentSettlements, now });
}
