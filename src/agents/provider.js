/**
 * Mock supply-side provider.
 *
 * Posts PROVIDER_CAPACITY envelopes to the Aegis HCS topic advertising H100
 * capacity at an ask price. The underwriter could (in the in-kind roadmap)
 * reserve this capacity to back a cap; in the demo the provider is purely
 * a visible signal — "supply exists; the surface is wired."
 *
 * Production would source capacity from Akash / io.net / Render / Aethir
 * (their APIs already exist; thin integration is a stretch goal in SPEC §11).
 * Building a DePIN network is explicitly out of scope; this is a hook.
 *
 * @param {object} deps
 * @param {import('@hashgraph/sdk').Client} deps.client
 * @param {string} deps.providerAccountId
 * @param {import('hedera-agent-kit').Plugin} deps.plugin
 */
export function createProvider({ client, providerAccountId, plugin }) {
  // Use the plugin directly — provider doesn't need a chat model; it only
  // needs the aegis_post_provider_capacity tool. The plugin's tools(ctx)
  // returns a kit Tool[]; we call execute() directly.
  const tools = plugin.tools({ accountId: providerAccountId });
  const postCapacityTool = tools.find((t) => t.method === 'aegis_post_provider_capacity');
  if (!postCapacityTool) throw new Error('aegis_post_provider_capacity tool missing from plugin');

  /**
   * Post one capacity announcement.
   *
   * @param {object} args
   * @param {number} args.qtyGpuHr
   * @param {number} args.askUsdHr
   * @param {string} [args.availableUntilTs]
   */
  async function postCapacity({ qtyGpuHr, askUsdHr, availableUntilTs }) {
    return postCapacityTool.execute(client, { accountId: providerAccountId }, {
      provider: providerAccountId,
      qtyGpuHr,
      askUsdHr,
      ...(availableUntilTs ? { availableUntilTs } : {}),
    });
  }

  return { postCapacity, accountId: providerAccountId };
}
