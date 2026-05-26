# LIMITATIONS — what Aegis does NOT claim

Aegis makes a specific, narrow claim and it is easy to overstate it. Spelling out the
limits up front is the honest thing to do — and it is also what the Hedera Bounty Terms
reward ($250 "Best Application of Industry Standards" bonus, auto-considered).

## The narrow claim

> **We sell an option that pays out if a stylized reference price of H100 GPU-hour
> rentals rises above a strike during a coverage window, with premiums and payouts
> moving as HBAR transfers we independently re-verify against the Hedera mirror node.**

Every other property of the system is either a convenience (UI, calibration data, x402
plumbing) or a mitigation against the limits below.

## Trust boundary (ground truth vs. index)

| Layer | What it is | Trust |
|---|---|---|
| **Hedera ledger / mirror node** | The HBAR transfers themselves: buyer → pool (premium) and pool → buyer (payout). | **Ground truth.** |
| **Aegis HCS topic** | A versioned-JSON log: `POLICY`, `PRICE_REF`, `SETTLEMENT`, `PROVIDER_CAPACITY` records. | **Index only.** Agents write their own messages. |
| **Simulated price path** | The live reference R(t) the demo runs against. **Labeled simulated** in the UI. Calibrated from real public H100 rental history; the path itself is generated locally. | **Demonstration substrate, not market data.** |

Aegis records every policy, observed price reference, and settlement on HCS. The trust
substrate, though, is the **transfer at each end of every policy**: the premium that
moves into the pool when the policy is issued, and the payout (if any) that moves out
at settlement. Those transfers are mirror-node-verifiable. Anything written to HCS
is index, not proof.

## What Aegis does NOT claim

- **Not a derivatives-grade index.** No free, API-accessible, *volatile* GPU index
  exists. Silicon Data / Ornn (the references behind the May 2026 CME and ICE launches)
  are paid Bloomberg-distributed services. Artificial Analysis publishes per-token list
  prices that are administered step-functions, monthly, monotonic-down. Aegis therefore:
  - Calibrates the price-model parameters (drift, vol, jump intensity) from real
    public H100 rental price history (a small bundled snapshot).
  - Runs the live demo on a **clearly-labeled simulated path** generated locally, with
    a manual "inject shock" control.
  This is honest and demoable; it is not a market.

- **Basis risk is explicit.** The product is a cap on a GPU-hour rental rate, framed
  to buyers as an inference-cost cap. Buyers paying per-token still bear residual basis
  risk vs. the rental rate. The in-kind settlement path (roadmap) is the mitigation —
  delivering compute at the capped price closes the gap. The demo settles in cash.

- **Pricing is a stylized model**, not actuarially certified. The mean-reverting
  jump-diffusion captures the qualitative behavior (downward drift + rare upward jumps)
  but the parameter estimates are illustrative. The pricer is transparent: open the
  source, read the inputs, run more paths if you want tighter confidence intervals.

- **In-kind settlement is roadmap.** A `PROVIDER_CAPACITY` envelope type and a mock
  provider agent are part of the demo so the supply-side interface is concrete, but
  delivering actual compute at the capped price — and *verifying* contributed compute —
  is unsolved and explicitly out of scope.

- **The pool is the operator account, not a real treasury.** For the demo, the
  underwriter account is the "pool" — its HBAR balance is what's available to pay out.
  Production would back the pool with a separate treasury, multi-sig signing, and
  reserved-funds accounting tied to outstanding exposure. The pool/exposure module
  models this but the actual fund segregation is demo-grade.

- **Testnet only.** Aegis refuses to run on mainnet at the schema layer
  ([src/config.js](src/config.js)). Above-cap payouts go through `AgentMode.RETURN_BYTES`
  — the kit returns unsigned bytes; a human signs. The agent is technically incapable
  of moving real-economic-value HBAR without a code change.

- **No identity layer.** A Hedera account ID is not a verified identity. Aegis does not
  KYC buyers or providers. The supply-side hook is designed to support a counterparty
  scoring pass (reusing the mirror-node-verified-history pattern from the prior Sentinel
  prototype) before accepting a provider's capacity for in-kind settlement, but that
  scoring runs *over* mirror-node-confirmed transfers — the substrate of trust is
  cryptographic, not credential-based.

## Specific known weaknesses

### 1. Live feed dependence
The demo's "live" R(t) is a local simulator. If a real derivatives venue offered an
API for an H100 rental index, swapping the feed adapter is a single-file change
([`src/pricing/price-model.js`](src/pricing/price-model.js)). Until then, the demo
is honest about what it is.

### 2. Payout window race
Settlement reads the observed price at expiry. If the mirror node lags between the
window-end timestamp and the settlement call, the underwriter could observe a different
R than the buyer expects. The settlement code freezes the R-at-expiry as a `PRICE_REF`
envelope BEFORE constructing the payout transfer; the payout itself references the
frozen value. Disputes (if any) reduce to "was the PRICE_REF honest" — a transparency
problem, not a trust problem.

### 3. Pool insolvency
If multiple policies all hit their payout windows during the same shock, aggregate
payouts could exceed the pool. The exposure module computes worst-case payouts on every
issuance and refuses policies that would push exposure beyond `MAX_EXPOSURE_RATIO` of
the pool's current balance — but parameter mistuning could still leave a tail risk.
Production would need reinsurance or a buffer fund.

### 4. Strike manipulation by the buyer
Buyers can pick any strike. The economic logic still holds — a strike far above the
expected path yields a tiny premium and rarely pays out; a strike at-the-money yields
a large premium. The pricer handles both ends transparently; no special-case is needed.

### 5. Single-account demo mode
If `UNDERWRITER_ACCOUNT_ID` is unset, Aegis runs with the buyer and underwriter on
the same account — the same demo-shortcut that the prior Sentinel build documented.
Mirror nodes net self-transfers entirely, so transfer-set assertions degenerate to
"the tx succeeded." With two distinct accounts (the recommended demo configuration)
the full transfer-set verification runs.

## Where to look in the code

- Trust-boundary core (mirror-node-verifier with transfer-set match):
  [`src/hedera/mirror.js`](src/hedera/mirror.js)
- Envelope schema (versioned, validated; new Aegis types in commit A1):
  [`src/hedera/envelope.js`](src/hedera/envelope.js)
- Price model + Monte Carlo pricer (incoming, commits A2a–A2c):
  `src/pricing/`
- Policy issuance + settlement state machine (incoming, commits A2e + A3):
  `src/plugin/` + `src/agents/`
- Mainnet refusal: [`src/config.js`](src/config.js) (`HEDERA_NETWORK === 'mainnet'`
  fails Zod validation)
