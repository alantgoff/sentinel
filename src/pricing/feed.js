import { simulatePath, injectShock as injectShockOnPath, DEFAULT_PARAMS } from './price-model.js';
import { createRng } from './rng.js';

/**
 * Live (in-process) reference-price feed.
 *
 * Generates a single jump-diffusion path over a fixed horizon at construction
 * time, then advances through it on a wall-clock cadence (1 day of model
 * time per `tickMs` of real time). The current R(t) is what the underwriter
 * uses to price quotes and settle policies.
 *
 * The "live" path is CLEARLY LABELED simulated. Any PRICE_REF the underwriter
 * posts to HCS while this feed is active carries source: "sim:labeled"
 * (or "sim:shock" right after injectShock). The envelope schema enforces
 * the label — there is no path through the code that posts an unlabeled
 * feed claim.
 *
 * @typedef {object} FeedOptions
 * @property {number} [R0]              spot price today
 * @property {number} [horizonDays=180] simulated horizon length
 * @property {number} [tickMs=2000]     wall-clock ms per simulated day (UI cadence)
 * @property {number | bigint} [seed]   for reproducibility
 * @property {import('./price-model.js').PriceModelParams} [params]
 * @property {boolean} [autoStart=true] start ticking on construction
 * @property {(snapshot: { day: number, RT: number, source: string }) => void} [onTick]
 */

/**
 * @param {FeedOptions} [opts]
 */
export function createSimFeed(opts = {}) {
  const R0 = opts.R0 ?? 2.5;
  const horizonDays = opts.horizonDays ?? 180;
  const tickMs = opts.tickMs ?? 2_000;
  const params = opts.params ?? DEFAULT_PARAMS;
  const rng = opts.seed !== undefined ? createRng(opts.seed) : createRng();
  const onTick = opts.onTick;

  const path = simulatePath({ R0, days: horizonDays, params, rng });
  let day = 0;
  let source = 'sim:labeled';
  let timer = /** @type {NodeJS.Timeout | null} */ (null);

  function tick() {
    if (day < horizonDays) day += 1;
    onTick?.({ day, RT: path[day], source });
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, tickMs);
    // Don't keep the process alive solely on this timer.
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function getRT() {
    return path[day];
  }

  function getSource() {
    return source;
  }

  function snapshot() {
    return {
      day,
      RT: path[day],
      source,
      horizonDays,
      tickMs,
      pathLen: path.length,
    };
  }

  /**
   * Inject a one-time multiplicative shock at the current day. The path's
   * R at day..horizon is scaled by `magnitude`; the source label becomes
   * "sim:shock" so any PRICE_REF posted afterward is correctly tagged.
   *
   * @param {number} magnitude
   */
  function injectShock(magnitude) {
    injectShockOnPath(path, day, magnitude);
    source = 'sim:shock';
    onTick?.({ day, RT: path[day], source });
  }

  /**
   * Return a copy of the *visible* portion of the path (day 0 .. current day).
   * Used by the UI to draw the sparkline.
   */
  function visiblePath() {
    return Array.from(path.slice(0, day + 1));
  }

  /**
   * Return the last `nDays` observations of R (or all visible observations
   * if nDays > current day). Used by Asian-style settlement to compute the
   * trailing average price.
   *
   * @param {number} nDays
   * @returns {number[]}
   */
  function recentPath(nDays) {
    if (!Number.isInteger(nDays) || nDays < 1) throw new Error('nDays must be a positive integer');
    const start = Math.max(0, day - nDays + 1);
    return Array.from(path.slice(start, day + 1));
  }

  /**
   * Fast-forward the simulation by `days`. Used by the demo to advance to
   * expiry. Caps at horizonDays.
   *
   * @param {number} days
   */
  function advance(days) {
    if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive integer');
    day = Math.min(horizonDays, day + days);
    onTick?.({ day, RT: path[day], source });
  }

  if (opts.autoStart !== false) start();

  return { start, stop, getRT, getSource, snapshot, injectShock, visiblePath, recentPath, advance, path, get day() { return day; } };
}
