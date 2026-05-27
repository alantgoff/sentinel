import { loadConfig } from './config.js';
import { buildClient } from './hedera/client.js';
import { createMirrorClient } from './hedera/mirror.js';
import { createExposureBook } from './pool/exposure.js';
import { createSimFeed } from './pricing/feed.js';
import { DEFAULT_PARAMS } from './pricing/price-model.js';
import { createAegisPlugin } from './plugin/index.js';
import { createUnderwriter } from './agents/underwriter.js';
import { createBuyer } from './agents/buyer.js';
import { createProvider } from './agents/provider.js';

/**
 * Wire up the full Aegis system. Returns the singletons the server holds:
 * config, mirror, price feed, exposure book, plugin, underwriter, buyer,
 * optional provider, and a close() that cleans up clients + the feed timer.
 *
 * @param {object} [opts]
 * @param {(env: import('./hedera/envelope.js').EnvelopeT) => void} [opts.onSubmit]
 *        Live UI broadcast — invoked whenever any agent posts an envelope.
 * @param {(snapshot: { day: number, RT: number, source: string }) => void} [opts.onTick]
 *        Live UI broadcast — invoked on every price-feed tick.
 * @param {number} [opts.hbarUsdPrice=0.05]
 * @param {number} [opts.feedTickMs]
 */
export function bootstrapAegis(opts = {}) {
  const cfg = loadConfig();
  if (!cfg.AEGIS_TOPIC_ID) {
    throw new Error(
      'AEGIS_TOPIC_ID is not set. Run `npm run smoke:hcs` first; it will create a topic and print the id to paste into .env.',
    );
  }

  const buyerClient = buildClient({
    network: cfg.HEDERA_NETWORK,
    accountId: cfg.BUYER_ACCOUNT_ID,
    privateKey: cfg.BUYER_PRIVATE_KEY,
  });

  const haveDedicatedUnderwriter =
    cfg.UNDERWRITER_ACCOUNT_ID &&
    cfg.UNDERWRITER_PRIVATE_KEY &&
    cfg.UNDERWRITER_ACCOUNT_ID !== cfg.BUYER_ACCOUNT_ID;

  const underwriterClient = haveDedicatedUnderwriter
    ? buildClient({
        network: cfg.HEDERA_NETWORK,
        accountId: /** @type {string} */ (cfg.UNDERWRITER_ACCOUNT_ID),
        privateKey: /** @type {string} */ (cfg.UNDERWRITER_PRIVATE_KEY),
      })
    : null;

  const haveProvider =
    cfg.PROVIDER_ACCOUNT_ID &&
    cfg.PROVIDER_PRIVATE_KEY &&
    cfg.PROVIDER_ACCOUNT_ID !== cfg.BUYER_ACCOUNT_ID &&
    cfg.PROVIDER_ACCOUNT_ID !== cfg.UNDERWRITER_ACCOUNT_ID;

  const providerClient = haveProvider
    ? buildClient({
        network: cfg.HEDERA_NETWORK,
        accountId: /** @type {string} */ (cfg.PROVIDER_ACCOUNT_ID),
        privateKey: /** @type {string} */ (cfg.PROVIDER_PRIVATE_KEY),
      })
    : null;

  const mirror = createMirrorClient({ baseUrl: cfg.MIRROR_NODE_URL });
  const exposure = createExposureBook({ maxExposureRatio: cfg.MAX_EXPOSURE_RATIO });

  // Runtime params. DEFAULT_PARAMS are hand-tuned to produce demoable behavior
  // on short windows; calibrated params from monthly H100 medians are also
  // computed and surfaced via aegis_get_price_params so a buyer can compare.
  // Why not just use calibrated? Monthly medians damp short-term spikes —
  // they under-state vol and jump intensity on 30-day windows. The hand-tuned
  // defaults are still derived from observing the same data series; they are
  // a "stressed" version that produces honest tail premiums. Both sets are
  // labeled in the API response (calibration:bundled vs the active set).
  const priceParams = DEFAULT_PARAMS;

  const priceFeed = createSimFeed({
    R0: cfg.DEFAULT_R0_USD_HR,
    horizonDays: 365,
    tickMs: opts.feedTickMs ?? 2_000,
    params: priceParams,
    onTick: opts.onTick,
  });

  const hbarUsdPrice = opts.hbarUsdPrice ?? 0.05;
  const underwriterAccountId = cfg.UNDERWRITER_ACCOUNT_ID ?? cfg.BUYER_ACCOUNT_ID;

  const plugin = createAegisPlugin({
    mirror,
    topicId: cfg.AEGIS_TOPIC_ID,
    underwriterAccountId,
    exposure,
    priceFeed,
    hbarUsdPrice,
    params: priceParams,
    paths: 5000,
    onSubmit: opts.onSubmit,
  });

  const underwriter = createUnderwriter({
    client: underwriterClient ?? buyerClient,
    underwriterAccountId,
    plugin,
    payoutAutonomousCapHbar: cfg.PAYOUT_AUTONOMOUS_CAP_HBAR,
    topicId: cfg.AEGIS_TOPIC_ID,
  });

  const buyer = createBuyer({
    client: buyerClient,
    buyerAccountId: cfg.BUYER_ACCOUNT_ID,
    underwriter,
  });

  const provider = providerClient
    ? createProvider({ client: providerClient, providerAccountId: cfg.PROVIDER_ACCOUNT_ID, plugin })
    : null;

  function close() {
    priceFeed.stop();
    buyerClient.close();
    underwriterClient?.close();
    providerClient?.close();
  }

  return {
    cfg,
    mirror,
    exposure,
    priceFeed,
    plugin,
    underwriter,
    buyer,
    provider,
    buyerAccountId: cfg.BUYER_ACCOUNT_ID,
    underwriterAccountId,
    providerAccountId: cfg.PROVIDER_ACCOUNT_ID ?? null,
    underwriterIsBuyer: !haveDedicatedUnderwriter,
    hbarUsdPrice,
    priceParams,
    onSubmit: opts.onSubmit,
    close,
  };
}
