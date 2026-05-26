# LIMITATIONS — what Sentinel does NOT prove

This document exists because Sentinel makes a specific, narrow claim and it is
easy to overstate it. Stating the limits up front is the honest thing to do —
and it is also the thing the Hedera Bounty Terms reward (see the $250 "Best
Application of Industry Standards" bonus).

## The narrow claim

> **We score counterparties on payments we can independently confirm.**

That is the entire claim. Every other property of the system is either a
convenience (UI, demo data, x402 plumbing) or a mitigation against the
limitations described below.

## Trust boundary (ground truth vs. index)

There are exactly two sources of fact in Sentinel:

| Layer | What it is | Trust |
|---|---|---|
| **Hedera ledger / mirror node** | The on-chain HBAR transfers themselves. Cryptographically confirmed by the Hedera consensus algorithm. | **Ground truth.** |
| **Sentinel HCS topic** | A versioned-JSON envelope log. Each settlement envelope references a transaction id. | **Index only.** Agents write their own messages; an agent could omit, sanitize, or fabricate them. |

The reputation engine is built around this asymmetry:

1. Read every envelope on the topic via the mirror node REST API (so the read
   is not gated by any operator key — anyone can independently rebuild the
   same view).
2. For every `SETTLEMENT` envelope: ask the mirror node directly whether the
   referenced transaction id resolves to a `SUCCESS` transfer **AND** whether
   the transfer set on that record matches the envelope's claimed
   buyer/seller/amount (within 1 tinybar).
3. **Drop everything that fails verification.** Score only what's left.

This is why a counterparty cannot fabricate a "track record" by spamming
SETTLEMENT envelopes — every one of them gets re-verified against the ledger.

## What Sentinel does NOT claim

- **The HCS log does not prove policy compliance.** A buyer could pay a seller
  while deliberately *omitting* the corresponding SETTLEMENT envelope from the
  log. The buyer's reputation would simply not benefit from that off-log
  payment — but the ledger entry still happened. The HCS log proves what was
  *recorded*, not what occurred.
- **A high score does not predict future behavior.** It summarizes the past.
  Counterparties can clean-pay 100 times to build a score, then defect on
  query 101. Sentinel's only defenses against this are the rule engine (caps,
  velocity, daily limits) and the human-in-the-loop escalation — they cap the
  per-event damage, not the cumulative one.
- **The reputation engine is heuristic, not a probability.** The score is a
  bounded composite of four hand-tuned components (count, volume, recency,
  verifiability) minus a denial penalty. It is not a calibrated probability of
  future success. We chose this deliberately: stable, inspectable, and easy
  for a human reviewer to override. The rubric for the score is in
  [src/plugin/reputation.js](src/plugin/reputation.js) and the `reasons` array
  on every `ReputationProfile` shows exactly how the score was assembled.
- **No identity check.** A Hedera account id is not a verified identity. An
  attacker can create a fresh account and start a new history. The thin-
  history gate (≥ 3 verified settlements required before autonomous spend)
  is the only mitigation, and it is a *delay*, not a defense.

## Specific known weaknesses

### 1. Sybil from a fresh seed
A bad actor can create unlimited new Hedera accounts. Each starts with a
zero-history profile, so the thin-history gate fires `ESCALATE` for the first
3 trades. The mitigation is human-in-the-loop, not on-chain identity.

### 2. Replay of historic transactions
The mirror node confirms a transaction happened; it does not tell you *which
purchase* it was paying for. A buyer could in principle reference a past
transfer as "settlement" for a new quote. The seller-side defense:
`seller.serve()` rejects payments whose consensus timestamp is more than
`PAYMENT_WINDOW_MS` (10 minutes) before the serve call, and refuses to serve
the same quote twice. This narrows replay to "minutes" rather than
"unbounded."

### 3. Topic spam
Anyone can post any JSON to the Sentinel HCS topic. The decoder treats
non-conforming messages as no-ops (`decodeEnvelope` returns `null`). The
verifier discards malformed envelopes silently. Cost to attackers: HBAR per
message. Effect on reputation: none.

### 4. Mirror node lag
Mirror nodes typically lag the network by 2–6 seconds. The UI polls a few
times with backoff so the ledger refresh "catches" newly-submitted envelopes;
the reputation scorer ingests whatever the mirror returns at query time. A
seller cannot use mirror lag to deny a recent settlement, because the
verifier returns "transaction record not yet seen" → unverified → dropped
from the score (no false credit), and the seller's own `serve()` path waits
for the mirror to confirm before answering.

### 5. The buyer is the operator
In the single-account demo (when `SELLER_ACCOUNT_ID` is unset or equals
`BUYER_ACCOUNT_ID`), the same key signs both sides. **This is a demo
shortcut**; in any real deployment the buyer and seller are distinct
accounts with distinct keys. The README's run instructions cover the
two-account setup.

**Specific consequence:** the Hedera ledger *nets self-transfers entirely*
— if account A transfers 0.5 HBAR to account A, the mirror node's
transfers array contains only the network-fee debit and shows no
"+0.5 HBAR" credit. There is nothing to assert against. In single-account
mode the seller and the reputation scorer both fall back to "the
transaction succeeded" verification (the consensus-window and replay
defenses are still enforced), and a `[seller] buyer === seller …` warning
is logged. With two distinct accounts the full transfer-set match runs;
that is the production code path. See `src/agents/seller.js` and
`src/plugin/reputation.js` — both branches are explicit and documented at
the call site.

### 6. Pending escalations are in-memory
The Express server stores pending escalations (`requestId → { decision,
quote }`) in process memory. A restart drops them — the user must
re-request. This is acceptable for a demo and explicit in the code (see
the comment at the top of `escalations` in `src/server/app.js`). A
production deployment would back this with a durable store and re-issue
quotes if the original expired during the human-approval delay.

### 7. Mainnet refused at the schema layer
Sentinel is bounty-scoped and explicitly refuses to run on `HEDERA_NETWORK=mainnet`
([src/config.js](src/config.js)). It satisfies the bounty's agent-safety
requirement by being technically incapable of moving real-economic-value
HBAR without a code change.

## What we did NOT build (and why)

- **A KYC layer.** Out of scope; reputation is the substrate, not identity.
- **A real fraud model.** A scoring function is not a classifier. We did not
  train anything; the score is hand-tuned heuristic.
- **Signed envelopes.** Each envelope is plain JSON. Adding a signature
  doesn't help, because the mirror-node verification is what gives us
  non-repudiation — the signature would just re-confirm what the operator
  already controlled. If the envelope schema ever gets multi-author authoring
  (e.g., third-party witnesses), signed envelopes become useful and v2 of
  the envelope would add them.

## Where to read the code

- Trust-boundary core: [src/plugin/reputation.js](src/plugin/reputation.js)
- Mirror verifier with transfer-set match: [src/hedera/mirror.js](src/hedera/mirror.js)
- Envelope schema (versioned, validated): [src/hedera/envelope.js](src/hedera/envelope.js)
- Why the seller doesn't trust the buyer's claim of "I paid":
  [src/agents/seller.js](src/agents/seller.js) — `verifyTransaction` + `matchesExpectedTransfer` are both called *before* the data is returned
- All policy decisions, denials, and settlements are themselves posted to HCS
  for transparency: [src/agents/buyer.js](src/agents/buyer.js) — `postPolicyDecision`, `postDenial`, `postSettlement`
