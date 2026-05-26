import { ChatOpenAI } from '@langchain/openai';
import { ChatGroq } from '@langchain/groq';

/**
 * Build the LangChain chat model used by the buyer/seller agents.
 *
 * @param {ReturnType<typeof import('./config.js').loadConfig>} cfg
 */
export function buildChatModel(cfg) {
  switch (cfg.LLM_PROVIDER) {
    case 'groq':
      if (!cfg.GROQ_API_KEY) throw new Error('LLM_PROVIDER=groq but GROQ_API_KEY is not set');
      return new ChatGroq({
        apiKey: cfg.GROQ_API_KEY,
        model: cfg.GROQ_MODEL,
        temperature: 0,
      });
    case 'openai':
      if (!cfg.OPENAI_API_KEY) throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is not set');
      return new ChatOpenAI({
        apiKey: cfg.OPENAI_API_KEY,
        model: cfg.OPENAI_MODEL,
        temperature: 0,
      });
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${cfg.LLM_PROVIDER}`);
  }
}
