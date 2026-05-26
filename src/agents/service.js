import { z } from 'zod';
import { queryFundingRounds, SECTORS } from './service-data.js';

/**
 * The gated service the seller agent vends.
 *
 * It exposes:
 *   - a price (in HBAR per query) — the buyer must settle on-chain for this
 *   - a Zod schema for the query body
 *   - a runQuery() function that executes a validated query
 */

export const SERVICE_NAME = 'funding-round-lookup';
export const PRICE_HBAR_PER_QUERY = 0.5;

export const QuerySchema = z.object({
  company: z.string().min(1).optional(),
  sector: z.string().min(1).optional(),
  minAmountUsdM: z.number().nonnegative().optional(),
  minValuationUsdB: z.number().nonnegative().optional(),
  sinceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

/**
 * Run a validated query.
 *
 * @param {z.input<typeof QuerySchema>} input
 */
export function runQuery(input) {
  const parsed = QuerySchema.parse(input);
  return queryFundingRounds(parsed);
}

export function describeService() {
  return {
    name: SERVICE_NAME,
    priceHbarPerQuery: PRICE_HBAR_PER_QUERY,
    description:
      'Per-query funding-round / market-data lookup. Filter by company name, sector, minimum amount, minimum valuation, or announcement date. Returns up to 50 results sorted by announcement date.',
    sectors: SECTORS,
    schema: {
      company: 'string, substring match (optional)',
      sector: `enum (optional): ${SECTORS.join(' | ')}`,
      minAmountUsdM: 'number ≥ 0 (optional)',
      minValuationUsdB: 'number ≥ 0 (optional)',
      sinceDate: 'YYYY-MM-DD (optional, inclusive)',
      limit: 'integer 1..50, default 10',
    },
  };
}
