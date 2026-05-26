import { z } from 'zod';
import 'dotenv/config';

// Treat "" and whitespace-only env values as unset. Many shells / hosting UIs
// surface optional fields as empty strings rather than absent keys.
const blankToUndef = (v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  return t === '' ? undefined : t;
};

const accountIdSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'must look like 0.0.xxxxxx');
const privateKeyHexSchema = z
  .string()
  .min(64, 'private key looks too short; paste the raw ECDSA key from portal.hedera.com');

const HederaAccountId = z.preprocess(blankToUndef, accountIdSchema);
const HederaAccountIdOptional = z.preprocess(blankToUndef, accountIdSchema.optional());
const PrivateKeyHex = z.preprocess(blankToUndef, privateKeyHexSchema);
const PrivateKeyHexOptional = z.preprocess(blankToUndef, privateKeyHexSchema.optional());
const OptionalString = z.preprocess(blankToUndef, z.string().optional());

const Network = z.enum(['testnet', 'previewnet', 'mainnet']);

const Schema = z
  .object({
    BUYER_ACCOUNT_ID: HederaAccountId,
    BUYER_PRIVATE_KEY: PrivateKeyHex,

    SELLER_ACCOUNT_ID: HederaAccountIdOptional,
    SELLER_PRIVATE_KEY: PrivateKeyHexOptional,

    HEDERA_NETWORK: Network.default('testnet'),
    MIRROR_NODE_URL: z
      .string()
      .url()
      .default('https://testnet.mirrornode.hedera.com'),

    SENTINEL_TOPIC_ID: HederaAccountIdOptional,

    LLM_PROVIDER: z.enum(['groq', 'openai']).default('groq'),
    GROQ_API_KEY: OptionalString,
    GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
    OPENAI_API_KEY: OptionalString,
    OPENAI_MODEL: z.string().default('gpt-4o-mini'),

    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

    DEFAULT_AUTONOMOUS_CAP_HBAR: z.coerce.number().positive().default(2),
    DEFAULT_DAILY_LIMIT_HBAR: z.coerce.number().positive().default(20),
    DEFAULT_VELOCITY_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
    DEFAULT_VELOCITY_MAX_TXNS: z.coerce.number().int().positive().default(5),
  })
  .superRefine((env, ctx) => {
    if (env.HEDERA_NETWORK === 'mainnet') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Sentinel refuses to run on mainnet. Use testnet — agent safety requires human-in-the-loop for real funds.',
        path: ['HEDERA_NETWORK'],
      });
    }
    // LLM key validation is lazy — checked in src/llm.js when buildChatModel
    // is actually called. The buyer/seller flow is deterministic and doesn't
    // need an LLM, so smoke tests and the demo run fine without one.
  });

let cached;

export function loadConfig() {
  if (cached) return cached;
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    const msg = ['Invalid environment configuration:', ...lines, '', 'Did you copy .env.example to .env and fill it in?'].join('\n');
    throw new Error(msg);
  }
  cached = Object.freeze(parsed.data);
  return cached;
}

export function resetConfigForTests() {
  cached = undefined;
}
