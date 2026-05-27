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

## Pricing — Monte Carlo over jump-diffusion

```
premium = expected_payout + risk_load + ops_load
expected_payout = E[ max(0, R − K) ] × Q     (Monte Carlo, 5000 paths)
```

The price process is a **mean-reverting jump-diffusion** on `log R`:

```
log R[t+1] = log R[t] + κ(θ − log R[t])Δt + σ√Δt · Z + J[t]
```

where `J[t]` fires with probability `λΔt` and is `N(μ_J, σ_J²)`. Mean reversion captures
"spikes don't persist"; jumps capture "shortages happen rarely but matter a lot."

**Calibration:** parameters are estimated from a bundled snapshot of 36 monthly H100
USD/hr medians, Jan 2023 → Dec 2025 (sources: Lambda, Together, Vast.ai, Runpod,
CoreWeave). The bundled-data calibration is exposed via `aegis_get_price_params` for
audit. The runtime uses a slightly stressed parameter set so the demo shows meaningful
30-day OTM premiums (monthly medians damp short-term spikes — discussed in detail in
[`src/bootstrap.js`](src/bootstrap.js) and [`LIMITATIONS.md`](LIMITATIONS.md)).

**Sample MC quotes** (R₀ = $2.50/hr, hbarUsdPrice = $0.05/HBAR):

| Strike | Notional | Window | Premium       | P(ITM) |
|--------|---------:|-------:|---------------|-------:|
| $2.50 (ATM) | 1000 GPU-h | 30d | 5793 HBAR | 57.5% |
| $4.00 (OTM) | 1000 GPU-h | 30d |  289 HBAR |  2.3% |
| $10  (deep OTM) | 1000 GPU-h | 30d |    0 HBAR |    0% |
| $3   | 1000 GPU-h | 90d | 6847 HBAR | 40.0% |

The realistic buyer regime is OTM with a 30-day window: cheap protection against tail
spikes. ATM is closer to a "buy back your downside" — expensive.

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
   ┌────────────────────▼─────────────────────────┐
   │ AEGIS — Underwriter agent (Agent Kit)         │
   │  • simulated price feed (calibrated + shock)  │
   │  • Monte Carlo option pricer                  │
   │  • pool + exposure book                       │
   │  • policy issuance / settlement state machine │
   │  • RETURN_BYTES human-in-loop for payouts     │
   └───┬───────────────┬────────────────┬──────────┘
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
  premium tx on the mirror node, runs the exposure book's `checkIssuance`, refuses
  if the worst-case payout would push the pool over `maxExposureRatio × balance`.
- `index.js` — `createAegisPlugin(...)` factory returning a kit-compatible `Plugin`.

### Pricing — `src/pricing/`
- `rng.js`         seeded xorshift128+ PRNG with Box-Muller normals (deterministic)
- `price-model.js` jump-diffusion `simulatePath` + `injectShock` + `DEFAULT_PARAMS`
- `calibration.js` bundled H100 monthly medians + parameter estimator
- `pricer.js`      `pricePremium` (full cost decomposition + 95% CI) + `maxLikelyPayoutHbar`
- `feed.js`        `createSimFeed` — wall-clock-ticking labeled-simulated feed

### Pool + exposure — `src/pool/`
- `exposure.js` in-memory book: add / remove / dropExpired / list / snapshot /
  checkIssuance with conservative Σ-maxPayout aggregation
- `pool.js`     mirror-node-backed balance reader

### Agents — `src/agents/`
- `underwriter.js`  pricing + issuance + settlement; two `HederaLangchainToolkit`
                    instances for the AUTONOMOUS / RETURN_BYTES dance on payouts
- `buyer.js`        quote → pay premium → request issuance (kit `transfer_hbar_tool`)
- `provider.js`     mock supply-side agent posting PROVIDER_CAPACITY envelopes

### Hedera I/O — `src/hedera/`
- `envelope.js`  v1 envelope schema (POLICY / PRICE_REF / SETTLEMENT /
                 PROVIDER_CAPACITY) with `superRefine` invariants
                 (PAID_OUT ↔ payoutHbar>0+payoutTxId; EXPIRED ↔ both null)
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
npm run smoke:lifecycle 4 10 30 1.8
                          # full end-to-end on testnet:
                          # quote(K=$4,Q=10,30d) → pay premium → POLICY →
                          # inject shock ×1.8 → advance 30d → settle →
                          # RETURN_BYTES → approve → PAID_OUT
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
