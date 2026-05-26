import { buildTools } from './tools.js';
export { TOOL_NAMES } from './tools.js';

/**
 * Factory for the Sentinel policy plugin — conforms to the
 * `hedera-agent-kit` Plugin contract:
 *
 *   interface Plugin {
 *     name: string;
 *     version?: string;
 *     description?: string;
 *     tools: (context: Context) => Tool[];
 *   }
 *
 * Pass it to `HederaLangchainToolkit` or `HederaMCPToolkit` like:
 *
 *   const plugin = createSentinelPlugin({ mirror, topicId, policy });
 *   const toolkit = new HederaLangchainToolkit({
 *     client,
 *     configuration: { plugins: [plugin], context: { mode: AgentMode.AUTONOMOUS } },
 *   });
 *
 * @param {object} deps
 * @param {import('../hedera/mirror.js').MirrorClient} deps.mirror
 * @param {string} deps.topicId
 * @param {import('./types.js').PolicyConfig} deps.policy
 * @param {(env: import('../hedera/envelope.js').EnvelopeT) => void} [deps.onSubmit]
 * @returns {import('hedera-agent-kit').Plugin}
 */
export function createSentinelPlugin({ mirror, topicId, policy, onSubmit }) {
  if (!mirror) throw new Error('createSentinelPlugin requires a mirror client');
  if (!topicId) throw new Error('createSentinelPlugin requires a topicId');
  if (!policy) throw new Error('createSentinelPlugin requires a policy config');

  const tools = buildTools({ mirror, topicId, policy, onSubmit });

  return {
    name: 'sentinel-policy',
    version: '0.1.0',
    description:
      'Sentinel: counterparty-aware policy + reputation guardrails for agent-to-agent payments. Decisions are based on the verified-on-mirror-node subset of HCS settlements; the kit\'s native transfer tools are wrapped with ALLOW/DENY/ESCALATE.',
    tools: (_context) => tools,
  };
}
