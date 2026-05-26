import { Client, PrivateKey, AccountId } from '@hashgraph/sdk';
import { loadConfig } from './config.js';
import { buildClient } from './hedera/client.js';
import { createMirrorClient } from './hedera/mirror.js';
import { createSentinelPlugin } from './plugin/index.js';
import { createSeller } from './agents/seller.js';
import { createBuyer } from './agents/buyer.js';
import { buildChatModel } from './llm.js';
import { createLlmBuyer } from './agents/llm-buyer.js';

/**
 * Wire up the whole Sentinel system from .env. Constructs the buyer client,
 * the seller client (which may be the same account in single-account demo mode),
 * the mirror REST client, the Sentinel plugin, and the buyer/seller agents.
 *
 * Returns refs that the server holds for the duration of its lifetime.
 *
 * @param {object} [opts]
 * @param {(env: import('./hedera/envelope.js').EnvelopeT) => void} [opts.onSubmit]
 *        Fired whenever any party submits an envelope (for live UI updates).
 */
export function bootstrapSentinel(opts = {}) {
  const cfg = loadConfig();
  if (!cfg.SENTINEL_TOPIC_ID) {
    throw new Error(
      'SENTINEL_TOPIC_ID is not set. Run `npm run smoke:hcs` first; it will create a topic and print the id to paste into .env.',
    );
  }

  const buyerClient = buildClient({
    network: cfg.HEDERA_NETWORK,
    accountId: cfg.BUYER_ACCOUNT_ID,
    privateKey: cfg.BUYER_PRIVATE_KEY,
  });

  const haveDedicatedSeller =
    cfg.SELLER_ACCOUNT_ID &&
    cfg.SELLER_PRIVATE_KEY &&
    cfg.SELLER_ACCOUNT_ID !== cfg.BUYER_ACCOUNT_ID;

  const sellerClient = haveDedicatedSeller
    ? buildClient({
        network: cfg.HEDERA_NETWORK,
        accountId: /** @type {string} */ (cfg.SELLER_ACCOUNT_ID),
        privateKey: /** @type {string} */ (cfg.SELLER_PRIVATE_KEY),
      })
    : null;

  const mirror = createMirrorClient({ baseUrl: cfg.MIRROR_NODE_URL });

  /** @type {import('./plugin/types.js').PolicyConfig} */
  const policy = {
    autonomousCapHbar: cfg.DEFAULT_AUTONOMOUS_CAP_HBAR,
    dailyLimitHbar: cfg.DEFAULT_DAILY_LIMIT_HBAR,
    velocityWindowSeconds: cfg.DEFAULT_VELOCITY_WINDOW_SECONDS,
    velocityMaxTxns: cfg.DEFAULT_VELOCITY_MAX_TXNS,
    serviceAllowlist: ['funding-round-lookup'],
  };

  const plugin = createSentinelPlugin({
    mirror,
    topicId: cfg.SENTINEL_TOPIC_ID,
    policy,
    onSubmit: opts.onSubmit,
  });

  const sellerAccountId = cfg.SELLER_ACCOUNT_ID ?? cfg.BUYER_ACCOUNT_ID;
  const seller = createSeller({
    client: sellerClient ?? buyerClient,
    mirror,
    accountId: sellerAccountId,
    topicId: cfg.SENTINEL_TOPIC_ID,
    onSubmit: opts.onSubmit,
  });

  const buyer = createBuyer({
    client: buyerClient,
    mirror,
    accountId: cfg.BUYER_ACCOUNT_ID,
    topicId: cfg.SENTINEL_TOPIC_ID,
    policy,
    seller,
    onSubmit: opts.onSubmit,
  });

  // The LLM-driven buyer is lazy: only constructed on first /api/agent call,
  // so the server boots without an LLM key (the deterministic flow doesn't
  // need one). buildChatModel throws a readable error if the key is missing.
  let llmBuyer = null;
  function getLlmBuyer() {
    if (llmBuyer) return llmBuyer;
    const chatModel = buildChatModel(cfg);
    llmBuyer = createLlmBuyer({
      chatModel,
      buyer,
      mirror,
      topicId: cfg.SENTINEL_TOPIC_ID,
    });
    return llmBuyer;
  }

  function close() {
    buyerClient.close();
    sellerClient?.close();
  }

  return {
    cfg,
    policy,
    mirror,
    plugin,
    buyer,
    seller,
    buyerClient,
    sellerClient: sellerClient ?? buyerClient,
    sellerAccountId,
    sellerIsBuyer: !haveDedicatedSeller,
    getLlmBuyer,
    close,
  };
}
