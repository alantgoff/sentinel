# Aegis

**Autonomous underwriter agent on Hedera selling cost-cap options on H100 GPU-hour
rentals.** Pay a premium today; if the H100 rental rate spikes above your strike
during the coverage window, the agent reimburses the difference. Option, not future.
Cash settle now; in-kind compute is roadmap.

> Hook: *budget certainty for compute — a price cap on inference, settled on Hedera.*

Submission for the **[Hedera AI Agent Bounty](https://ai-bounties.hedera.com) — Week 5:
Policy Agent ($1,500 in HBAR)**.

> ⚠️ **Under construction.** This repo is mid-pivot from an earlier prototype (Sentinel —
> agent credit underwriting via counterparty reputation) to Aegis — compute cost-cap
> options. The plumbing carries over (Hedera Agent Kit wiring, HCS submit/read, mirror-node
> verifier, server scaffold, CI, Render deploy, x402 surface); the product layer is being
> rewritten. See [git log](https://github.com/alantgoff/aegis/commits/main) for current
> state.

## The real-world problem

Inference is now >60% of compute cost for major AI providers, and the price is volatile
around a falling long-term trend — periodic shortages (the H100 crunch) cause real spikes
when buyers' budgets are most exposed. The institutional venues (CME + Silicon Data, ICE +
Ornn — both launched May 2026) offer **cash-settled GPU-hour futures on proprietary
indices** to institutions hedging large positions. They do not serve:

1. **App-layer / long-tail AI startups** whose pain is per-invoice inference-cost
   certainty, not GPU-rental positions.
2. **Option-style risk transfer.** In a market that trends down, an asymmetric *cap*
   (option) costs a fraction of a symmetric *forward* and protects only the tail —
   exactly when budget certainty matters.
3. **In-kind settlement.** Cash-settled index futures leave basis risk vs. the buyer's
   actual provider invoice. Settling in real compute closes that gap.

Aegis sits in that opening: on-chain, agent-native, permissionless, option-style,
in-kind-capable. Validation: **American Express already underwrites *agent execution
error*** — the market accepts that agent-economy risk is underwritable. Aegis underwrites
*compute-cost* risk.

## The instrument (locked design)

A European-style **cost-cap option**:

- **Underlying R:** H100-class GPU-hour rental rate (the only compute price actually
  volatile + optionable on demo timescales — per-token list prices are administered
  step-functions, monthly, monotonic-down)
- **Strike K**, **notional Q** (GPU-hours), **window** (e.g. 30 days), **premium P** up front
- **Payout at expiry:** `max(0, R_observed − K) × Q`, capped at a max payout
- Framed to buyers as "a cap on your compute cost"; per-token-vs-GPU-hour gap is the
  disclosed **basis risk** that in-kind settlement (roadmap) closes

## Pricing

Transparent and actuarial:

```
premium = expected_payout + risk_load + ops_load
expected_payout = E[ max(0, R − K) ] × Q     // option value via Monte Carlo
```

- Model `R` with a **mean-reverting jump-diffusion** (downward drift + rare upward jumps);
  price via Monte Carlo (the path simulator + pricer land in commits A2a–A2c)
- Parameters (drift, vol, jump intensity) calibrated to **real public H100 rental
  history** (a small bundled snapshot; the model itself is real, the live demo path is
  clearly-labeled simulated)
- Pool/exposure accounting refuses new caps that breach a max aggregate-exposure ratio

## Reference feed — locked hybrid approach

No free, API-accessible, *volatile* GPU index exists (Silicon Data / Ornn = paid /
Bloomberg-distributed; Artificial Analysis is sticky per-token data). So:

> **Calibrate the model to real historical GPU rental prices, then run the live demo on
> a clearly-labeled simulated price path with a manual "inject shock" control.**

Real grounding + demoable dynamics + honest labeling. **Aegis is not, and does not claim
to be, a derivatives-grade index.** Full disclosure in [`LIMITATIONS.md`](./LIMITATIONS.md).

## Architecture (target)

```
        ┌──────────────────────────────────────────────────────────┐
        │ Hosted interactive UI (qualifying requirement)            │
        │  request cap → live premium (MC) → buy → [inject shock]   │
        │  → expiry → payout/settle → on-chain trail + verified     │
        └───────────────┬──────────────────────────────────────────┘
                        │
   ┌────────────────────▼─────────────────────┐
   │ AEGIS — Underwriter agent (Agent Kit)     │
   │  • price feed adapter (calibrate+simulate)│
   │  • Monte Carlo option pricer              │
   │  • pool + exposure accounting             │
   │  • policy issuance / settlement machine   │
   │  • RETURN_BYTES human-in-loop for payouts │
   └───┬───────────────┬───────────────┬───────┘
       │ premium/payout │ reads         │ writes POLICY / PRICE_REF / SETTLEMENT
       ▼                ▼               ▼
 ┌───────────┐   ┌──────────────┐  ┌────────────────────────────┐
 │ Cap buyer │   │ Mirror node  │  │ Aegis HCS topic            │
 │ (AI co.)  │   │ REST (verify │  │  - POLICY                  │
 └───────────┘   │  transfers)  │  │  - PRICE_REF               │
                 └──────────────┘  │  - SETTLEMENT              │
 ┌───────────────────────────┐     │  - PROVIDER_CAPACITY (hook)│
 │ Provider agent(s) (mock)  │────▶│                            │
 │ post capacity + ask price │     └────────────────────────────┘
 └───────────────────────────┘

 pricing(R) calibrated to real GPU-rental history; live path simulated + shock-injectable
```

## Running it

### Prerequisites
- Node ≥ 20
- Two testnet accounts (free at <https://portal.hedera.com/dashboard>), ECDSA keys —
  one for the cap buyer, one for the Aegis underwriter pool.
- Optional: a free Groq API key for the NL-buyer chat path (the deterministic
  flow doesn't need an LLM).

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
npm run smoke:balance   # logs AgentMode enum + queries buyer's testnet balance
npm run smoke:hcs       # creates the Aegis HCS topic; prints AEGIS_TOPIC_ID=… for .env
```

### Run the demo
```bash
npm start               # http://localhost:3000  (placeholder UI during pivot)
```

### Tests
```bash
npm test                # Node's test runner. Pure / fetch-mocked — no testnet required.
```

## Trust boundary

The HCS log is **an index, not proof**. Only the on-chain HBAR transfers — premium
inbound to the pool, payout outbound to the buyer — are ground truth. Policy issuance,
price observations, settlements, and provider capacity postings are *recorded* on HCS,
but the substrate of trust is the mirror-node-verifiable transfer at each end of every
policy. Mainnet is refused at the schema layer.

Full discussion of what Aegis **does not claim** — derivatives-grade index, calibrated
basis-risk closure without in-kind, verified contributed compute, etc. — is in
[`LIMITATIONS.md`](./LIMITATIONS.md).

## License

MIT. Third-party deps declared in [`package.json`](./package.json) — primarily
`hedera-agent-kit`, `@hashgraph/sdk`, `@langchain/*`, `@modelcontextprotocol/sdk`,
`express`, `zod`.
