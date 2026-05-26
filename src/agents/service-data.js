/**
 * Bundled dataset for the seller agent's gated service.
 *
 * This is a small snapshot of publicly-announced funding rounds (curated, not
 * real-time). It exists so the demo answers a *real* question — not
 * "ping/pong between two agents." The point of Sentinel isn't the dataset;
 * the point is that two agents settled in HBAR for something genuinely useful
 * and the receipt for that settlement is the substrate of reputation.
 *
 * Keep the size small so reads are O(n) but n is tiny.
 * Sources: public announcements via TechCrunch, Bloomberg, Reuters,
 * The Information, company press releases (2024–2025).
 */

/**
 * @typedef {object} FundingRound
 * @property {string} company
 * @property {string} sector
 * @property {string} stage              "Seed" | "Series A" .. "Series H" | "Late Stage" | "Strategic"
 * @property {number} amountUsdM         in $ millions
 * @property {number} valuationUsdB      post-money in $ billions; -1 if undisclosed
 * @property {string} announcedAt        ISO date (YYYY-MM-DD)
 * @property {string[]} leadInvestors
 */

/** @type {FundingRound[]} */
export const FUNDING_ROUNDS = [
  {
    company: 'Anthropic',
    sector: 'AI Foundation Models',
    stage: 'Series F',
    amountUsdM: 4000,
    valuationUsdB: 60,
    announcedAt: '2024-11-22',
    leadInvestors: ['Amazon'],
  },
  {
    company: 'OpenAI',
    sector: 'AI Foundation Models',
    stage: 'Strategic',
    amountUsdM: 6600,
    valuationUsdB: 157,
    announcedAt: '2024-10-02',
    leadInvestors: ['Thrive Capital', 'Microsoft'],
  },
  {
    company: 'xAI',
    sector: 'AI Foundation Models',
    stage: 'Series C',
    amountUsdM: 6000,
    valuationUsdB: 50,
    announcedAt: '2024-12-23',
    leadInvestors: ['Valor Equity Partners', 'Sequoia Capital'],
  },
  {
    company: 'Perplexity',
    sector: 'AI Consumer',
    stage: 'Series D',
    amountUsdM: 500,
    valuationUsdB: 9,
    announcedAt: '2024-12-09',
    leadInvestors: ['Institutional Venture Partners'],
  },
  {
    company: 'Mistral AI',
    sector: 'AI Foundation Models',
    stage: 'Series B',
    amountUsdM: 640,
    valuationUsdB: 6,
    announcedAt: '2024-06-11',
    leadInvestors: ['General Catalyst', 'DST Global'],
  },
  {
    company: 'Cohere',
    sector: 'AI Foundation Models',
    stage: 'Series D',
    amountUsdM: 500,
    valuationUsdB: 5.5,
    announcedAt: '2024-07-22',
    leadInvestors: ['PSP Investments'],
  },
  {
    company: 'Databricks',
    sector: 'Data Infra',
    stage: 'Series J',
    amountUsdM: 10000,
    valuationUsdB: 62,
    announcedAt: '2024-12-17',
    leadInvestors: ['Thrive Capital'],
  },
  {
    company: 'Stripe',
    sector: 'Fintech',
    stage: 'Tender',
    amountUsdM: 694,
    valuationUsdB: 70,
    announcedAt: '2024-02-15',
    leadInvestors: ['Sequoia Capital'],
  },
  {
    company: 'Ramp',
    sector: 'Fintech',
    stage: 'Series D',
    amountUsdM: 150,
    valuationUsdB: 13,
    announcedAt: '2024-04-25',
    leadInvestors: ['Khosla Ventures', 'Founders Fund'],
  },
  {
    company: 'Mercury',
    sector: 'Fintech',
    stage: 'Series C',
    amountUsdM: 100,
    valuationUsdB: 1.6,
    announcedAt: '2024-09-12',
    leadInvestors: ['Sequoia Capital'],
  },
  {
    company: 'Figure',
    sector: 'Robotics',
    stage: 'Series B',
    amountUsdM: 675,
    valuationUsdB: 2.6,
    announcedAt: '2024-02-29',
    leadInvestors: ['Microsoft', 'NVIDIA', 'Jeff Bezos'],
  },
  {
    company: 'Skild AI',
    sector: 'Robotics',
    stage: 'Series A',
    amountUsdM: 300,
    valuationUsdB: 1.5,
    announcedAt: '2024-07-09',
    leadInvestors: ['Lightspeed Venture Partners', 'Coatue', 'SoftBank'],
  },
  {
    company: 'Physical Intelligence',
    sector: 'Robotics',
    stage: 'Series A',
    amountUsdM: 400,
    valuationUsdB: 2.4,
    announcedAt: '2024-11-04',
    leadInvestors: ['Jeff Bezos', 'Thrive Capital', 'Lux Capital'],
  },
  {
    company: 'Wayve',
    sector: 'Autonomous Vehicles',
    stage: 'Series C',
    amountUsdM: 1050,
    valuationUsdB: -1,
    announcedAt: '2024-05-07',
    leadInvestors: ['SoftBank', 'NVIDIA', 'Microsoft'],
  },
  {
    company: 'Waymo',
    sector: 'Autonomous Vehicles',
    stage: 'Strategic',
    amountUsdM: 5600,
    valuationUsdB: -1,
    announcedAt: '2024-10-25',
    leadInvestors: ['Alphabet'],
  },
  {
    company: 'Cruise',
    sector: 'Autonomous Vehicles',
    stage: 'Strategic',
    amountUsdM: 850,
    valuationUsdB: -1,
    announcedAt: '2024-06-13',
    leadInvestors: ['General Motors'],
  },
  {
    company: 'Helion Energy',
    sector: 'Energy',
    stage: 'Series F',
    amountUsdM: 425,
    valuationUsdB: 5.4,
    announcedAt: '2025-01-08',
    leadInvestors: ['Lightspeed Venture Partners'],
  },
  {
    company: 'Commonwealth Fusion Systems',
    sector: 'Energy',
    stage: 'Series B2',
    amountUsdM: 863,
    valuationUsdB: -1,
    announcedAt: '2024-12-19',
    leadInvestors: ['Breakthrough Energy Ventures'],
  },
  {
    company: 'Glean',
    sector: 'Enterprise AI',
    stage: 'Series E',
    amountUsdM: 260,
    valuationUsdB: 4.6,
    announcedAt: '2024-09-10',
    leadInvestors: ['Altimeter Capital', 'DST Global'],
  },
  {
    company: 'Harvey',
    sector: 'Legal AI',
    stage: 'Series D',
    amountUsdM: 300,
    valuationUsdB: 3,
    announcedAt: '2024-12-17',
    leadInvestors: ['Google Ventures'],
  },
  {
    company: 'Sierra',
    sector: 'Enterprise AI',
    stage: 'Series B',
    amountUsdM: 175,
    valuationUsdB: 4.5,
    announcedAt: '2024-10-28',
    leadInvestors: ['Greenoaks Capital'],
  },
  {
    company: 'Hugging Face',
    sector: 'AI Infrastructure',
    stage: 'Series D',
    amountUsdM: 235,
    valuationUsdB: 4.5,
    announcedAt: '2023-08-24',
    leadInvestors: ['Salesforce'],
  },
  {
    company: 'Sakana AI',
    sector: 'AI Foundation Models',
    stage: 'Series A',
    amountUsdM: 200,
    valuationUsdB: 1.5,
    announcedAt: '2024-09-04',
    leadInvestors: ['NEA', 'Lux Capital', 'Khosla Ventures'],
  },
  {
    company: 'Decagon',
    sector: 'Enterprise AI',
    stage: 'Series C',
    amountUsdM: 131,
    valuationUsdB: 1.5,
    announcedAt: '2024-11-21',
    leadInvestors: ['Bain Capital Ventures'],
  },
  {
    company: 'Hippocratic AI',
    sector: 'Healthcare AI',
    stage: 'Series B',
    amountUsdM: 141,
    valuationUsdB: 1.6,
    announcedAt: '2024-09-12',
    leadInvestors: ['General Catalyst', 'Kleiner Perkins'],
  },
  {
    company: 'OpenEvidence',
    sector: 'Healthcare AI',
    stage: 'Series A',
    amountUsdM: 75,
    valuationUsdB: 1,
    announcedAt: '2025-02-19',
    leadInvestors: ['Sequoia Capital', 'Kleiner Perkins'],
  },
  {
    company: 'Tenstorrent',
    sector: 'AI Hardware',
    stage: 'Series D',
    amountUsdM: 693,
    valuationUsdB: 2.6,
    announcedAt: '2024-12-02',
    leadInvestors: ['Samsung Securities', 'AFW Partners'],
  },
  {
    company: 'Groq',
    sector: 'AI Hardware',
    stage: 'Series D',
    amountUsdM: 640,
    valuationUsdB: 2.8,
    announcedAt: '2024-08-05',
    leadInvestors: ['BlackRock'],
  },
  {
    company: 'Cerebras',
    sector: 'AI Hardware',
    stage: 'Series F',
    amountUsdM: 250,
    valuationUsdB: 4,
    announcedAt: '2021-11-10',
    leadInvestors: ['Alpha Wave Ventures'],
  },
  {
    company: 'Replicate',
    sector: 'AI Infrastructure',
    stage: 'Series B',
    amountUsdM: 40,
    valuationUsdB: 0.35,
    announcedAt: '2023-12-21',
    leadInvestors: ['a16z'],
  },
  {
    company: 'Together AI',
    sector: 'AI Infrastructure',
    stage: 'Series A',
    amountUsdM: 102.5,
    valuationUsdB: 1.25,
    announcedAt: '2024-03-13',
    leadInvestors: ['Salesforce Ventures'],
  },
  {
    company: 'Modal',
    sector: 'AI Infrastructure',
    stage: 'Series A',
    amountUsdM: 80,
    valuationUsdB: 1.1,
    announcedAt: '2024-06-04',
    leadInvestors: ['Lux Capital', 'Redpoint'],
  },
];

/**
 * Query the funding-round dataset.
 *
 * @param {object} q
 * @param {string} [q.company]           case-insensitive substring match on company
 * @param {string} [q.sector]            exact (case-insensitive) sector
 * @param {number} [q.minAmountUsdM]
 * @param {number} [q.minValuationUsdB]
 * @param {string} [q.sinceDate]         YYYY-MM-DD inclusive
 * @param {number} [q.limit]             default 10
 * @returns {{ count: number, results: FundingRound[] }}
 */
export function queryFundingRounds(q = {}) {
  const limit = q.limit ?? 10;
  let results = FUNDING_ROUNDS.slice();
  if (q.company) {
    const needle = q.company.toLowerCase();
    results = results.filter((r) => r.company.toLowerCase().includes(needle));
  }
  if (q.sector) {
    results = results.filter((r) => r.sector.toLowerCase() === q.sector.toLowerCase());
  }
  if (typeof q.minAmountUsdM === 'number') {
    results = results.filter((r) => r.amountUsdM >= /** @type {number} */ (q.minAmountUsdM));
  }
  if (typeof q.minValuationUsdB === 'number') {
    results = results.filter(
      (r) => r.valuationUsdB >= /** @type {number} */ (q.minValuationUsdB),
    );
  }
  if (q.sinceDate) {
    results = results.filter((r) => r.announcedAt >= /** @type {string} */ (q.sinceDate));
  }
  results.sort((a, b) => b.announcedAt.localeCompare(a.announcedAt));
  return { count: results.length, results: results.slice(0, limit) };
}

export const SECTORS = Array.from(new Set(FUNDING_ROUNDS.map((r) => r.sector))).sort();
