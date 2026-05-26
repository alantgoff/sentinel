# Feedback issue — paste this into hashgraph/hedera-agent-kit-js

> **Title:** Spend tools are stateless and trust-blind — no counterparty risk / reputation primitive

## Body

The v3 kit's payment surface (`transfer_hbar_tool`, `transfer_fungible_token_tool`, `airdrop_fungible_token_tool`, the allowance variants) is purely about *executing* transfers. None of them carry counterparty risk context — there's no per-counterparty cap, no rolling velocity check, no allowlist/denylist, no "have I ever settled cleanly with this account before" lookup.

For autonomous agent-to-agent payments this is a real gap. Every builder who wants the kit's AUTONOMOUS mode to be safe for agent-to-agent commerce ends up reimplementing the same guard logic outside the kit. We hit it building **[Sentinel](https://github.com/alantgoff/sentinel)** ([commit log](https://github.com/alantgoff/sentinel/commits/main); shipped for the Bounty 5 Policy Agent track), where the value proposition *is* "counterparty-aware payments" — so we had to build:

- A rule engine: per-counterparty cap, daily limit, rolling velocity window, service allowlist, denylist, hard cap, escalation threshold ([src/plugin/rules.js](https://github.com/alantgoff/sentinel/blob/main/src/plugin/rules.js)).
- A reputation scorer that re-verifies HCS-claimed settlements against the mirror node and only counts the verified subset ([src/plugin/reputation.js](https://github.com/alantgoff/sentinel/blob/main/src/plugin/reputation.js)).
- A policy combiner that bumps or shrinks the effective autonomous cap based on the score ([src/plugin/policy.js](https://github.com/alantgoff/sentinel/blob/main/src/plugin/policy.js)).
- The whole thing has to be wired in **before** the kit signs, which means we wrap the kit's transfer tools with our own plugin tools (`sentinel_evaluate_payment`, `sentinel_record_settlement`, etc.) instead of using the kit's tools directly. That's the give-away: there's no clean hook to enforce policy *inside* the kit.

## Two concrete proposals

### A. A pre-sign interceptor

Right now `ExecuteStrategy.handle(tx, client, context)` is the single chokepoint where every transaction is signed and submitted. A trivially small addition makes guardrails first-class:

```ts
interface Configuration {
  // ...existing fields...
  guard?: (
    method: string,
    params: unknown,
    context: Context,
  ) => Promise<GuardResult> | GuardResult;
}

type GuardResult =
  | { allow: true }
  | { allow: false; reason: string; mode?: 'deny' | 'escalate' };
```

Called from `ExecuteStrategy.handle` just before `tx.execute(client)`. On `{ allow: false, mode: 'escalate' }` the strategy degrades to `RETURN_BYTES` for that single call. On `{ allow: false, mode: 'deny' }` it throws. Apps already running on AUTONOMOUS keep working with `guard` returning `{ allow: true }`.

This makes "safe autonomous spend" a one-line addition to existing kit code instead of an entire plugin re-implementation.

### B. An optional reputation interface

```ts
interface CounterpartyReputation {
  getScore(account: string): Promise<{ score: number; verifiedCount: number; reasons: string[] }>;
}
```

Backable by HCS (our default), by an off-chain DB, or by nothing. The kit could ship a reference `HCSReputation` implementation that reads a topic, re-verifies referenced tx ids against the mirror node, and returns a score — exactly the pattern we ended up implementing.

If `guard` is in the kit and `CounterpartyReputation` is composable into it, builders get to wire "consult reputation → decide → execute" without leaving the kit's API surface.

## Why this matters for the agent economy

The whole pitch of agent-to-agent payments is autonomy. The whole risk of autonomy is the wrong agent (or a compromised one) draining funds. Today the kit's answer is "use AUTONOMOUS for trusted flows, RETURN_BYTES for everything else." That's binary; real systems need *per-counterparty* gradients. Adding a guard hook turns the kit from a payment library into a payment *policy* library — which is what every serious deployment is already building on top.

Happy to open a PR with a starting point for A if there's interest.
