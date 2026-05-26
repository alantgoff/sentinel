/**
 * Shared type definitions for the Sentinel policy plugin.
 * JSDoc only — no runtime cost; IDEs surface the shapes.
 *
 * @typedef {'ALLOW' | 'DENY' | 'ESCALATE'} Decision
 *
 * @typedef {object} PolicyConfig
 * @property {number} autonomousCapHbar          Above this amount, escalate to a human.
 * @property {number} dailyLimitHbar             Total HBAR allowed to this counterparty per UTC day.
 * @property {number} velocityWindowSeconds      Rolling window for velocity check.
 * @property {number} velocityMaxTxns            Max settlements allowed inside the window.
 * @property {string[]} [serviceAllowlist]       If set, the request's `service` must appear here.
 * @property {string[]} [counterpartyDenylist]   If the seller appears here, DENY without question.
 * @property {number} [hardCapHbar]              Above this, refuse even with human approval. Default 5x autonomousCap.
 *
 * @typedef {object} PaymentRequest
 * @property {string} buyer
 * @property {string} seller
 * @property {string} service
 * @property {number} amountHbar
 * @property {string} [ts]                       ISO timestamp; defaults to "now" at evaluation time.
 *
 * @typedef {object} SettlementRecord
 * @property {string} buyer
 * @property {string} seller
 * @property {string} service
 * @property {number} amountHbar
 * @property {string} ts
 * @property {string} txId
 * @property {boolean} verified                  true iff the mirror node confirmed the transfer
 *
 * @typedef {object} ReputationProfile
 * @property {string} counterparty
 * @property {number} score                      0..100. Higher = more trustworthy.
 * @property {number} verifiedSettlementCount
 * @property {number} totalSettlementClaims      includes unverifiable ones
 * @property {number} verifiedVolumeHbar
 * @property {string | null} oldestVerifiedTs    ISO
 * @property {string | null} newestVerifiedTs    ISO
 * @property {number} denialCount                DENIAL envelopes against this counterparty
 * @property {number} claimToVerifiedRatio       verified / totalClaims, 0..1
 * @property {string[]} reasons                  human-readable breakdown of why we scored this way
 *
 * @typedef {object} RuleResult
 * @property {Decision} decision
 * @property {string} ruleId
 * @property {string} reason
 *
 * @typedef {object} PolicyDecisionT
 * @property {Decision} decision
 * @property {string} ruleId
 * @property {string} reason
 * @property {ReputationProfile} reputation
 * @property {object} effective                  effective limits AFTER reputation adjustment
 * @property {number} effective.autonomousCapHbar
 * @property {number} effective.dailyLimitHbar
 */

export const RULE_IDS = Object.freeze({
  DENYLIST: 'counterparty-denylisted',
  ALLOWLIST: 'service-not-allowlisted',
  HARD_CAP: 'amount-exceeds-hard-cap',
  AUTONOMOUS_CAP: 'amount-exceeds-autonomous-cap',
  DAILY_LIMIT: 'daily-limit-exhausted',
  VELOCITY: 'velocity-limit-exceeded',
  THIN_HISTORY: 'thin-counterparty-history',
  POOR_VERIFIABILITY: 'poor-claim-to-verified-ratio',
  CLEAN: 'within-all-limits',
});
