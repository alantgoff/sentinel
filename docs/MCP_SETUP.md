# Sentinel via MCP

Sentinel ships an MCP server ([`src/mcp-server.js`](../src/mcp-server.js)) that
exposes the **kit's built-in tools** *and* the **Sentinel plugin tools** (policy
+ reputation) to any [Model Context Protocol](https://modelcontextprotocol.io/)
client — Claude Desktop, the Anthropic SDK with MCP enabled, Cursor, custom
agents over the MCP Python/TS SDKs, etc.

The kit's `HederaMCPToolkit` auto-registers every loaded plugin's tools, so
once you point Claude Desktop at this binary you get a single coherent tool
surface:

| Kit (built-in)                           | Sentinel (this plugin)                       |
|------------------------------------------|----------------------------------------------|
| `transfer_hbar_tool`                     | `sentinel_evaluate_payment`                  |
| `get_hbar_balance_query_tool`            | `sentinel_get_counterparty_reputation`       |
| `create_topic_tool`, `submit_topic_message_tool` | `sentinel_record_policy_decision`    |
| `get_topic_messages_query_tool`          | `sentinel_record_settlement`                 |
| …(see `npm run smoke:balance` for full list)…    | `sentinel_record_denial`             |
|                                          | `sentinel_get_verified_ledger`               |

## Quick start

### Prerequisites
- A working `.env` (see [`../README.md`](../README.md)). The MCP server needs
  the same `BUYER_*` + `SENTINEL_TOPIC_ID` you use for `npm start`.
- Node ≥ 20 (`node --version`).

### Run it from a terminal first

```bash
npm run mcp
```

You should see `Sentinel MCP server connected via stdio.` on stderr and then
silence on stdout (stdout is reserved for the MCP wire protocol). Press
`Ctrl+C` to stop.

If you don't see that line, the server failed to boot — usually a missing
env var. Run `npm run smoke:balance` first to validate config.

### Connect Claude Desktop

Edit Claude Desktop's MCP config (location varies by OS):

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Add a `mcpServers.sentinel` entry. Replace the path and the env values with
your own — secrets go here, not in any committed file:

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "node",
      "args": ["/absolute/path/to/sentinel/src/mcp-server.js"],
      "env": {
        "BUYER_ACCOUNT_ID": "0.0.xxxxxx",
        "BUYER_PRIVATE_KEY": "0x…",
        "SELLER_ACCOUNT_ID": "0.0.yyyyyy",
        "SELLER_PRIVATE_KEY": "0x…",
        "HEDERA_NETWORK": "testnet",
        "MIRROR_NODE_URL": "https://testnet.mirrornode.hedera.com",
        "SENTINEL_TOPIC_ID": "0.0.zzzzzz",
        "DEFAULT_AUTONOMOUS_CAP_HBAR": "2",
        "DEFAULT_DAILY_LIMIT_HBAR": "20",
        "DEFAULT_VELOCITY_WINDOW_SECONDS": "300",
        "DEFAULT_VELOCITY_MAX_TXNS": "5"
      }
    }
  }
}
```

Quit and reopen Claude Desktop. In a new chat, you should see a hammer/tool
icon — clicking it shows the full Sentinel + kit tool surface.

### Try a prompt

> "Before I pay 0.0.9063279, what does Sentinel know about them? If they have
> a clean record, transfer 1 HBAR. Otherwise show me the reputation profile
> and ask for my approval."

Claude should:

1. Call `sentinel_get_counterparty_reputation` with `counterparty: "0.0.9063279"`.
2. Read the verified-settlement count and the score.
3. Either call `sentinel_evaluate_payment` + `transfer_hbar_tool` autonomously,
   or surface the profile and wait for your confirmation.

You can confirm it actually happened by reopening the Sentinel UI
(`npm start`, http://localhost:3000) — any settlements posted by Claude
appear in the verified ledger.

## Other MCP clients

The server speaks the standard MCP JSON-RPC protocol over stdio. Anything
implementing the protocol can attach:

- **Anthropic SDK** — see the
  [MCP integration docs](https://docs.anthropic.com/en/docs/build-with-claude/mcp).
- **Cursor / Continue / other IDE assistants** — add the same `command` +
  `args` + `env` block in their MCP settings UI.
- **Your own LangGraph agent** — use `@langchain/mcp-adapters` (already in
  the kit's deps) to import the MCP tools into a LangChain agent. The kit's
  `HederaLangchainToolkit.getMcpTools()` method demonstrates the pattern.

## Security model

Sentinel-via-MCP runs with the **same trust boundary** as the local agent:

- The keys in `env` are operator keys. They sign transfers from your accounts.
- Treat the MCP server like a payment terminal. Don't ship the config block
  with keys to anyone.
- Mainnet is refused at the schema layer (see [`../LIMITATIONS.md`](../LIMITATIONS.md)
  §7). Even with mainnet keys in the env, the server will fail to start.
- Above-cap spend triggers `AgentMode.RETURN_BYTES` — the kit hands back
  unsigned bytes and waits for a human signature. This is automatic; you
  don't have to configure it.
