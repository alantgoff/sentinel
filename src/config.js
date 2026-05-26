import { z } from 'zod';
import 'dotenv/config';

const HederaAccountId = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must look like 0.0.xxxxxx');

const PrivateKeyHex = z
  .string()
  .min(64, 'private key looks too short; paste the raw ECDSA key from portal.hedera.com');

const Network = z.enum(['testnet', 'previewnet', 'mainnet']);

const Schema = z
  .object({
    BUYER_ACCOUNT_ID: HederaAccountId,
    BUYER_PRIVATE_KEY: PrivateKeyHex,

    SELLER_ACCOUNT_ID: HederaAccountId.optional(),
    SELLER_PRIVATE_KEY: PrivateKeyHex.optional(),

    HEDERA_NETWORK: Network.default('testnet'),
    MIRROR_NODE_URL: z
      .string()
      .url()
      .default('https://testnet.mirrornode.hedera.com'),

    SENTINEL_TOPIC_ID: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/, 'must look like 0.0.xxxxxx')
      .optional(),

    LLM_PROVIDER: z.enum(['groq', 'openai']).default('groq'),
    GROQ_API_KEY: z.string().optional(),
    GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
    OPENAI_API_KEY: z.string().optional(),
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
    if (env.LLM_PROVIDER === 'groq' && !env.GROQ_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LLM_PROVIDER=groq but GROQ_API_KEY is not set.',
        path: ['GROQ_API_KEY'],
      });
    }
    if (env.LLM_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LLM_PROVIDER=openai but OPENAI_API_KEY is not set.',
        path: ['OPENAI_API_KEY'],
      });
    }
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
