# Feedback issue — paste this into hashgraph/hedera-agent-kit-js

> **Title:** Payment tools lack a pre-sign risk/policy hook and counterparty/exposure context

## Body

The v3 kit's payment surface (`transfer_hbar_tool`, `transfer_fungible_token_tool`, `airdrop_fungible_token_tool`, the allowance variants) is purely about *executing* transfers. There's no:

1. **Pre-sign interceptor** for enforcing per-transaction policy (caps, exposure, counterparty risk, time-of-day rules) without forking the kit;
2. **External-risk interface** so a plugin can consult, say, an HCS-backed reputation ledger or an on-chain exposure book *before* the sign step;
3. **First-class concept of "what does the operator owe?"** for systems where the operator is an underwriter / pool / lender rather than a single user.

For autonomous agent-to-agent flows — and especially for underwriters, lenders, and other risk-bearing agents — this is a real gap. Every builder who wants `AgentMode.AUTONOMOUS` to be safe ends up reimplementing the same guard logic outside the kit.

We hit it building **[Aegis](https://github.com/alantgoff/aegis)** ([commits](https://github.com/alantgoff/aegis/commits/main); shipped for the Bounty 5 Policy Agent track), which sells cost-cap options on H100 GPU-hour rentals — pricing is regime-switching jump-diffusion with antithetic-variates Monte Carlo and CVaR risk loading; calibration is Press-Ball-Torous EM; settlement is Asian-style trailing TWAP; pool exposure is the **99% joint-payout VaR** over all active+proposed policies under stressed regime sampling. The value proposition *is* "we won't pay out more than we can cover", so we had to build:

- A **joint-payout VaR exposure book** that samples R_T from the stressed regime, evaluates each active policy's payout function (K, Q) against the joint draw, and refuses to issue a new policy whose 99% quantile of basket payout would push the pool over the configured cap ([`src/pool/exposure.js`](https://github.com/alantgoff/aegis/blob/main/src/pool/exposure.js), `checkIssuanceJointVaR`). This is the Solvency-II-style risk aggregation; the kit's payment tools have no awareness of operator-level exposure at all.
- A **two-toolkit dance** where the underwriter constructs both an `AgentMode.AUTONOMOUS` and an `AgentMode.RETURN_BYTES` `HederaLangchainToolkit` against the same client, and our agent code branches between them based on payout magnitude ([`src/agents/underwriter.js`](https://github.com/alantgoff/aegis/blob/main/src/agents/underwriter.js)). It works but it's awkward — the right answer is for the kit to know about a payout-cap policy and *itself* downgrade to RETURN_BYTES when it fires.
- **Independent verification of every premium transfer on the mirror node before issuance** ([`src/plugin/tools.js` aegis_issue_policy](https://github.com/alantgoff/aegis/blob/main/src/plugin/tools.js)), because we never trust the caller's claim that "the buyer paid me." We also need retry-with-backoff to ride out the standard 2-6s mirror-node lag — every kit user who verifies on the mirror has to write the same loop.

A small additional friction worth flagging: `HederaAgentAPI.run(method, arg)` `JSON.stringify`s the tool result, which mangles `Uint8Array` payloads from the RETURN_BYTES path. We worked around it by calling `tool.execute(client, context, params)` directly — but that's not the documented API. Either fix the serializer (encode `bytes` as base64) or document `tool.execute` as the supported path for callers that need structured results.

## Two concrete proposals

### A. A pre-sign guard hook

`ExecuteStrategy.handle(tx, client, context)` is the single chokepoint where every transaction is signed and submitted. A tiny addition makes guardrails first-class:

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

Called from `ExecuteStrategy.handle` just before `tx.execute(client)`. On `{ allow: false, mode: 'escalate' }` the strategy degrades to RETURN_BYTES for that single call. On `{ allow: false, mode: 'deny' }` it throws with the reason. Apps already on AUTONOMOUS keep working with the default no-op guard.

This single hook would have removed Aegis's "two toolkits + branch in agent code" pattern entirely.

### B. An external-context interface

```ts
interface AgentContextExt {
  preTransfer?: (info: { from: string; to: string; amountTinybar: bigint; memo?: string }) => Promise<void>;
  // ...additional hook points (preTokenTransfer, preTopicMessage, etc.)
}
```

Each plugin can register one. The kit calls them in order before the guard fires. This is what lets you compose "reputation lookup" + "exposure check" + "rate limit" + "spend cap" cleanly, without each guard re-walking the configuration tree.

If `guard` is the policy gate and `preTransfer` is the data feed, builders get to wire "consult external state → decide → execute" without leaving the kit's API surface.

## Why this matters

Agent-to-agent payments at scale are about *autonomy with bounded risk*. The kit today is great at "execute this transfer"; it's silent on "should this transfer execute right now, given everything else this operator is on the hook for." Adding a pre-sign guard turns it from a payment library into a payment *policy* library — which is what every serious deployment is already building on top.

Happy to open a PR with a starting point for A if there's interest.
