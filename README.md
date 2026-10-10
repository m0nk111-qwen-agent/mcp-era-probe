# mcp-era-probe

**Which MCP protocol eras does your server actually serve?**

A zero-dependency Node script that sends your MCP server a real `initialize`
handshake for each known protocol version ("era") and reports what it accepted /
downgraded / rejected — over **stdio** or **streamable-HTTP**.

Eras probed: `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26` (newest first).

## Why

The July 2026 MCP spec revision split the ecosystem into servers that speak the new
era and servers that still negotiate the 2025 eras. The break is **invisible from
inside a server project**: a migrated server compiles, passes its default-client
tests, answers the Inspector — and yet only serves the 2025 era
([typescript-sdk#2977](https://github.com/modelcontextprotocol/typescript-sdk/issues/2977)).
Version-negotiation bugs are an active failure class
([#2969](https://github.com/modelcontextprotocol/typescript-sdk/issues/2969),
[inspector#2660](https://github.com/modelcontextprotocol/inspector/issues/2660)).

`mcp-era-probe` makes the era your server actually serves visible in one command.

## Usage

```bash
# stdio server (one fresh process per era)
node era-probe.js -- <command that launches your server> [args...]

# streamable-HTTP endpoint (the transport most hosted servers use; Node >= 18)
node era-probe.js --http https://your-host.example/mcp
node era-probe.js --http https://your-host.example/mcp --header "Authorization: Bearer sk-..."
```

Exit code 0 if the probe ran (regardless of results). Add `--strict` to exit 1 when
the server does not serve the `2026-07-28` era verbatim — useful as a CI check for
"this server is era-current".

### v0.3 — `--bogus-check` (the control that catches decorative negotiation)

A server can answer `initialize` with whatever version you claim — echoing the field
without reading it. Such a server "serves" `2026-07-28` verbatim *and* `1999-01-01`
verbatim; every "served" line is fiction. `--bogus-check` asks for two fictional eras
(`1999-01-01`, `2099-01-01`):

- **BLIND ECHO** if the server echoes them → the verdict changes to *negotiation is
  decorative*, and `--strict` fails (an echo is not support).
- **validates** if it answers with a real era (its latest) → per-era results are
  trustworthy.

In a 2026-10-10 census of 78 public MCP endpoints, all 6 servers that "served" the
newest era turned out to be blind echo — the control is not theoretical. See
[census/](census/) for the dated per-endpoint dataset and methodology.

```bash
node era-probe.js --http https://your-host.example/mcp --bogus-check
```

### v0.3 — cohort mode (`era-census.js`)

Run the probe across a cohort of endpoints (a previous scorecard JSON, any
`{results:[{url}]}` shape, or a bare URL list), concurrency-limited, with counters:

```bash
node era-census.js --cohort cohort.json --out census.json --concurrency 10 --bogus-check
```

Counters are computed on copies of the stored arrays — the first sweep mutated
`served` in place via `sort().pop()` and corrupted 66/78 doc arrays while the
counters stayed correct. Per-endpoint failures are data, not crashes.

## Example output

A server built with `@modelcontextprotocol/sdk@1.32.1` + `StdioServerTransport`
(this is the exact shape the official v1→v2 codemod leaves behind —
see `fixtures/v1-stdio`):

```
DOWNGRADE  2026-07-28  -> serves 2025-11-25  (1 tool(s) listed)
ACCEPTED   2025-11-25              (1 tool(s) listed)
ACCEPTED   2025-06-18              (1 tool(s) listed)
ACCEPTED   2025-03-26              (1 tool(s) listed)
---
served verbatim : 2025-11-25, 2025-06-18, 2025-03-26
downgraded to   : 2025-11-25  <- 2026-07-28-era clients will NOT get this era
VERDICT: serves 2025-11-25 only — a 2026-07-28-only client cannot use this server (typescript-sdk#2977 failure class)
```

And the published "v2" npm line, `@modelcontextprotocol/server@2.3.1` (latest as of
2026-10-10), with `serveStdio` — **same result**: it accepts the 2025 eras and
downgrades `2026-07-28` to `2025-11-25` (`fixtures/v2-stdio`). Installing the new
major does not mean getting the new era; that package's exported
`LATEST_PROTOCOL_VERSION` is still `2025-11-25`.

A strict era-current server (positive control, `fixtures/current-only-stdio`):

```
ACCEPTED   2026-07-28    (1 tool(s) listed)
REJECTED   2025-11-25    (error -32602: unsupported protocolVersion ...)
VERDICT: serves the 2026-07-28 era
```

## Streamable-HTTP probing

```bash
node era-probe.js --http https://mcp.deepwiki.com/mcp
```

```
DOWNGRADE  2026-07-28  -> serves 2025-11-25  (HTTP 200 3 tool(s) listed)
ACCEPTED   2025-11-25              (HTTP 200 3 tool(s) listed)
...
VERDICT: serves 2025-11-25 only — a 2026-07-28-only client cannot use this server (typescript-sdk#2977 failure class)
```

Real probe, 2026-10-10: DeepWiki's public endpoint answers `text/event-stream` and
serves the 2025-11-25 era; the 2026-07-28 request is downgraded silently. The tool
handles plain-JSON and SSE responses, stateless and stateful (`Mcp-Session-Id`)
servers, closes granted sessions after the matrix, and reports HTTP status codes on
failure rows.

**Stateful caveat.** A server that allows only one `initialize` per process (the
SDK's own stateful example shape) answers the FIRST handshake fully and then
rejects repeats with `400 "Server already initialized"`. The probe therefore goes
newest-era first — the one handshake it grants is the most informative — and adds a
`note:` line to the verdict when it sees this shape. Its single-session behavior is
itself a real interop hazard: a second client gets `400 Server already initialized`.

## CI example

```yaml
# .github/workflows/era.yml — fail the build when the server is not era-current
name: mcp-era
on: [push]
jobs:
  era:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - name: probe the server's protocol era
        run: node path/to/era-probe.js --strict -- node dist/server.js
        # put --strict BEFORE the "--" separator: everything after -- goes to the server
        # for a hosted HTTP endpoint use: node era-probe.js --http $MCP_URL --strict
```

## Era badge

Put the probe's verdict in your README as a one-liner your users can check:

```md
**MCP protocol era:** ![serves 2025-11-25](https://img.shields.io/badge/MCP%20era-2025--11--25-orange)
# (green badge when the verdict line reads "serves the 2026-07-28 era")
```

Generate it from the JSON summary line's `verdict` field; `--strict` in CI keeps it
honest.

## Fixtures

```bash
cd fixtures/v1-stdio && npm install && cd ../..
node era-probe.js -- node fixtures/v1-stdio/server.js
node era-probe.js -- node fixtures/v2-stdio/server.js          # the published v2 line
node era-probe.js -- node fixtures/current-only-stdio/server.js # positive control
```

- `fixtures/v1-stdio` — pre-2026 shape: `@modelcontextprotocol/sdk` (v1 line) + `StdioServerTransport`
- `fixtures/v2-stdio` — published v2 npm line: `@modelcontextprotocol/server@2.3.1` + `serveStdio` (note the factory API)
- `fixtures/current-only-stdio` — dependency-free server that serves `2026-07-28` only (positive control)
- `fixtures/v1-http` — the same v1-line SDK over streamable-HTTP, stateless (fresh transport per POST — the canonical SDK stateless pattern): **same silent downgrade**
- `fixtures/v1-http-stateful` — the SDK's stateful shape (one transport, session id granted): **one initialize per process, then `400 "Server already initialized"`**
- `fixtures/current-only-http` — dependency-free HTTP server that serves `2026-07-28` verbatim (positive control)

## Scope and caveats

- The probe performs real handshakes, then a `tools/list` to confirm liveness — a
  server that answers `initialize` but cannot serve tools is reported as
  `served-no-live`.
- "Accepted" means the server negotiated that era verbatim and stayed live; it is a
  compatibility floor, not a conformance suite.
- HTTP mode sends one small POST per era (plus the follow-ups) — no tool calls, no
  server data read.

## Status

v0.2 (2026-10-10): adds streamable-HTTP probing (stateless + stateful, JSON + SSE
responses), newest-first ordering, session cleanup, HTTP status reporting. v0.1
(2026-10-10): stdio probing. Single file, no dependencies, MIT.
Built by [Pennyforge](https://pennyforge.org) — a one-person studio that builds small, verifiable tools.
Found a wrong verdict? Open an issue.
