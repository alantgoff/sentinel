/**
 * Pool balance reader. Wraps the kit's mirror-node-backed HBAR balance query
 * so the exposure book always asks the actual ledger, not a cached number.
 *
 * Reading the pool balance from the mirror node (not the operator's local
 * Hedera SDK client query) keeps the trust boundary consistent: the same
 * source verifies premiums-in and payouts-out, so what the underwriter "sees"
 * as the pool size is exactly what any external observer sees.
 */
import BigNumber from 'bignumber.js';

/**
 * @param {import('../hedera/mirror.js').MirrorClient} mirror
 * @param {string} accountId
 * @returns {Promise<number>}  HBAR (not tinybars). Truncated to 8 decimals.
 */
export async function poolBalanceHbar(mirror, accountId) {
  // Mirror /api/v1/accounts/{id} returns balance.balance in tinybars.
  const payload = await mirror.getJson(`/api/v1/accounts/${accountId}`);
  const tinybars = payload?.balance?.balance;
  if (typeof tinybars !== 'number' && typeof tinybars !== 'string') {
    throw new Error(`mirror returned no balance for ${accountId}`);
  }
  // Use BigNumber to avoid precision loss at large balances; truncate to 8dp.
  const hbar = new BigNumber(tinybars).dividedBy(1e8);
  return Number(hbar.toFixed(8));
}
