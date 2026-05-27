# Aegis

**A price cap on compute, settled on Hedera.**

Aegis is an autonomous underwriter agent that sells AI companies insurance
against spikes in H100 GPU rental rates. You pay a small premium today; if the
spot price exceeds your strike during the coverage window, the agent reimburses
the difference in HBAR. Like Lloyd's of London for inference budgets — but
on-chain, agent-native, and option-style, so a quiet market costs you almost
nothing.

[![CI](https://github.com/alantgoff/aegis/actions/workflows/ci.yml/badge.svg)](https://github.com/alantgoff/aegis/actions)
![tests](https://img.shields.io/badge/tests-102%2F102-brightgreen)
![network](https://img.shields.io/badge/network-testnet-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

> Submitted to the [**Hedera AI Agent Bounty — Week 5: Policy Agent**](https://ai-bounties.hedera.com).
> Built on the Hedera Agent Kit (`hedera-agent-kit` v3.x) with HCS audit
> trails, mirror-node-verified payments, and `AgentMode.RETURN_BYTES`
> human approval on large payouts.

---

## See it work

- **Live demo:** *(coming soon — deploying to Render before submission)*
- **On-chain audit trail (testnet):** [HCS topic `0.0.9064479`](https://hashscan.io/testnet/topic/0.0.9064479)
  — every policy, price reference, and settlement is independently
  readable from the Hedera mirror node, with no permission required.
- **Run locally:** [see below](#run-it-locally) — three commands.

---

## Why this exists

Inference is now the dominant compute cost for AI products (often 60%+ of
infrastructure spend) and the price is volatile around a slow downward trend —
periodic shortages (the H100 crunch) cause real spikes when budgets are most
exposed. Today, two large institutional venues offer cash-settled GPU-rental
futures (CME + Silicon Data, ICE + Ornn, both launched May 2026), but they
serve institutions hedging large rental positions and don't address three
things that matter to app-layer AI builders:

1. **Option, not future.** In a market trending down, locking a forward is
   irrational — you'd guarantee yourself the loss. A *cap* (option) costs a
   fraction of a forward and pays out only on tail spikes, which is what
   actually matters for budget certainty.
2. **App-layer pricing.** Buyers paying per inference-call shouldn't have to
   manage GPU-rental positions; Aegis packages a rental-rate cap for the
   long tail of AI startups.
3. **In-kind settlement (roadmap).** Cash settlement leaves basis risk vs.
   your real provider invoice. Settling the cap in *actual compute at the
   capped price* removes that gap. The supply-side hook is plumbed; the
   in-kind delivery layer is the natural next product.

American Express already underwrites *agent execution error* as an insurable
risk. Aegis underwrites *compute-cost* risk. Same direction; different peril.

---

## How it works

```
   ┌─────────────────────────────────────────────────────┐
   │  You: an AI company worried about a price spike     │
   └──────────────────┬──────────────────────────────────┘
                      │ 1. ask for a cap (strike $K, Q GPU-hrs, 30 days)
                      ▼
   ┌─────────────────────────────────────────────────────┐
   │  Aegis underwriter agent                            │
   │  • prices the cap with a regime-aware MC model      │
   │  • checks pool exposure (99% joint VaR)             │
   │  • posts POLICY to HCS, verifies your premium tx    │
   └──────────────────┬──────────────────────────────────┘
                      │ 2. you pay premium in HBAR (on-chain)
                      │ 3. during the window, no shock → expire worthless
                      │    during the window, big shock → pay you out
                      ▼
   ┌─────────────────────────────────────────────────────┐
   │  At expiry: Aegis takes a 7-day average of R        │
   │  (Asian-style — manipulation-resistant)             │
   │  If avg > strike, payout = (avg − strike) · Q HBAR  │
   │  Large payouts go through human RETURN_BYTES        │
   │  approval. SETTLEMENT envelope posted to HCS.       │
   └─────────────────────────────────────────────────────┘
```

Every transfer is independently verifiable on the mirror node. Every step
(policy, price observation, settlement) is recorded on a public HCS topic
anyone can read. The model can't fabricate a payment that never happened.

---

## What's inside

| Layer | What Aegis ships |
|---|---|
| **Custom kit plugin** | 8 tools (`aegis_quote_policy`, `aegis_issue_policy`, `aegis_settle_policy`, etc.) plugged into `HederaLangchainToolkit` and `HederaMCPToolkit` simultaneously |
| **Pricing engine** | Regime-switching mean-reverting jump-diffusion + Monte Carlo with antithetic variates + CVaR-based risk loading. Convergence diagnostics on every quote. |
| **Calibration** | Press-Ball-Torous EM (Expectation-Maximization) on a bundled snapshot of 36 monthly H100 medians, Jan 2023 → Dec 2025 |
| **Pool exposure** | Solvency-II-style 99% Joint Value-at-Risk over the basket of all active policies — stricter than Σ-maxPayout when strikes are heterogeneous |
| **Settlement** | Asian-style trailing-7-day TWAP (same construction CME, ICE, and Deribit use for commodity options) |
| **Safety** | Mainnet refused at the schema layer. Payouts above an autonomous cap go through `AgentMode.RETURN_BYTES` — kit returns unsigned bytes; a human signs. |
| **UI** | Express + vanilla JS. Live price chart with regime annotation, exposure utilization bar, RETURN_BYTES approval card, HCS ledger with HashScan links |
| **MCP** | Same plugin exposed over stdio. Drop into Claude Desktop with the [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md) config snippet. |

For the algorithm details and literature citations, see
[`docs/ALGORITHMS.md`](docs/ALGORITHMS.md). For an honest accounting of what
Aegis does *not* claim, see [`LIMITATIONS.md`](LIMITATIONS.md).

---

## Run it locally

You need Node ≥ 20 and two free Hedera testnet accounts
([portal.hedera.com](https://portal.hedera.com/dashboard)).

```bash
git clone https://github.com/alantgoff/aegis.git
cd aegis
npm install
cp .env.example .env             # fill in BUYER_* and UNDERWRITER_*
npm run smoke:hcs                # creates an HCS topic; pastes AEGIS_TOPIC_ID
npm start                        # http://localhost:3000
```

Once running, try the full lifecycle in the UI: build a cap, watch the
Monte Carlo premium quote, pay, inject a price shock, fast-forward to
expiry, settle. Or from the command line:

```bash
npm run smoke:lifecycle 4 5 30 1.6 10
# quote(K=$4, Q=5, 30d, maxPayout=$10) → pay → POLICY →
# inject shock ×1.6 → advance 30d → Asian-style settle →
# RETURN_BYTES if payout exceeds autonomous cap → human-approve → PAID_OUT
```

The 102-test unit suite runs offline:

```bash
npm test                         # mocked mirror, no testnet credentials needed
```

---

## A few sample quotes

The kind of premium Aegis produces under realistic inputs. R₀ = $2.50/hr,
20,000 Monte Carlo paths.

| Scenario | Premium | Probability of payout |
|---|---:|---:|
| At-the-money cap, K = $2.50, 30 days | 416 HBAR | 48% |
| Tail-only cap, K = $4, 30 days | **36 HBAR** | 0.3% |
| Deep tail, K = $6, 30 days | 11 HBAR | 0.1% |
| Same K = $4 cap *during a known shortage* | 1,379 HBAR | 18% |

The **38× swing** for the same K = $4 cap between quiet and squeeze regimes
is the headline of the regime-aware model: buying insurance during a known
shortage is appropriately expensive. The everyday-buyer regime is the second
row — cheap protection against unlikely tail events.

---

## Project status

| | |
|---|---|
| Network | Testnet only (mainnet refused by config schema) |
| Tests | 102/102 passing on CI |
| Live HCS topic | [`0.0.9064479`](https://hashscan.io/testnet/topic/0.0.9064479) |
| Commit history | 32 organic commits across the campaign window |
| License | MIT |

Aegis is functional and end-to-end-tested on Hedera testnet. It is not a
production financial product; it is a working policy-agent reference
implementation for the bounty.

---

## Documentation

- [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md) — full methods writeup with literature
  citations (price process, calibration, MC variance reduction, risk loading,
  settlement, exposure)
- [`LIMITATIONS.md`](LIMITATIONS.md) — what Aegis does not claim, where the
  trust boundary lives, known weaknesses + mitigations
- [`docs/MCP_SETUP.md`](docs/MCP_SETUP.md) — Claude Desktop + other MCP clients
- [`docs/FEEDBACK_ISSUE.md`](docs/FEEDBACK_ISSUE.md) — proposed Hedera Agent Kit
  enhancements (pre-sign guard hook + external-context interface), drawn from
  the gaps we hit building Aegis

---

## Acknowledgments

Built on the [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit-js)
(`hedera-agent-kit` v3.x) and the [Hedera SDK](https://github.com/hashgraph/hedera-sdk-js).
The price-model design follows the established literature for electricity and
gas spot-price options — Cartea-Figueroa 2005, Janczura-Weron 2010, Geman-Roncoroni
2006, Bégin et al. 2025. The calibration uses the Press-Ball-Torous EM
formulation (1967, 1983). Pool exposure follows the Solvency II 99% VaR
convention. Asian-style settlement is the standard for commodity options
on CME, ICE, and Deribit.
