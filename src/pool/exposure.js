/**
 * Pool + exposure accounting for the Aegis underwriter.
 *
 * The "pool" is the underwriter's HBAR balance (the operator account in the
 * single-process demo; a separately-keyed treasury in production). The
 * exposure module tracks every issued policy's worst-case payout obligation
 * and refuses new policies that would push aggregate worst-case payout above
 * `maxExposureRatio × poolBalance`.
 *
 * Why bother:
 *   - Without this, the underwriter could quote and issue every policy
 *     anyone requests, and a single shock could leave the pool insolvent.
 *   - With this, premiums fund the pool, exposure grows bounded with pool
 *     size, and the demo can show the underwriter declining a too-large cap
 *     ("requested exposure would exceed 50% of pool").
 *
 * The accounting is INTENTIONALLY conservative — we sum maxPayoutHbar across
 * active policies (worst-case, not expected). A more sophisticated version
 * would model joint distributions and use a VaR threshold; for the demo,
 * worst-case-sum is auditable and easy to explain.
 *
 * @typedef {object} ActivePolicy
 * @property {string} policyId
 * @property {string} buyer
 * @property {number} maxPayoutHbar       worst-case obligation of this policy
 * @property {string} windowEndsTs        ISO — used to expire policies from the active set
 *
 * @typedef {object} ExposureBookSnapshot
 * @property {number} poolBalanceHbar
 * @property {number} maxExposureHbar       = poolBalance × maxExposureRatio
 * @property {number} currentExposureHbar   = Σ maxPayoutHbar over active policies
 * @property {number} headroomHbar          = max(0, maxExposureHbar − currentExposureHbar)
 * @property {number} activePolicyCount
 * @property {number} maxExposureRatio
 *
 * @typedef {object} CheckResult
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {ExposureBookSnapshot} snapshot
 * @property {number} proposedExposureHbar
 */

/**
 * In-memory exposure book. Persistence is out of scope for the demo (a
 * restart re-syncs from HCS in production — replay every active POLICY
 * envelope that hasn't been settled yet). See LIMITATIONS.md.
 *
 * @param {object} cfg
 * @param {number} cfg.maxExposureRatio   0 < r ≤ 1
 */
export function createExposureBook({ maxExposureRatio }) {
  if (!(maxExposureRatio > 0 && maxExposureRatio <= 1)) {
    throw new Error('maxExposureRatio must be in (0, 1]');
  }
  /** @type {Map<string, ActivePolicy>} */
  const active = new Map();

  function totalExposureHbar() {
    let s = 0;
    for (const p of active.values()) s += p.maxPayoutHbar;
    return s;
  }

  function snapshot(poolBalanceHbar) {
    if (!(poolBalanceHbar >= 0)) throw new Error('poolBalanceHbar must be ≥ 0');
    const maxExposureHbar = poolBalanceHbar * maxExposureRatio;
    const currentExposureHbar = totalExposureHbar();
    return {
      poolBalanceHbar,
      maxExposureHbar,
      currentExposureHbar,
      headroomHbar: Math.max(0, maxExposureHbar - currentExposureHbar),
      activePolicyCount: active.size,
      maxExposureRatio,
    };
  }

  /**
   * Pre-issuance check: would adding this policy push exposure over the limit?
   *
   * @param {object} args
   * @param {number} args.poolBalanceHbar
   * @param {number} args.proposedMaxPayoutHbar
   * @returns {CheckResult}
   */
  function checkIssuance({ poolBalanceHbar, proposedMaxPayoutHbar }) {
    if (!(proposedMaxPayoutHbar > 0)) {
      throw new Error('proposedMaxPayoutHbar must be > 0');
    }
    const snap = snapshot(poolBalanceHbar);
    const proposedExposureHbar = snap.currentExposureHbar + proposedMaxPayoutHbar;
    if (proposedExposureHbar > snap.maxExposureHbar) {
      return {
        ok: false,
        reason: `requested policy would push aggregate worst-case exposure to ${proposedExposureHbar.toFixed(2)} HBAR, over the ${(snap.maxExposureRatio * 100).toFixed(0)}% pool cap of ${snap.maxExposureHbar.toFixed(2)} HBAR (current: ${snap.currentExposureHbar.toFixed(2)} HBAR, requested: ${proposedMaxPayoutHbar.toFixed(2)} HBAR)`,
        snapshot: snap,
        proposedExposureHbar,
      };
    }
    return { ok: true, snapshot: snap, proposedExposureHbar };
  }

  /**
   * Record a newly-issued policy. Idempotent on policyId.
   *
   * @param {ActivePolicy} policy
   */
  function add(policy) {
    if (!policy?.policyId) throw new Error('policy.policyId is required');
    if (!(policy.maxPayoutHbar > 0)) throw new Error('policy.maxPayoutHbar must be > 0');
    active.set(policy.policyId, policy);
  }

  /**
   * Remove a policy from the active set (called on settlement — EXPIRED or
   * PAID_OUT both release the reserved exposure).
   *
   * @param {string} policyId
   * @returns {boolean}   true if a policy was removed
   */
  function remove(policyId) {
    return active.delete(policyId);
  }

  /**
   * Drop any policy whose `windowEndsTs` is strictly before `nowIso`.
   * Returns the set of policyIds released. Useful for periodic cleanup
   * (in production the settlement handler would call remove() directly).
   *
   * @param {string} nowIso
   * @returns {string[]}
   */
  function dropExpired(nowIso) {
    const released = [];
    const cutoff = Date.parse(nowIso);
    if (!Number.isFinite(cutoff)) throw new Error('nowIso must be a parseable ISO timestamp');
    for (const [id, p] of active.entries()) {
      if (Date.parse(p.windowEndsTs) < cutoff) {
        active.delete(id);
        released.push(id);
      }
    }
    return released;
  }

  function list() {
    return Array.from(active.values()).sort((a, b) => a.windowEndsTs.localeCompare(b.windowEndsTs));
  }

  function has(policyId) { return active.has(policyId); }
  function get(policyId) { return active.get(policyId); }

  return {
    snapshot,
    checkIssuance,
    add,
    remove,
    dropExpired,
    list,
    has,
    get,
  };
}
