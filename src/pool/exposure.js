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
 * @property {number} [strikeUsdHr]       enables joint-VaR exposure (needed for the joint payout function)
 * @property {number} [qtyGpuHr]
 * @property {number} [maxPayoutCapUsd]   per-policy USD cap, if set on the contract
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
 *
 * @typedef {object} JointCheckResult
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {ExposureBookSnapshot} snapshot
 * @property {number} jointVarHbar          requested-quantile joint payout in HBAR
 * @property {number} jointMaxHbar          empirical max joint payout across simulated paths
 * @property {number} pathsUsed
 * @property {number} quantile
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

  /**
   * Joint-payout VaR check. Stricter than checkIssuance because it accounts
   * for the dependence structure: all active and proposed policies pay out
   * against the SAME underlying R, so their joint payout distribution is
   * comonotone in R — Σ-maxPayout is the comonotone upper bound, but the
   * 99% quantile of the joint payout sum sits *below* that bound for any
   * heterogeneous strike basket.
   *
   * The caller supplies a simulator that returns R_T samples (typically
   * from the stressed regime — see maxLikelyPayoutHbar). For each sample,
   * we evaluate every active policy's payout + the proposed policy's
   * payout, sum, then take the q-quantile of the sum. If that joint q-VaR
   * fits inside the pool cap, the policy is acceptable. Otherwise we
   * refuse with the actual VaR number in the reason.
   *
   * Approximation: all policies are evaluated at a single shared R_T from
   * the simulator (so we're effectively asking "what's the joint payout if
   * the squeeze regime sends R to value x at expiry"). Active policies
   * whose windows have already expired in real wall time would not actually
   * pay against this R, but they're already booked into the basket — this
   * is conservative.
   *
   * @param {object} args
   * @param {number} args.poolBalanceHbar
   * @param {ActivePolicy & { strikeUsdHr: number, qtyGpuHr: number, maxPayoutCapUsd?: number }} args.proposedPolicy
   * @param {(args: { paths: number }) => number[]} args.rTSampler   stressed R_T samples
   * @param {number} args.hbarUsdPrice
   * @param {number} [args.quantile=0.99]
   * @param {number} [args.paths=5000]
   * @returns {JointCheckResult}
   */
  function checkIssuanceJointVaR({
    poolBalanceHbar, proposedPolicy, rTSampler,
    hbarUsdPrice, quantile = 0.99, paths = 5000,
  }) {
    if (!(quantile > 0 && quantile < 1)) throw new Error('quantile must be in (0, 1)');
    if (!(hbarUsdPrice > 0)) throw new Error('hbarUsdPrice must be positive');
    const snap = snapshot(poolBalanceHbar);

    const basket = [...active.values(), proposedPolicy];
    // Filter to policies with the K/Q metadata needed for joint payout.
    // Anything missing K/Q (legacy records) gets its maxPayoutHbar treated
    // as a deterministic worst-case contribution — conservatively added in
    // full. The proposed policy is always required to have K/Q.
    if (typeof proposedPolicy.strikeUsdHr !== 'number' || typeof proposedPolicy.qtyGpuHr !== 'number') {
      throw new Error('proposedPolicy must include strikeUsdHr and qtyGpuHr for joint-VaR');
    }
    const sampleable = basket.filter((p) => typeof p.strikeUsdHr === 'number' && typeof p.qtyGpuHr === 'number');
    const fixedHbar = basket
      .filter((p) => typeof p.strikeUsdHr !== 'number' || typeof p.qtyGpuHr !== 'number')
      .reduce((a, p) => a + p.maxPayoutHbar, 0);

    const samples = rTSampler({ paths });
    const N = samples.length;
    if (N === 0) throw new Error('rTSampler returned zero samples');
    const sums = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const r = samples[i];
      let sumUsd = 0;
      for (const p of sampleable) {
        const payoutUsd = Math.max(0, r - /** @type {number} */ (p.strikeUsdHr)) * /** @type {number} */ (p.qtyGpuHr);
        const cap = p.maxPayoutCapUsd ?? Infinity;
        sumUsd += Math.min(payoutUsd, cap);
      }
      sums[i] = sumUsd / hbarUsdPrice + fixedHbar;
    }
    const sorted = Array.from(sums).sort((a, b) => a - b);
    const idx = Math.min(N - 1, Math.floor(quantile * N));
    const jointVarHbar = sorted[idx];
    const jointMaxHbar = sorted[N - 1];

    if (jointVarHbar > snap.maxExposureHbar) {
      return {
        ok: false,
        reason: `joint ${(quantile * 100).toFixed(1)}% VaR of ${jointVarHbar.toFixed(2)} HBAR (including this proposed policy) exceeds the ${(snap.maxExposureRatio * 100).toFixed(0)}% pool cap of ${snap.maxExposureHbar.toFixed(2)} HBAR`,
        snapshot: snap,
        jointVarHbar,
        jointMaxHbar,
        pathsUsed: N,
        quantile,
      };
    }
    return { ok: true, snapshot: snap, jointVarHbar, jointMaxHbar, pathsUsed: N, quantile };
  }

  return {
    snapshot,
    checkIssuance,
    checkIssuanceJointVaR,
    add,
    remove,
    dropExpired,
    list,
    has,
    get,
  };
}
