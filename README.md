# mcp-era-probe

**Which MCP protocol eras does your server actually serve?**

A zero-dependency Node script that launches your MCP stdio server once per known
protocol version ("era"), sends a real `initialize` handshake for each, and reports —
per era — whether the server **accepted** it, **downgraded** it to an older version,
or **rejected** it.

Eras probed: `2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`.

## Why

The July 2026 MCP spec revision split the ecosystem into servers that speak the new
era and servers that still negotiate the 2025-11-25 era. The break is **invisible from
inside a server project**: a migrated server compiles, passes its default-client tests,
answers the Inspector — and yet only serves the 2025 era
([typescript-sdk#2977](https://github.com/modelcontextprotocol/typescript-sdk/issues/2977)).
Version-negotiation bugs are an active failure class
([#2969](https://github.com/modelcontextprotocol/typescript-sdk/issues/2969),
[inspector#2660](https://github.com/modelcontextprotocol/inspector/issues/2660)).

`mcp-era-probe` makes the era your server actually serves visible in one command.

## Usage

```bash
node era-probe.js -- <command that launches your MCP stdio server> [args...]
```

Exit code 0 if the probe ran (regardless of results). Add `--strict` to exit 1 when
the server does not serve the `2026-07-28` era verbatim — useful as a CI check for
"this server is era-current".

## Example output

A server built with `@modelcontextprotocol/sdk@1.32.1` + `StdioServerTransport`
(this is the exact shape the official v1→v2 codemod leaves behind —
see `fixtures/v1-stdio`):

```
ACCEPTED   2025-03-26    (1 tool(s) listed)
ACCEPTED   2025-06-18    (1 tool(s) listed)
ACCEPTED   2025-11-25    (1 tool(s) listed)
DOWNGRADE  2026-07-28  -> serves 2025-11-25
---
served verbatim : 2025-03-26, 2025-06-18, 2025-11-25
downgraded to   : 2025-11-25  <- 2026-07-28-era clients will NOT get this era
VERDICT: serves 2025-11-25 only — a 2026-07-28-only client cannot use this server (typescript-sdk#2977 failure class)
```

And the published "v2" npm line, `@modelcontextprotocol/server@2.3.1` (latest as of
2026-10-10), with `serveStdio` — **same result**: it accepts the 2025 eras and
downgrades `2026-07-28` to `2025-11-25` (`fixtures/v2-stdio`). Installing the new
major does not mean getting the new era; that package's exported
`LATEST_PROTOCOL_VERSION` is still `2025-11-25`.

A strict era-current server (positive control, `fixtures/current-only-stdio`)
looks like this:

```
REJECTED   2025-03-26    (error -32602: unsupported protocolVersion 2025-03-26; this server serves 2026-07-28 only)
REJECTED   2025-06-18    (error -32602: ...)
REJECTED   2025-11-25    (error -32602: ...)
ACCEPTED   2026-07-28    (1 tool(s) listed)
VERDICT: serves the 2026-07-28 era
```

## Fixtures

```bash
cd fixtures/v1-stdio && npm install && cd ../..
node era-probe.js -- node fixtures/v1-stdio/server.js
```

- `fixtures/v1-stdio` — pre-2026 shape: `@modelcontextprotocol/sdk` (v1 line) + `StdioServerTransport`
- `fixtures/v2-stdio` — published v2 npm line: `@modelcontextprotocol/server@2.3.1` + `serveStdio` (note the factory API)
- `fixtures/current-only-stdio` — dependency-free server that serves `2026-07-28` only (positive control)

## Scope and caveats

- **stdio only for now.** Streamable-HTTP probing (per-request era reporting) is the
  obvious next step; PRs welcome.
- The probe performs real handshakes against a fresh process per era, then a
  `tools/list` to confirm liveness — a server that answers `initialize` but cannot
  serve tools is reported as `served-no-live`.
- "Accepted" means the server negotiated that era verbatim and stayed live; it is a
  compatibility floor, not a conformance suite.

## Status

v0.1 (2026-10-10), single file, no dependencies, MIT.
Built by [Pennyforge](https://pennyforge.org) — a one-person studio that builds small, verifiable tools.
Found a wrong verdict? Open an issue.
