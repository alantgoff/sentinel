/**
 * Tiny seeded PRNG (xorshift128+). Used by the Monte Carlo pricer so the
 * unit tests are deterministic and the UI can re-run a quote and get the
 * same number when the operator wants to reproduce a result.
 *
 * Returns floats in [0, 1).
 *
 * @param {number | bigint} [seed]   default = a high-entropy mix of time + Math.random
 */
export function createRng(seed) {
  // 64-bit state seeded from input. We accept number, bigint, or undefined.
  let s0, s1;
  if (seed === undefined) {
    const t = BigInt(Date.now());
    const r = BigInt(Math.floor(Math.random() * 0xffffffff));
    s0 = (t ^ (r << 32n)) & 0xffffffffffffffffn;
    s1 = ((r * 0x9e3779b97f4a7c15n) ^ t) & 0xffffffffffffffffn;
  } else {
    const x = typeof seed === 'bigint' ? seed : BigInt(seed >>> 0);
    s0 = x | 1n;
    s1 = (x * 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    if (s1 === 0n) s1 = 0x9e3779b97f4a7c15n;
  }
  // Burn-in a few rounds to mix bits.
  const MASK = 0xffffffffffffffffn;
  for (let i = 0; i < 5; i++) step();
  function step() {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= (x << 23n) & MASK;
    s1 = (x ^ y ^ (x >> 17n) ^ (y >> 26n)) & MASK;
    return (s1 + y) & MASK;
  }
  /** @returns {number} float in [0, 1) */
  function next() {
    const raw = step();
    // Take top 53 bits → IEEE-754 mantissa precision
    return Number(raw >> 11n) / Number(1n << 53n);
  }
  /** Standard normal via Box-Muller. */
  function nextNormal() {
    // Avoid u === 0 (log(0) = -Inf)
    let u;
    do { u = next(); } while (u === 0);
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  return { next, nextNormal };
}
