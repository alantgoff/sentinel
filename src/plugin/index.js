import { buildTools } from './tools.js';
export { TOOL_NAMES } from './tools.js';

/**
 * Aegis kit plugin factory. Conforms to the `hedera-agent-kit` Plugin contract:
 *
 *   interface Plugin {
 *     name: string;
 *     version?: string;
 *     description?: string;
 *     tools: (context: Context) => Tool[];
 *   }
 *
 * Pass into HederaLangchainToolkit or HederaMCPToolkit:
 *
 *   const plugin = createAegisPlugin({ mirror, topicId, ... });
 *   const toolkit = new HederaLangchainToolkit({
 *     client, configuration: {
 *       plugins: [plugin],
 *       context: { accountId: underwriterAccountId, mode: AgentMode.AUTONOMOUS },
 *     },
 *   });
 *
 * @param {object} deps
 * @param {import('../hedera/mirror.js').MirrorClient} deps.mirror
 * @param {string} deps.topicId
 * @param {string} deps.underwriterAccountId
 * @param {ReturnType<typeof import('../pool/exposure.js').createExposureBook>} deps.exposure
 * @param {{ getRT: () => number, getSource: () => string }} deps.priceFeed
 * @param {number} deps.hbarUsdPrice
 * @param {import('../pricing/price-model.js').PriceModelParams} [deps.params]
 * @param {number} [deps.paths]
 * @param {(env: import('../hedera/envelope.js').EnvelopeT) => void} [deps.onSubmit]
 * @returns {import('hedera-agent-kit').Plugin}
 */
export function createAegisPlugin(deps) {
  if (!deps.mirror) throw new Error('createAegisPlugin requires a mirror client');
  if (!deps.topicId) throw new Error('createAegisPlugin requires a topicId');
  if (!deps.underwriterAccountId) throw new Error('createAegisPlugin requires an underwriterAccountId');
  if (!deps.exposure) throw new Error('createAegisPlugin requires an exposure book');
  if (!deps.priceFeed) throw new Error('createAegisPlugin requires a priceFeed');
  if (!(deps.hbarUsdPrice > 0)) throw new Error('createAegisPlugin requires a positive hbarUsdPrice');

  const tools = buildTools(deps);

  return {
    name: 'aegis-underwriter',
    version: '0.2.0',
    description:
      'Aegis: autonomous underwriter for cost-cap options on H100 GPU-hour rentals. Quotes premiums via Monte Carlo over a jump-diffusion price model; issues policies after on-chain premium verification and an aggregate-exposure check; settles in HBAR (with kit RETURN_BYTES human approval on large payouts). Every record on HCS; every transfer mirror-node-verified.',
    tools: (_context) => tools,
  };
}
