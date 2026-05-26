import { loadConfig } from './config.js';
import { buildClient } from './hedera/client.js';
import { createMirrorClient } from './hedera/mirror.js';

/**
 * Wire up Aegis. Constructs the buyer client (cap-purchasing agent), the
 * underwriter client (Aegis pool that collects premiums and pays out), an
 * optional provider client (mock supply-side hook), the mirror REST client,
 * and the policy plugin once it's added in A2e.
 *
 * Until the Aegis plugin / agents land in subsequent commits, this exports
 * just the clients + mirror so the server boots and the smoke tests run.
 *
 * @param {object} [opts]
 * @param {(env: any) => void} [opts.onSubmit]   live UI broadcast hook
 */
export function bootstrapAegis(opts = {}) {
  const cfg = loadConfig();

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

  const underwriterAccountId = cfg.UNDERWRITER_ACCOUNT_ID ?? cfg.BUYER_ACCOUNT_ID;

  function close() {
    buyerClient.close();
    underwriterClient?.close();
    providerClient?.close();
  }

  return {
    cfg,
    mirror,
    buyerClient,
    underwriterClient: underwriterClient ?? buyerClient,
    providerClient,
    buyerAccountId: cfg.BUYER_ACCOUNT_ID,
    underwriterAccountId,
    providerAccountId: cfg.PROVIDER_ACCOUNT_ID ?? null,
    underwriterIsBuyer: !haveDedicatedUnderwriter,
    onSubmit: opts.onSubmit,
    close,
  };
}
