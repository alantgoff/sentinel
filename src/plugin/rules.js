import { RULE_IDS } from './types.js';

/**
 * Pure rule engine. No I/O. Given a payment request, the active PolicyConfig,
 * and the counterparty's recent verified settlement history, returns the first
 * rule that fires.
 *
 * Order matters: hard denials before escalations, hard cap before autonomous
 * cap, daily before velocity. Order encodes priority.
 *
 * @param {import('./types.js').PaymentRequest} req
 * @param {object} ctx
 * @param {import('./types.js').PolicyConfig} ctx.policy
 * @param {import('./types.js').SettlementRecord[]} [ctx.recentSettlements]
 *        Verified settlements against the same counterparty in the past ~24h.
 * @param {string} [ctx.now]   ISO override; defaults to new Date()
 * @returns {import('./types.js').RuleResult}
 */
export function evaluateRules(req, ctx) {
  const { policy } = ctx;
  const settlements = ctx.recentSettlements ?? [];
  const now = ctx.now ? new Date(ctx.now) : new Date();

  if (policy.counterpartyDenylist?.includes(req.seller)) {
    return {
      decision: 'DENY',
      ruleId: RULE_IDS.DENYLIST,
      reason: `seller ${req.seller} is on the denylist`,
    };
  }

  if (policy.serviceAllowlist && !policy.serviceAllowlist.includes(req.service)) {
    return {
      decision: 'DENY',
      ruleId: RULE_IDS.ALLOWLIST,
      reason: `service "${req.service}" is not on the allowlist`,
    };
  }

  const hardCap = policy.hardCapHbar ?? policy.autonomousCapHbar * 5;
  if (req.amountHbar > hardCap) {
    return {
      decision: 'DENY',
      ruleId: RULE_IDS.HARD_CAP,
      reason: `amount ${req.amountHbar} HBAR exceeds hard cap ${hardCap} HBAR (autonomousCap × 5)`,
    };
  }

  // Daily limit (UTC day) over verified settlements + this proposed amount.
  const startOfDayMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const todaysTotal = settlements
    .filter((s) => new Date(s.ts).getTime() >= startOfDayMs)
    .reduce((a, s) => a + s.amountHbar, 0);
  if (todaysTotal + req.amountHbar > policy.dailyLimitHbar) {
    return {
      decision: 'ESCALATE',
      ruleId: RULE_IDS.DAILY_LIMIT,
      reason: `today's verified spend ${todaysTotal} + ${req.amountHbar} HBAR would exceed daily limit ${policy.dailyLimitHbar}`,
    };
  }

  // Velocity: how many verified settlements landed in the rolling window?
  const windowStartMs = now.getTime() - policy.velocityWindowSeconds * 1000;
  const inWindow = settlements.filter((s) => new Date(s.ts).getTime() >= windowStartMs).length;
  if (inWindow + 1 > policy.velocityMaxTxns) {
    return {
      decision: 'ESCALATE',
      ruleId: RULE_IDS.VELOCITY,
      reason: `${inWindow} settlements in the last ${policy.velocityWindowSeconds}s already; max is ${policy.velocityMaxTxns}`,
    };
  }

  if (req.amountHbar > policy.autonomousCapHbar) {
    return {
      decision: 'ESCALATE',
      ruleId: RULE_IDS.AUTONOMOUS_CAP,
      reason: `amount ${req.amountHbar} HBAR exceeds autonomous cap ${policy.autonomousCapHbar} HBAR`,
    };
  }

  return {
    decision: 'ALLOW',
    ruleId: RULE_IDS.CLEAN,
    reason: 'within all configured limits',
  };
}
