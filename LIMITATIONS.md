# LIMITATIONS — what Aegis does NOT claim

Aegis makes a specific, narrow claim and it is easy to overstate it. Spelling out the
limits up front is the honest thing to do — and it is also what the Hedera Bounty Terms
reward ($250 "Best Application of Industry Standards" bonus, auto-considered).

## The narrow claim

> **We sell an option that pays out if a stylized reference price of H100 GPU-hour
> rentals rises above a strike during a coverage window, with premiums and payouts
> moving as HBAR transfers we independently re-verify against the Hedera mirror node.**

Every other property of the system — pricing model, calibration, exposure check,
settlement convention, UI — is either a convenience or a mitigation against the
specific weaknesses below.

## Trust boundary (ground truth vs. index vs. statistical model)

| Layer | What it is | Trust |
|---|---|---|
| **Hedera ledger / mirror node** | The HBAR transfers themselves: buyer → pool (premium) and pool → buyer (payout). | **Ground truth.** Cryptographic finality via Hedera consensus. |
| **Aegis HCS topic** | A versioned-JSON log: `POLICY`, `PRICE_REF`, `SETTLEMENT`, `PROVIDER_CAPACITY`. | **Index only.** Agents write their own messages — what they choose to record. |
| **Reference price R(t)** | Local labeled-simulated jump-diffusion (`source: sim:labeled` / `sim:shock` enforced by schema). | **Demonstration substrate, not market data.** |
| **Pricing / calibration / exposure** | Monte Carlo, EM, regime-switching jump-diffusion, joint-VaR — peer-reviewed, replicable methods. | **Statistical, not certified.** |

The substrate of trust is the **transfer at each end of every policy**: the premium
that moves into the pool when the policy is issued, and the payout (if any) that
moves out at settlement. Both transfers are mirror-node-verifiable. Everything else
is either an index or a statistical estimate; nothing else is "proof."

## What Aegis does NOT claim

### Not a derivatives-grade index
No free, API-accessible, *volatile* GPU index exists. Silicon Data / Ornn (the
references behind the May 2026 CME and ICE launches) are paid Bloomberg-distributed
services. Artificial Analysis publishes per-token list prices that are administered
step-functions, monthly, monotonic-down. Aegis therefore:

- Calibrates the price model from a bundled snapshot of 36 monthly H100 USD/hr medians
  (Jan 2023 → Dec 2025; sources: Lambda, Together, Vast.ai, Runpod, CoreWeave).
- Runs the live demo on a **clearly-labeled simulated path** generated locally, with
  a manual "inject shock" control.
- Refuses by schema to post an unlabeled feed claim — the PRICE_REF envelope's
  `source` field must match `sim:labeled` | `sim:shock` | `calibration:<id>`.

Honest and demoable; not a market.

### Pricing is a stylized model, not actuarially certified
The regime-switching mean-reverting jump-diffusion captures the qualitative behavior
of compute prices that the literature has documented for electricity/gas markets
(downward drift, mean reversion, asymmetric upward jumps, vol regimes). Aegis's
parameter estimates come from a real but small dataset:

- **Method-of-moments calibration**: 2σ-threshold jump detection. Identifies the
  2023 shortage and 2024 Llama squeeze in the bundled history. Brittle on small
  datasets — that's why we ship EM too.
- **EM calibration**: Press-Ball-Torous jump-diffusion mixture likelihood. On the
  same bundled data, EM identifies all annotated shock months in the top of the
  posterior ranking (P(jump) ≥ 0.94 for each).

A known EM degeneracy: σ_J converges near zero when the identified jumps are
tightly clustered in magnitude (~3-4 jumps × ~+15% each on the H100 series). Real
deployments with longer history would have more jump diversity and avoid this;
a weakly-informative prior on σ_J is the standard remedy. Documented at the
implementation site.

Production-grade actuarial certification (bootstrapped parameter uncertainty,
stress tests across alternative jump distributions, regulatory reporting) is
out of scope.

### Basis risk is explicit
The product is a cap on a GPU-hour **rental rate**, framed to buyers as an
inference-cost cap. Buyers paying per-token still bear residual basis risk vs.
the rental rate. The in-kind settlement path (roadmap) is the mitigation —
delivering compute at the capped price closes the gap. The demo settles in cash.

### In-kind settlement is roadmap
A `PROVIDER_CAPACITY` envelope type and a mock provider agent are part of the demo
so the supply-side interface is concrete, but **delivering actual compute at the
capped price — and verifying contributed compute — is an unsolved problem** we
explicitly do not claim to solve. Production would integrate Akash / io.net / Render /
Aethir APIs; "contribute your own machine" with verifiable proof-of-execution is
research-grade.

### The pool is the operator account
For the demo, the underwriter account is the "pool" — its HBAR balance is what's
available to pay out. Production would back the pool with a separate treasury,
multi-sig signing, and reserved-funds accounting tied to outstanding exposure.
The exposure module models this; the actual fund segregation is demo-grade.

### Testnet only
Aegis refuses to run on mainnet at the schema layer
([`src/config.js`](src/config.js)). Above the configured autonomous-payout cap,
settlements switch to `AgentMode.RETURN_BYTES` — the kit hands back unsigned tx
bytes and waits for a human signature. The agent is technically incapable of
moving real-economic-value HBAR without a code change.

### No identity layer
A Hedera account ID is not a verified identity. Aegis does not KYC buyers or
providers. The supply-side hook is designed to support counterparty scoring
(reusing the mirror-node-verified-history pattern) before accepting a provider's
capacity for in-kind settlement, but that scoring runs *over* mirror-node-confirmed
transfers — the substrate of trust is cryptographic, not credential-based.

## Specific known weaknesses (and what mitigates them)

### 1. Live feed dependence
The demo's "live" R(t) is a local simulator. If a real derivatives venue offered
an API for an H100 rental index, swapping the feed adapter is a single-file
change ([`src/pricing/feed.js`](src/pricing/feed.js)). The envelope schema is
already shaped for it (`source: calibration:<dataset-id>`). Until then, the
demo is honest about what it is.

### 2. Settlement-point manipulation (mitigated)
**Original concern**: a one-day spike on the expiry day would fire the cap fully.
**Mitigation**: settlement uses the arithmetic mean of R over the trailing
**7 days** (Asian-style TWAP — the same construction CME, ICE, and Deribit use
for commodity derivatives). A single-day spike now contributes ~14% to the
settlement R, not 100%. The SETTLEMENT envelope records
`observationWindowDays = 7` so the averaging is explicit in the audit trail.

### 3. Mirror-node lag during issuance
**Original concern**: the underwriter calls `verifyTransaction` immediately
after the buyer's premium transfer; mirror nodes typically lag 2-6s behind
consensus, returning a 404 that looks like fraud.
**Mitigation**: `verifyWithRetry` in [`src/hedera/mirror.js`](src/hedera/mirror.js)
retries with linear backoff up to ~12s. Treats `mirror 404` / `no transaction
record` as transient lag; any other failure mode (wrong amount, wrong parties,
non-SUCCESS result) is a hard error.

### 4. Pool insolvency under correlated shocks (mitigated)
**Original concern**: multiple policies hitting their payout windows during the
same shock could collectively exceed the pool.
**Mitigation**: issuance now runs `checkIssuanceJointVaR` — simulates the joint
payout distribution of (every active policy + the proposed one) under the
**stressed squeeze regime**, takes the 99% quantile of the basket sum, and
refuses if it exceeds `MAX_EXPOSURE_RATIO × pool balance`. This is the
Solvency-II-style 99% VaR over one-window holding. Parameter mistuning could
still leave residual tail risk — production would add reinsurance and stress
tests across alternative parameter sets.

### 5. Strike manipulation by the buyer
Buyers can pick any strike. The economic logic still holds — a strike far above
the expected path yields a tiny premium and rarely pays out; a strike at-the-money
yields a large premium. The pricer handles both ends transparently and the
exposure check refuses policies that would breach the pool cap regardless of
where the strike sits.

### 6. Single-account demo mode
If `UNDERWRITER_ACCOUNT_ID` is unset, Aegis runs with the buyer and underwriter
on the same account. Mirror nodes net self-transfers entirely, so transfer-set
assertions degenerate to "the tx succeeded." **With two distinct accounts (the
recommended demo configuration)** the full transfer-set verification runs —
seller credit exact, buyer debit ≥ amount + fee.

### 7. In-memory state (pool exposure, pending escalations)
The exposure book and the queue of payouts awaiting human approval live in
process memory. A server restart drops them — fine for demo, **not for
production**. The natural recovery is replay-from-HCS: every active POLICY
envelope and every SETTLEMENT envelope on the topic is durable, so a restart
can reconstruct the active-policy set by sequencing through the topic.
Production would add this; the demo does not.

### 8. Single-asset model
Aegis prices and aggregates only H100-class caps. The envelope schema enforces
`class: 'H100'`. Multi-class portfolios (H100 + H200 + B100) would need a
copula for cross-class dependence in the joint-VaR check. Architecturally
straightforward; explicitly out of scope.

## Where to look in the code

| Concern | File |
|---|---|
| Trust-boundary core: mirror-node verifier with transfer-set match | [`src/hedera/mirror.js`](src/hedera/mirror.js) |
| Envelope schema (versioned, schema-enforced source labels & invariants) | [`src/hedera/envelope.js`](src/hedera/envelope.js) |
| Regime-switching jump-diffusion price model | [`src/pricing/price-model.js`](src/pricing/price-model.js) |
| Method-of-moments calibration | [`src/pricing/calibration.js`](src/pricing/calibration.js) |
| EM (Press-Ball-Torous) calibration | [`src/pricing/em-calibration.js`](src/pricing/em-calibration.js) |
| Monte Carlo pricer with antithetic variates + CVaR risk loading | [`src/pricing/pricer.js`](src/pricing/pricer.js) |
| Joint-VaR exposure check | [`src/pool/exposure.js`](src/pool/exposure.js) — `checkIssuanceJointVaR` |
| Asian-style settlement constant | [`src/server/app.js`](src/server/app.js) — `ASIAN_SETTLEMENT_WINDOW_DAYS` |
| Mainnet refusal | [`src/config.js`](src/config.js) (Zod schema) |
| Algorithm methods writeup with literature references | [`docs/ALGORITHMS.md`](docs/ALGORITHMS.md) |
