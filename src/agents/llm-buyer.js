/**
 * Natural-language buyer agent.
 *
 * A ReAct agent built with `createAgent` from langchain v1, given two custom
 * tools (lookup-counterparty-reputation and buy-funding-round-data) plus the
 * kit's tools (loaded via Sentinel's HederaLangchainToolkit). Operator says
 * something like "what AI hardware startups raised over $500M last year, and
 * which are still independent?" and the agent:
 *
 *   1. Optionally consults sentinel_get_counterparty_reputation to check
 *      the seller's track record.
 *   2. Calls buy_funding_round_data with a structured query distilled from
 *      the natural-language request. That tool routes through the same
 *      Sentinel policy plugin, so ALLOW/DENY/ESCALATE is enforced.
 *   3. Summarizes the returned data in plain English.
 *
 * This is the AI-Studio-rubric showcase: the kit's tools, the Sentinel
 * plugin's tools, and a real LangGraph agent all in one closed loop.
 */
import { tool, createAgent } from 'langchain';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';

const QueryShape = z.object({
  company: z.string().min(1).optional().describe('case-insensitive substring match on company name'),
  sector: z
    .string()
    .min(1)
    .optional()
    .describe('exact sector match — e.g. "AI Foundation Models", "AI Hardware", "Fintech", "Energy"'),
  minAmountUsdM: z.number().nonnegative().optional().describe('minimum round size in USD millions'),
  minValuationUsdB: z.number().nonnegative().optional().describe('minimum post-money valuation in USD billions'),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('YYYY-MM-DD, inclusive'),
  limit: z.number().int().min(1).max(50).default(10).describe('max rows to return (1-50)'),
});

/**
 * @param {object} deps
 * @param {ReturnType<typeof import('@langchain/core/language_models/chat_models').BaseChatModel> | import('@langchain/core/language_models/chat_models').BaseChatModel} deps.chatModel
 * @param {ReturnType<typeof import('./buyer.js').createBuyer>} deps.buyer
 * @param {import('../hedera/mirror.js').MirrorClient} deps.mirror
 * @param {string} deps.topicId
 */
export function createLlmBuyer({ chatModel, buyer, mirror, topicId }) {
  const getReputationTool = tool(
    async ({ counterparty, scope }) => {
      const { buildReputationProfile } = await import('../plugin/reputation.js');
      const profile = await buildReputationProfile({
        mirror,
        topicId,
        counterparty,
        viewer: scope === 'global' ? undefined : buyer.accountId,
      });
      return JSON.stringify({
        counterparty: profile.counterparty,
        score: profile.score,
        verifiedSettlementCount: profile.verifiedSettlementCount,
        totalSettlementClaims: profile.totalSettlementClaims,
        verifiedVolumeHbar: profile.verifiedVolumeHbar,
        denialCount: profile.denialCount,
        claimToVerifiedRatio: Number(profile.claimToVerifiedRatio.toFixed(3)),
        distinctCounterpartyCount: profile.distinctCounterpartyCount,
        scope: scope ?? 'buyer',
      });
    },
    {
      name: 'sentinel_get_counterparty_reputation',
      description:
        'Look up the verified-history reputation of a Hedera account. Returns score (0-100), verified settlement counts, denial counts, and the claim-to-verified ratio. Use this BEFORE deciding to buy data from a counterparty you do not know.',
      schema: z.object({
        counterparty: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .describe('Hedera account id of the counterparty, e.g. 0.0.9063279'),
        scope: z
          .enum(['buyer', 'global'])
          .optional()
          .describe('"buyer" (default) = restrict to envelopes involving this buyer. "global" = network-wide view.'),
      }),
    },
  );

  const buyDataTool = tool(
    async ({ query }) => {
      const outcome = await buyer.request({ query });
      // The agent loop reads this string — keep it both human-readable and
      // structured-enough to parse if it wants.
      return JSON.stringify({
        kind: outcome.kind,
        requestId: outcome.requestId,
        decision: outcome.decision.decision,
        ruleId: outcome.decision.ruleId,
        reason: outcome.decision.reason,
        reputation: {
          score: outcome.decision.reputation.score,
          verified: outcome.decision.reputation.verifiedSettlementCount,
          total: outcome.decision.reputation.totalSettlementClaims,
        },
        ...(outcome.kind === 'ALLOWED'
          ? { txId: outcome.txId, data: outcome.data }
          : outcome.kind === 'ESCALATED'
            ? { hint: 'Above-cap spend. The user must approve via the UI; the LLM agent should report this back to the human and stop.' }
            : { hint: 'Policy DENIED the payment. Report the rule and reason to the human; do not retry.' }),
      });
    },
    {
      name: 'buy_funding_round_data',
      description:
        'Purchase a funding-round / market-data lookup from the seller. The seller charges 0.5 HBAR per query. This tool routes the payment through the Sentinel policy plugin, so the answer may be ALLOWED (data returned), ESCALATED (above-cap; human approval pending in the UI — report this and stop), or DENIED (policy refused; report the rule and stop). Build a structured query from the user\'s natural-language request: filters are company substring, exact sector, minimum amount in USD millions, minimum valuation in USD billions, ISO date, and a row limit.',
      schema: z.object({
        query: QueryShape,
      }),
    },
  );

  const systemPrompt =
    'You are the buyer-side AI for Sentinel — an underwriting rail for agent-to-agent payments on Hedera. ' +
    `Your buyer account is ${buyer.accountId}. The default seller is on testnet; payments are real HBAR but on the testnet, no real money. ` +
    'When the user asks a market-data / funding-round question, you should: ' +
    '(1) optionally call sentinel_get_counterparty_reputation if the user expresses concern about the seller or if you have not bought from them recently; ' +
    '(2) distill the natural-language ask into the structured query schema (company, sector, minAmountUsdM, minValuationUsdB, sinceDate, limit); ' +
    '(3) call buy_funding_round_data exactly once; ' +
    '(4) summarize the returned data in plain English. ' +
    'If the tool returns ESCALATED, tell the user the request needs approval in the Sentinel UI and STOP — do not retry. ' +
    'If the tool returns DENIED, report the rule that fired and STOP. ' +
    'Never call buy_funding_round_data more than once per user message. ' +
    'Available sectors: AI Foundation Models, AI Hardware, AI Infrastructure, AI Consumer, Enterprise AI, Healthcare AI, Legal AI, Robotics, Autonomous Vehicles, Data Infra, Fintech, Energy.';

  const agent = createAgent({
    model: chatModel,
    tools: [getReputationTool, buyDataTool],
    systemPrompt,
  });

  /**
   * Run one turn. Returns the agent's final natural-language answer plus the
   * list of tool calls so the UI can render the reasoning trace.
   *
   * @param {string} userMessage
   */
  async function ask(userMessage) {
    const result = await agent.invoke({
      messages: [new HumanMessage(userMessage)],
    });
    const messages = result?.messages ?? [];
    const toolCalls = [];
    for (const m of messages) {
      if (m._getType?.() === 'ai' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          toolCalls.push({ name: tc.name, args: tc.args });
        }
      }
      if (m._getType?.() === 'tool') {
        // Attach the tool result to the most recent matching call.
        const last = toolCalls[toolCalls.length - 1];
        if (last) {
          try { last.result = JSON.parse(String(m.content)); }
          catch { last.result = String(m.content); }
        }
      }
    }
    const last = messages[messages.length - 1];
    const answer = typeof last?.content === 'string'
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
        : '';
    return { answer, toolCalls };
  }

  return { ask, agent };
}
