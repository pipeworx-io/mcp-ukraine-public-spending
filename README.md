# @pipeworx/ukraine-public-spending

Ukrainian State Treasury payment transactions from spending.gov.ua: who a public body paid, which public bodies paid a supplier, how much and for what, by EDRPOU code. Links a supplier's payments to its ProZorro tenders as labelled candidates.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1745+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ua_spend_payments(recipient_edrpou?, payer_edrpou?, date_from?, date_to?, purpose_contains?, limit?)`: every Treasury payment to and/or from the given EDRPOU codes in a window of up to 92 days. Returns totals, top payers and recipients, and the newest rows (date, amount in UAH, both parties, purpose text, budget and KEKV codes, contract number when recorded).
- `ua_spend_between(payer_edrpou, recipient_edrpou, date_from?, date_to?, limit?)`: payments from one payer to one recipient. Returns `found` true/false, count, total, a per-month breakdown and the rows. `found:false` carries `data_as_of` and a note that the open portal withholds some payers.
- `ua_spend_prozorro_link(supplier_edrpou, date_from?, date_to?, max_payers?)`: the supplier's Treasury receipts, plus, for each of its largest payers, the ProZorro tenders where that payer was the buyer and the supplier took part. Each link is labelled `candidate`, because a shared counterparty does not prove which contract a payment settles.

## Auth

Keyless.

## Data sources

- <https://api.spending.gov.ua/api/v2/api/transactions/>: State Treasury Service of Ukraine (ДКСУ) payment transactions, the API behind spending.gov.ua.
- <https://prozorro.gov.ua/api/search/tenders> (POST): ProZorro's public tender search index, used by `ua_spend_prozorro_link`.

Things measured live on 2026-10-08:

- `payers_edrpous` / `recipt_edrpous` take comma-separated codes; at least one is required, and both together act as an AND.
- A window longer than 92 days is a 400 with a Ukrainian message. Dates must be `YYYY-MM-DD`.
- Rows run about 2 days behind today.
- Payments to private individuals have the recipient code masked as `xxxxxxxxxx` by the Treasury, and digits in purpose text masked as `xxxx`.
- Some payers (for example the Ministry of Defence, 00034022) return an empty list for windows where they certainly paid. Treat empty as "not published", not "no payment".
- The first HTTPS request from a cold Cloudflare Worker can get a 525 from the origin. The pack retries once, then falls back to plain HTTP.
- ProZorro's search rows carry the buyer's name but never its EDRPOU, so the link tool queries `tenderer` + `buyer` together for each payer rather than comparing codes. The `tenderer` filter on its own is fuzzy.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ukraine-public-spending": {
      "url": "https://gateway.pipeworx.io/ukraine-public-spending/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ukraine-public-spending/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1745+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ua_spend_payments \
  -H 'Content-Type: application/json' \
  -d '{"recipient_edrpou":"34315660","date_from":"2026-08-01","date_to":"2026-08-31","limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ua_spend_payments`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ukraine-public-spending": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ukraine-public-spending"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ukraine-public-spending
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ukraine Public Spending data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
