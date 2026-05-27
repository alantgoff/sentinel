# Aegis via MCP

Aegis ships an MCP server ([`src/mcp-server.js`](../src/mcp-server.js)) that
exposes the **kit's built-in tools** *and* the **Aegis plugin's tools**
(pricing + issuance + settlement) to any
[Model Context Protocol](https://modelcontextprotocol.io/) client — Claude
Desktop, the Anthropic SDK with MCP enabled, Cursor, custom agents over the
MCP Python/TS SDKs.

The kit's `HederaMCPToolkit` auto-registers every loaded plugin's tools, so
once you point Claude Desktop at this binary you get one coherent surface:

| Kit (built-in)                  | Aegis (this plugin)                |
|---------------------------------|------------------------------------|
| `transfer_hbar_tool`            | `aegis_quote_policy`               |
| `get_hbar_balance_query_tool`   | `aegis_issue_policy`               |
| `submit_topic_message_tool`     | `aegis_record_price_ref`           |
| `get_topic_messages_query_tool` | `aegis_settle_policy`              |
|                                 | `aegis_post_provider_capacity`     |
|                                 | `aegis_pool_status`                |
|                                 | `aegis_list_policies`              |
|                                 | `aegis_get_price_params`           |

## Quick start

### Prerequisites
- A working `.env` (see [`../README.md`](../README.md)). The MCP server needs
  the same testnet credentials + `AEGIS_TOPIC_ID` you use for `npm start`.
- Node ≥ 20.

### Run it from a terminal first

```bash
npm run mcp
```

You should see `Aegis MCP server connected via stdio.` on stderr and then
silence on stdout (stdout is reserved for the MCP wire protocol). Press
`Ctrl+C` to stop.

### Connect Claude Desktop

Edit Claude Desktop's MCP config (location varies by OS):

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Add an `mcpServers.aegis` entry. Replace the path + env values with your
own — secrets go here, not in any committed file:

```json
{
  "mcpServers": {
    "aegis": {
      "command": "node",
      "args": ["/absolute/path/to/aegis/src/mcp-server.js"],
      "env": {
        "BUYER_ACCOUNT_ID": "0.0.xxxxxx",
        "BUYER_PRIVATE_KEY": "0x…",
        "UNDERWRITER_ACCOUNT_ID": "0.0.yyyyyy",
        "UNDERWRITER_PRIVATE_KEY": "0x…",
        "HEDERA_NETWORK": "testnet",
        "MIRROR_NODE_URL": "https://testnet.mirrornode.hedera.com",
        "AEGIS_TOPIC_ID": "0.0.zzzzzz",
        "DEFAULT_R0_USD_HR": "2.50",
        "MAX_EXPOSURE_RATIO": "0.5",
        "PAYOUT_AUTONOMOUS_CAP_HBAR": "10"
      }
    }
  }
}
```

Quit and reopen Claude Desktop. In a new chat the tool icon should list
Aegis + kit tools.

### Try a prompt

> "I want a 30-day cap on H100 rentals at $4/hr for 10 GPU-hours. Quote
> it first using cvar risk loading; tell me the expected payout, the
> CVaR_95, the probability it pays out, and the variance-reduction factor
> the pricer reports. If the premium is under 5 HBAR, issue the policy."

Claude will typically:

1. Call `aegis_quote_policy { strikeUsdHr: 4, qtyGpuHr: 10, windowDays: 30 }`.
   The pricer runs antithetic-pair Monte Carlo with CVaR risk loading by
   default; the result includes `expectedPayoutHbar`, `riskLoadHbar`,
   `cvarHbar`, `probInTheMoney`, `varianceReductionFactor`, and
   `usedEstimator` so the agent has everything it needs to reason.
2. Inspect the quote.
3. If acceptable, call `transfer_hbar_tool` to pay the underwriter, then
   `aegis_issue_policy` with the resulting tx id. Behind the scenes the
   plugin runs the **joint-VaR exposure check** over the current active
   policy basket plus this one; if the 99% quantile would breach the pool
   cap the issuance refuses with the actual VaR number in the error.
4. Summarize: policyId, exposure book state, what would trigger payout.

For audit: `aegis_get_price_params` returns the active params plus BOTH
the method-of-moments and EM calibrations on the bundled H100 history —
including the per-month posterior jump probabilities — so the agent can
explain the underwriter's pricing assumptions.

You can verify everything happened by opening the Aegis UI (`npm start`,
http://localhost:3000) and watching the new POLICY envelope appear in the
ledger, with the tx id linking out to HashScan.

## Other MCP clients

The server speaks standard MCP JSON-RPC over stdio. Anything implementing
the protocol attaches:

- **Anthropic SDK** — see
  [MCP integration docs](https://docs.anthropic.com/en/docs/build-with-claude/mcp).
- **Cursor / Continue / other IDE assistants** — same `command` + `args` +
  `env` block in their MCP settings UI.
- **Your own LangGraph agent** — use `@langchain/mcp-adapters` (already in
  the kit's deps) to import these tools into a LangChain agent. The kit's
  `HederaLangchainToolkit.getMcpTools()` demonstrates the pattern.

## Security model

Aegis-via-MCP runs with the **same trust boundary** as the local agent:

- The keys in `env` are operator keys; they sign HBAR transfers from your
  accounts. Treat the MCP server like a payment terminal — don't ship the
  config block with keys to anyone.
- **Mainnet is refused at the schema layer** (see [`../LIMITATIONS.md`](../LIMITATIONS.md)).
  Even with mainnet keys in the env, the server fails to start.
- Above the configured payout-autonomous cap, settlements switch to
  `AgentMode.RETURN_BYTES` — the kit hands back unsigned bytes and waits
  for a human signature. Automatic; nothing to configure.
- The price feed is locally simulated and labeled `sim:labeled` /
  `sim:shock`. The PRICE_REF envelope schema enforces the source label —
  there's no code path that posts an unlabeled feed claim, by construction.
