# Sentinel

**Underwriting rail for agent-to-agent payments on Hedera.** One agent extends credit
and autonomous-spend limits to another based on a counterparty track record it cannot
fabricate — derived from on-chain settlement history that is independently re-verified
against the Hedera mirror node.

> One-line hook: *agents extend credit to each other based on a track record they can't fake.*

Submission for the **Hedera AI Agent Bounty — Week 5: Policy Agent ($1,500 in HBAR)**.

## Why this is interesting

The Hedera Agent Kit's payment tools are stateless and trust-blind: an agent that hands
HBAR to another agent has no idea whether that counterparty has ever settled cleanly
before. Sentinel adds the missing layer.

1. A **buyer agent** wants a paid service from a **seller agent**. Payment settles in HBAR.
2. Every settlement is published to an **HCS topic** as a pointer record containing the
   Hedera **transaction ID** of the transfer.
3. The **reputation scorer** rebuilds a counterparty's history from that HCS log, then
   **independently re-verifies every referenced transaction against the mirror node**.
   Anything the mirror node won't confirm is dropped from the score.
4. The **Sentinel policy plugin** combines that score with a rule engine (per-counterparty
   caps, daily/velocity limits, category allowlists, escalation threshold) and returns
   `ALLOW | DENY | ESCALATE`. Above-cap spend triggers `AgentMode.RETURN_BYTES` and a
   human signs.

You can't fabricate a settlement that never hit the ledger — that's the whole point.

## What's in the box

- **Custom Hedera Agent Kit plugin** (`src/plugin/`) — rule engine + verified-history
  reputation scorer + policy combiner, registered via the kit's `Plugin` contract.
- **HCS module** (`src/hedera/hcs.js`) — versioned message envelope, topic create/submit/read.
- **Mirror-node verifier** (`src/hedera/mirror.js`) — independent confirmation of every
  transaction id referenced from HCS; unit-tested against recorded fixtures.
- **Buyer + seller agents** (`src/agents/`) — buyer pays per query, seller exposes a real
  gated service (per-query funding-round / market-data lookup).
- **Hosted interactive UI** (`src/server/`) — Express + vanilla HTML/JS. Trigger a buy
  request, watch the policy decision land, see the counterparty's reputation profile,
  watch the settlement, then watch the mirror-node-verified ledger rebuild.
- **x402 + MCP layer** — seller endpoint gated via HTTP 402 + payment proof; Sentinel
  plugin tools also exposed via the kit's MCP server.
- **`LIMITATIONS.md`** — honest writeup of the trust boundary (see below).

## Trust boundary (read this)

- **Ground truth = the on-chain HBAR transfers.** Those are cryptographically real.
- The **HCS log is only an index** pointing at those transfers. It is *not* proof of
  policy compliance, because the agent writes its own messages and could omit or sanitize
  them.
- **Reputation is derived only from the verified subset** — settlements the mirror node
  confirms.
- **Policy is enforced before signing**, with human-in-the-loop above the autonomous cap.

Full discussion in [`LIMITATIONS.md`](./LIMITATIONS.md).

## Running it

### Prerequisites

- Node.js ≥ 20
- A Hedera **testnet** account (free at <https://portal.hedera.com/dashboard>). Use an
  ECDSA key. For the full demo you'll want a second testnet account for the seller.
- An LLM API key. Defaults to Groq's free tier; OpenAI also supported.

### Setup

```bash
git clone <this repo>
cd sentinel
npm install
cp .env.example .env
# fill in BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY (+ seller pair, + LLM key) in .env
```

### Smoke tests (run these first)

```bash
npm run smoke:balance   # confirms credentials + kit wiring, logs AgentMode enum
npm run smoke:hcs       # creates a topic, posts a test envelope, reads it back two ways
                         # (kit's Topic Messages tool AND raw mirror REST). Prints SENTINEL_TOPIC_ID
                         # to paste into .env.
```

### Run the demo

```bash
npm start               # serves the UI on http://localhost:3000
```

Open the UI, pick a counterparty, trigger a buy request, and watch the policy decision,
reputation profile, settlement, and mirror-node ledger rebuild live.

### Tests

```bash
npm test                # Node's built-in test runner. Mocks the mirror node so tests
                         # don't require network access or testnet credentials.
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  Hosted interactive UI                       │
│  - user triggers a buy request                │
│  - shows policy decision + reputation profile │
│  - shows live settlement + verified ledger    │
└───────────────┬───────────────────────────────┘
                │
 ┌──────────────▼───────────────┐
 │  Buyer Agent (Hedera Agent Kit)│
 │  mode: RETURN_BYTES above cap  │
 └───────┬───────────────┬───────┘
         │               │
┌────────▼──┐     ┌──────▼────────────────────────┐
│ Reputation│     │ Seller Agent + gated service   │
│ -Policy   │     │ (per-query funding-data lookup)│
│ PLUGIN    │     │ x402-gated endpoint            │
└───┬───────┘     └──────┬─────────────────────────┘
    │ reads               │ on settlement
    │                     ▼
┌───▼─────────────┐   ┌────────────────────┐
│ Mirror node REST│◄──│ HCS topic           │
│ (verify tx ids) │   │ (ordered, immutable │
└─────────────────┘   │ pointer records)     │
                      └────────────────────┘
   reputation = f(settlements whose txId is mirror-node-confirmed)
```

## Hedera Agent Kit feedback

Sentinel had to build a policy/guardrail layer outside the kit. The credible gap and a
proposed first-class hook are written up in [`docs/FEEDBACK_ISSUE.md`](./docs/FEEDBACK_ISSUE.md),
which is the source text for the required GitHub issue on
[hashgraph/hedera-agent-kit-js](https://github.com/hashgraph/hedera-agent-kit-js/issues).

## License

MIT. Third-party components and their licenses are declared in `package.json`.
