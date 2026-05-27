# Aegis

**Autonomous underwriter on Hedera selling cost-cap options on H100 GPU-hour rentals.**
Pay a premium today; if the H100 rental rate spikes above your strike during the
coverage window, the agent reimburses the difference. Option, not future. Cash-settled
in HBAR; in-kind compute is roadmap.

> *budget certainty for compute — a price cap on inference, settled on Hedera.*

Submission for the **[Hedera AI Agent Bounty](https://ai-bounties.hedera.com) — Week 5:
Policy Agent ($1,500 in HBAR)**. Repo: <https://github.com/alantgoff/aegis>.

## The real-world problem

Inference is now >60% of compute cost for major AI providers, and the price is volatile
around a falling long-term trend — periodic shortages (the H100 crunch) cause real
spikes when buyers' budgets are most exposed. The institutional venues (CME + Silicon
Data, ICE + Ornn — both launched May 2026) offer **cash-settled GPU-hour futures on
proprietary indices** to institutions hedging large positions. They do not serve:

1. **App-layer / long-tail AI startups** whose pain is per-invoice inference-cost
   certainty, not GPU-rental positions.
2. **Option-style risk transfer.** In a market that trends down, an asymmetric *cap*
   costs a fraction of a symmetric *forward* and protects only the tail — exactly when
   budget certainty matters.
3. **In-kind settlement.** Cash-settled index futures leave basis risk vs. the buyer's
   actual provider invoice. Settling in real compute closes that gap.

Aegis sits in that opening: on-chain, agent-native, permissionless, option-style,
in-kind-capable. Validation: **American Express already underwrites *agent execution
error*** — the market accepts that agent-economy risk is underwritable. Aegis
underwrites *compute-cost* risk.

## The instrument (locked design)

European-style **cost-cap option**:

- **Underlying R:** H100-class GPU-hour rental rate (the only compute price actually
  volatile + optionable on demo timescales — per-token list prices are administered
  step-functions, monthly, monotonic-down).
- **Strike K**, **notional Q** (GPU-hours), **window** (e.g. 30 days), **premium P** up front.
- **Payout at expiry:** `max(0, R_observed − K) × Q`, capped at `maxPayoutHbar`.

## Algorithm summary

Every layer of Aegis is mapped to the published industry standard for the closest
analogous asset class (electricity, gas, and other volatile spot-priced commodities).
The full methods writeup with literature references is in
[`docs/ALGORITHMS.md`](docs/ALGORITHMS.md); the punch line:

| Layer | What Aegis uses | Standard |
|---|---|---|
| Price process | **Regime-switching mean-reverting jump-diffusion** (stable / squeeze) | Janczura-Weron, Cartea-Figueroa, Bégin et al. 2025 |
| MC variance reduction | **Antithetic-pair sampling with best-of-both estimator selection** — never worse than plain MC | Dean Francis Press 2025 meta-analysis |
| Risk loading | **CVaR_95-based** (coherent risk measure) — stdev mode selectable | Hardy CAS, Solvency II |
| Calibration | **Press-Ball-Torous EM** with monotonic log-likelihood guarantee | Press 1967, Ball-Torous 1983, ESAIM PS 2020 |
| Settlement | **Asian-style trailing 7-day TWAP** — manipulation-resistant | CME / ICE commodity contracts, Deribit |
| Pool exposure | **Joint-payout 99% VaR** under stressed squeeze regime | Solvency II Pillar 1 |

The pricer always exposes its decomposition (`expected_payout`, `risk_load`, `ops_load`,
`CVaR_95`, `P(ITM)`, `variance_reduction_factor`, `used_estimator`) so each quote is
auditable. Both the method-of-moments and EM calibrations on bundled H100 history are
exposed via the kit tool `aegis_get_price_params` for runtime audit.

### Sample MC quotes (R₀ = $2.50/hr, hbarUsdPrice = $0.05/HBAR, 20K paths, seed 42)

| Case | Premium | E[payout] | Risk load | Ops load | CVaR_95 | P(ITM) |
|---|---:|---:|---:|---:|---:|---:|
| ATM K=$2.50 30d Q=100 (stable) | 416.7 HBAR | 206.8 | 199.5 | 10.3 | 1536.7 | 48.3% |
| OTM K=$4 30d Q=100 (stable)   | 35.7 HBAR  | 9.2   | 26.1  | 0.5  | 183.0  | 0.3%  |
| OTM K=$6 30d Q=100 (stable)   | 10.9 HBAR  | 2.8   | 8.0   | 0.1  | 56.2   | 0.1%  |
| OTM K=$4 90d Q=100 (stable)   | 444.0 HBAR | 113.8 | 324.4 | 5.7  | 2276.8 | 2.8%  |
| OTM K=$4 30d Q=100 (squeeze)  | 1378.9 HBAR| 471.1 | 884.2 | 23.6 | 6365.7 | 17.5% |

The 38× swing between stable and squeeze regimes for the same K = $4 cap is exactly the
regime-aware signal — buying protection during a known shortage is appropriately
expensive.

## Reference feed — locked hybrid approach

No free, API-accessible, *volatile* GPU index exists (Silicon Data / Ornn = paid
Bloomberg distribution; Artificial Analysis = per-token, sticky). So:

> Calibrate the model to real historical GPU rental prices, then run the live demo on
> a **clearly-labeled simulated price path** with a manual "inject shock" control.

The envelope schema enforces this label (`source` field on `PRICE_REF` must be
`sim:labeled`, `sim:shock`, or `calibration:<id>` — no path posts an unlabeled feed
claim). **Aegis is not, and does not claim to be, a derivatives-grade index.** Full
disclosure in [`LIMITATIONS.md`](LIMITATIONS.md).

## Architecture

```
        ┌──────────────────────────────────────────────────────────┐
        │ Hosted interactive UI (qualifying requirement)            │
        │  build cap → MC premium → buy → inject shock → expiry →   │
        │  payout (RETURN_BYTES if > cap) → SETTLEMENT on HCS       │
        └───────────────┬──────────────────────────────────────────┘
                        │
   ┌────────────────────▼─────────────────────────────┐
   │ AEGIS — Underwriter agent (Agent Kit)             │
   │  • regime-switching jump-diffusion feed (labeled) │
   │  • MC pricer: antithetic variates + CVaR loading  │
   │  • pool + joint-VaR 99% exposure check            │
   │  • Asian-style 7-day TWAP settlement              │
   │  • RETURN_BYTES human-in-loop for payouts > cap   │
   └───┬───────────────┬────────────────┬──────────────┘
       │ HBAR transfers │ reads          │ writes POLICY / PRICE_REF / SETTLEMENT
       ▼                ▼                ▼
 ┌───────────┐   ┌──────────────┐  ┌────────────────────────────┐
 │ Cap buyer │   │ Mirror node  │  │ Aegis HCS topic            │
 │ (AI co.)  │   │  REST (verify│  │  - POLICY                  │
 └───────────┘   │   transfers) │  │  - PRICE_REF (labeled)     │
                 └──────────────┘  │  - SETTLEMENT              │
 ┌──────────────────────────┐      │  - PROVIDER_CAPACITY       │
 │ Provider agent(s) (mock) │─────▶│    (in-kind roadmap hook)  │
 └──────────────────────────┘      └────────────────────────────┘
```

## What's in the box

### Kit plugin — `src/plugin/`
- `tools.js` exposes 8 tools:
  `aegis_quote_policy`, `aegis_issue_policy`, `aegis_record_price_ref`,
  `aegis_settle_policy`, `aegis_post_provider_capacity`, `aegis_pool_status`,
  `aegis_list_policies`, `aegis_get_price_params`.
- `aegis_issue_policy` is the integrity-critical path: re-verifies the buyer's
  premium tx on the mirror node, runs the **joint-VaR 99% exposure check** over
  every active policy plus the proposed one (stress-regime R_T samples), refuses
  if the joint quantile exceeds `maxExposureRatio × pool balance`.
- `index.js` — `createAegisPlugin(...)` factory returning a kit-compatible `Plugin`.

### Pricing — `src/pricing/`
- `rng.js`            seeded xorshift128+ PRNG with Box-Muller normals (deterministic)
- `price-model.js`    **regime-switching** jump-diffusion: `simulatePath`,
                      `simulateAntitheticPair`, `regimeSequence`, `injectShock`,
                      `DEFAULT_PARAMS` (single-regime) + `DEFAULT_REGIME_PARAMS`
                      (two-regime stable / squeeze with Markov transitions)
- `calibration.js`    bundled 36-month H100 medians + method-of-moments estimator
- `em-calibration.js` Press-Ball-Torous **EM** with monotonic log-likelihood
                      guarantee + soft posterior P(jump) per observation
- `pricer.js`         `pricePremium` with antithetic-pair MC, CVaR-based risk
                      loading, best-of-both estimator (varianceReductionFactor,
                      usedEstimator), `maxLikelyPayoutHbar` (stress-regime
                      99.5% quantile), `sampleStressedRT` for the exposure book
- `feed.js`           `createSimFeed` — wall-clock-ticking labeled-simulated feed
                      with `recentPath(N)` for Asian-style settlement

### Pool + exposure — `src/pool/`
- `exposure.js` in-memory book: add / remove / dropExpired / list / snapshot,
                `checkIssuance` (Σ-maxPayout legacy) AND `checkIssuanceJointVaR`
                (Solvency-II-style 99% VaR over joint payout distribution)
- `pool.js`     mirror-node-backed balance reader

### Agents — `src/agents/`
- `underwriter.js`  pricing + issuance + settlement; two `HederaLangchainToolkit`
                    instances for the AUTONOMOUS / RETURN_BYTES dance on payouts
- `buyer.js`        quote → pay premium → request issuance (kit `transfer_hbar_tool`)
- `provider.js`     mock supply-side agent posting PROVIDER_CAPACITY envelopes

### Hedera I/O — `src/hedera/`
- `envelope.js`  v1 envelope schema (POLICY / PRICE_REF / SETTLEMENT /
                 PROVIDER_CAPACITY) with `superRefine` invariants
                 (PAID_OUT ↔ payoutHbar>0+payoutTxId; EXPIRED ↔ both null);
                 SETTLEMENT carries `observationWindowDays` so the Asian-style
                 7-day-TWAP averaging is explicit in the audit trail
- `mirror.js`    REST client + `verifyTransaction` + `matchesExpectedTransfer`
                 (seller credit exact, buyer debit ≥ amount + fee) + `verifyWithRetry`
                 (handles 2–6s mirror lag)
- `hcs.js`       `createTopic`, `submitEnvelope` (validates first), `readEnvelopes`
- `client.js`    Hedera SDK client builder; mainnet refused at the schema layer

### Server + UI — `src/server/`
- Express app: `/api/{config,feed,quote,buy,settle,payout/approve,pool,policies,ledger}`
  + SSE `/api/events` + `/healthz` + `/LIMITATIONS.md`
- Vanilla HTML/JS frontend with inline-SVG price chart, exposure utilization bar,
  RETURN_BYTES approval card, ledger with HashScan deep links

### MCP — `src/mcp-server.js`
The same Aegis plugin exposed over stdio for Claude Desktop / Anthropic SDK / Cursor /
any MCP client. Setup guide: [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md).

## Running it

### Prerequisites
- Node ≥ 20
- **Two testnet accounts** (free at <https://portal.hedera.com/dashboard>), ECDSA keys —
  one for the cap buyer, one for the Aegis underwriter pool.

### Setup
```bash
git clone https://github.com/alantgoff/aegis.git
cd aegis
npm install
cp .env.example .env
# fill in BUYER_* and UNDERWRITER_* in .env
```

### Smoke tests (run these first)
```bash
npm run smoke:balance     # logs AgentMode enum + queries buyer's testnet HBAR balance
npm run smoke:hcs         # creates the Aegis HCS topic; prints AEGIS_TOPIC_ID for .env
npm run smoke:lifecycle 4 5 30 1.6 10
                          # full end-to-end on testnet:
                          # quote(K=$4,Q=5,30d,maxPayout=$10) → pay premium →
                          # POLICY (joint-VaR check passes) →
                          # inject shock ×1.6 → advance 30d →
                          # Asian-style 7-day TWAP settlement →
                          # RETURN_BYTES (if payout > autonomous cap) →
                          # approve → PAID_OUT or EXPIRED
```

### Run the demo
```bash
npm start                 # http://localhost:3000
```

### Tests
```bash
npm test                  # 73 tests; pure / fetch-mocked. No testnet required.
```

### MCP
```bash
npm run mcp               # stdio MCP server for Claude Desktop / Anthropic SDK.
                          # Full setup guide: docs/MCP_SETUP.md
```

## Deployment

[`render.yaml`](render.yaml) configures Render.com — push to GitHub, point Render at
the repo, set the secrets (`BUYER_*`, `UNDERWRITER_*`, `AEGIS_TOPIC_ID`,
`PUBLIC_BASE_URL`) in the dashboard. Health check `/healthz`. Free tier spins down
after ~15 min idle (grader's first visit wakes it); ~$5/mo for always-on.

The bounty requires the URL stays live **90 days past the deadline**.

## Trust boundary — read this

The HCS log is **an index, not proof**. Only the on-chain HBAR transfers — premium
inbound, payout outbound — are ground truth, and every one is independently
re-verifiable on the mirror node. Policy issuance, price observations, settlements,
and provider capacity postings are recorded on HCS for transparency, but the substrate
of trust is the **mirror-verified transfer at each end of every policy**. Mainnet is
refused at the schema layer; payouts above the autonomous cap go through
`AgentMode.RETURN_BYTES`.

Full discussion of what Aegis **does not claim** — derivatives-grade index, calibrated
basis-risk closure without in-kind, verified contributed compute, etc. — is in
[`LIMITATIONS.md`](LIMITATIONS.md).

## Hedera Agent Kit feedback

Aegis had to build a policy/guardrail layer outside the kit. The credible gap and
a proposed pre-sign guard hook + external-context interface are written up in
[`docs/FEEDBACK_ISSUE.md`](docs/FEEDBACK_ISSUE.md), which is the source for the
required GitHub issue on
[hashgraph/hedera-agent-kit-js/issues](https://github.com/hashgraph/hedera-agent-kit-js/issues).

## License

MIT. Third-party deps declared in [`package.json`](package.json) — primarily
`hedera-agent-kit`, `@hashgraph/sdk`, `@langchain/*`, `@modelcontextprotocol/sdk`,
`express`, `zod`, `bignumber.js`.
