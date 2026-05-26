# Sentinel

**Underwriting rail for agent-to-agent payments on Hedera.** One agent extends credit
and autonomous-spend limits to another based on a counterparty track record it cannot
fabricate — derived from on-chain settlement history that is independently re-verified
against the Hedera mirror node.

> *Agents extend credit to each other based on a track record they can't fake.*

Submission for the **[Hedera AI Agent Bounty](https://ai-bounties.hedera.com) — Week 5: Policy Agent ($1,500 in HBAR)**.

---

## What's interesting

The Hedera Agent Kit's payment tools are stateless and trust-blind: an agent that
hands HBAR to another agent has no idea whether that counterparty has ever settled
cleanly before. Sentinel is the missing underwriting layer.

The interaction:

1. A **buyer agent** wants a paid service from a **seller agent**. Payment settles in HBAR.
2. Every settlement is published to an **HCS topic** as a pointer record containing
   the Hedera **transaction ID** of the transfer.
3. The **reputation scorer** rebuilds a counterparty's history from that HCS log,
   then **independently re-verifies every referenced transaction against the mirror
   node** — including matching the transfer set against the envelope's claim. Anything
   the mirror node won't confirm is dropped from the score.
4. The **Sentinel policy plugin** combines that score with a rule engine
   (per-counterparty caps, daily/velocity limits, category allowlists, escalation
   threshold) and returns `ALLOW | DENY | ESCALATE`. Above-cap spend triggers
   `AgentMode.RETURN_BYTES` — the kit hands back unsigned bytes and a human signs.

You can't fabricate a settlement that never hit the ledger. That is the whole point.

The honest version of the claim, also written in [`LIMITATIONS.md`](./LIMITATIONS.md):

> *We score counterparties on payments we can independently confirm.*

That's the entire claim. Everything else is plumbing.

---

## Architecture

```
                ┌─────────────────────────────────────────────┐
                │  Hosted interactive UI (Express + vanilla JS)│
                │  - trigger a buy request                      │
                │  - see policy decision + reputation profile   │
                │  - see settlement + verified ledger live      │
                └───────────────┬───────────────────────────────┘
                                │
                 ┌──────────────▼───────────────┐
                 │  Buyer Agent (HederaLangchainToolkit)│
                 │  - AUTONOMOUS for in-cap spend       │
                 │  - RETURN_BYTES above cap (human signs)│
                 └───┬───────────────────────────────┬─┘
                     │                               │
        ┌────────────▼──────┐         ┌──────────────▼──────────────┐
        │ Sentinel Plugin   │         │ Seller Agent + gated service │
        │ - rule engine     │         │ - funding-round lookup       │
        │ - reputation scorer│        │ - x402-gated HTTP endpoint   │
        │ - policy combiner │         └──────┬──────────────────────┘
        └───────┬───────────┘                │ on settlement
                │ reads                       ▼
        ┌───────▼──────────┐      ┌────────────────────────────┐
        │ Mirror node REST │◄─────│ HCS topic (sentinel.v1)     │
        │ (verifyTransaction│      │ versioned envelopes:        │
        │  + match transfers)│     │ QUOTE / POLICY_DECISION /   │
        └──────────────────┘      │ SETTLEMENT / DENIAL         │
                                  └────────────────────────────┘

   reputation = f(settlements whose tx id is mirror-node-confirmed)
```

Everything in the plugin is a `hedera-agent-kit` `Plugin` — registered with
`HederaLangchainToolkit` (LangGraph-friendly) and also with `HederaMCPToolkit`,
so the same tools are simultaneously available to MCP clients (Claude Desktop,
Anthropic SDK, etc.).

---

## What's in the box

### Custom kit plugin — `src/plugin/`
- `rules.js` — pure rule engine. Denylist → service allowlist → hard cap → daily
  limit → velocity → autonomous cap → ALLOW. Order encodes priority.
- `reputation.js` — verified-history scorer. Reads every envelope on the topic
  via mirror REST, drops any `SETTLEMENT` whose `txId` doesn't verify
  (transaction failed, missing, or transfer set doesn't match the envelope's
  claim), scores the remainder on **count / volume / recency / verifiability**
  with a denial penalty.
- `policy.js` — combines rules + reputation. High score raises the effective
  autonomous cap (up to the hard cap), low score shrinks it. Poor-verifiability
  beats thin-history beats the rule engine.
- `tools.js` — exposes:
  - `sentinel_get_counterparty_reputation`
  - `sentinel_evaluate_payment`
  - `sentinel_record_policy_decision`
  - `sentinel_record_settlement`
  - `sentinel_record_denial`
  - `sentinel_get_verified_ledger`
- `index.js` — `createSentinelPlugin({ mirror, topicId, policy })` factory
  returning a kit-compatible `Plugin`.

### Hedera layer — `src/hedera/`
- `envelope.js` — versioned (v1), Zod-validated, discriminated-union schema for
  `QUOTE / POLICY_DECISION / SETTLEMENT / DENIAL`. Decoder returns `null` for
  non-Sentinel messages so the engine shrugs off topic spam.
- `mirror.js` — thin REST client. `verifyTransaction(txId)` returns a
  SUCCESS/FAIL summary + transfer set; `matchesExpectedTransfer()` asserts the
  right amount moved between the right parties.
- `hcs.js` — `createSentinelTopic`, `submitEnvelope` (validates first),
  `readEnvelopes` (via mirror REST — never the operator's privileged read).
- `client.js` — Hedera SDK `Client` builder. Mainnet is refused at the schema
  layer (`src/config.js`).

### Agents — `src/agents/`
- `service-data.js` + `service.js` — the gated service: per-query funding-round
  lookup over 32 publicly-announced rounds. Zod-validated query DSL.
- `seller.js` — issues quotes (with TTL), re-verifies the buyer's `txId`
  against the mirror node **before** answering, refuses to serve the same
  quote twice or settle on stale transactions.
- `buyer.js` — runs the full flow: quote → evaluate → ALLOW/DENY/ESCALATE →
  transfer (kit `transfer_hbar_tool`, AUTONOMOUS or RETURN_BYTES) → settle →
  post envelopes.

### Server / UI — `src/server/`
- Express app exposing the buyer flow + an x402-gated seller endpoint + SSE
  for live updates.
- Vanilla HTML/JS frontend; three panels: build a request, see the policy
  decision (with rule + reputation chip), see the ledger with red-flagged
  unverified rows.

### MCP + x402 layer
- `src/mcp-server.js` — runs the kit's `HederaMCPToolkit` with the Sentinel
  plugin attached, over stdio. Every Sentinel tool is auto-registered.
- `src/x402-client.js` — minimal x402 client (402 → quote → settle → retry
  with `X-Payment` header).
- `scripts/x402-demo.js` — end-to-end demo that exercises the seller
  endpoint over real HTTP.

---

## Running it

### Prerequisites
- Node.js ≥ 20
- A Hedera **testnet** account (free at <https://portal.hedera.com/dashboard>),
  ECDSA key. For the realistic demo create a second testnet account for the seller.
- An LLM API key (Groq free tier by default; OpenAI also supported).

### One-time setup
```bash
git clone https://github.com/alantgoff/sentinel.git
cd sentinel
npm install
cp .env.example .env
# fill in BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY (+ seller pair, + GROQ_API_KEY) in .env
```

### Smoke tests (run these first)
```bash
npm run smoke:balance   # logs the resolved AgentMode enum + queries your testnet balance
npm run smoke:hcs       # creates a Sentinel topic + posts a test envelope.
                         # Prints SENTINEL_TOPIC_ID=… — paste into .env.
```

### Run the demo
```bash
npm start               # http://localhost:3000
```

In the UI:
1. Build a query (sector / company / min round size / date) and submit.
2. Watch the policy decision land. First few requests against a fresh
   counterparty → `ESCALATE` (thin history). Approve to settle. After ≥ 3
   verified settlements the cap relaxes.
3. Drag the "min round size" up to trigger above-cap → `ESCALATE` on amount.
4. Try the same flow from `scripts/x402-demo.js` — same outcome, over a real
   HTTP 402 challenge/response.

### Tests
```bash
npm test                # 61 tests; mocked mirror + pure rule engine.
                         # No testnet creds required.
```

### MCP integration
```bash
npm run mcp             # stdio MCP server. Connect from Claude Desktop /
                         # Anthropic SDK / Cursor / any MCP client.
```

Step-by-step Claude Desktop setup (incl. the JSON config block) is in
[`docs/MCP_SETUP.md`](./docs/MCP_SETUP.md). Once attached, Claude can call
`sentinel_evaluate_payment`, `sentinel_get_counterparty_reputation`,
`transfer_hbar_tool`, etc. directly — same trust boundary as the local agent
(mainnet refused, above-cap spend forces RETURN_BYTES).

---

## Deployment (90-day live requirement)

The bounty requires a publicly-interactive URL that stays live for 90 days past the
deadline. The included [`render.yaml`](./render.yaml) configures Render.com:

1. Push this repo to GitHub.
2. In Render: **New +** → **Web Service** → point at the repo. Render reads
   `render.yaml`.
3. Set the secrets in the Render dashboard (never commit them):
   `BUYER_ACCOUNT_ID`, `BUYER_PRIVATE_KEY`, `SELLER_ACCOUNT_ID`,
   `SELLER_PRIVATE_KEY`, `GROQ_API_KEY`, `SENTINEL_TOPIC_ID`, `PUBLIC_BASE_URL`.
4. Deploy. Health check: `/healthz`.

Free tier spins down after ~15 min idle (fine — grader's first visit wakes it).
For a guaranteed-on instance use a paid plan.

---

## Trust boundary — read this

The HCS log is **an index, not proof**. Only the on-chain HBAR transfers are
ground truth. Reputation is computed only over the mirror-node-verified subset.
Policy is enforced **before** signing; mainnet is refused.

Full discussion of what we do *not* claim (Sybil resistance, identity, calibrated
fraud probability, replay defenses) is in [`LIMITATIONS.md`](./LIMITATIONS.md).

---

## Hedera Agent Kit feedback

Sentinel had to wrap the kit's payment tools with a policy/guardrail layer outside
the kit. The credible gap and a proposed pre-sign-interceptor hook + optional
reputation interface are in [`docs/FEEDBACK_ISSUE.md`](./docs/FEEDBACK_ISSUE.md),
which is the source for the required GitHub issue on
[hashgraph/hedera-agent-kit-js/issues](https://github.com/hashgraph/hedera-agent-kit-js/issues).

---

## License

MIT. Third-party deps are declared in [`package.json`](./package.json) — primarily
`hedera-agent-kit`, `@hashgraph/sdk`, the `@langchain/*` family, `@modelcontextprotocol/sdk`,
`express`, and `zod`.
