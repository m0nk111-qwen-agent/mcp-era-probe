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

### v0.7 — `--behavior`: era-gated read-only behavior checks (HTTP)

```bash
node era-probe.js --http https://your-host.example/mcp --discover --behavior
```

Adds a `behavior` block + `BEHAVIOR-*` lines, all read-only (no tool execution, no
state mutation), each labeled observation vs compliance:

- **origin-403 control pair** (2025-11-25 Streamable HTTP): the same initialize is
  sent WITH `Origin: https://evil.example.invalid` and WITHOUT any Origin; the
  verdict `strict` counts ONLY if the control passes and the spoofed one gets 403 —
  auth/WAF walls that 403 everything report `control-also-403 (no signal)`.
- **stateless tools/list x2 @2026-07-28** (`_meta` per-request version + Mcp-Method/
  Mcp-Name headers): tool count, `resultType` presence (**observation** — MRTR
  defines resultType for tool execution; list-endpoint emission is not a MUST, and
  "absent = complete" means absence is compliant), order stability within the run
  (**not** proof of spec determinism across restarts).
- **bogus cursor**: fictional cursor string → error vs ignored (diversity data; no
  MUST defines invalid-cursor behavior).
- **removed-method probe**: `ping` was REMOVED in 2026-07-28. `-32601` means "no
  ping handler" — consistent with a strict modern server OR a minimal legacy one;
  the label says exactly that (ambiguous without `--discover`).
- **missing-version probe**: stateless request with NO `_meta` protocolVersion —
  separates stateless-strict (`-32022` demanded) from lenient (accepted).

Methodology disclosures (do not skip when publishing results): era-gate every
check to the server's self-declared era (mixed-era scoring is the #1 false-positive
source); actively-sent probes are logged by targets — keep request volume low and
consistent; results are point-in-time and latency/network confounded (rate-limit
429s are transport noise, not verdicts); `read-only` ≠ `side-effect-free`.

First behavior sweep (2026-10-10, 40 servers from the discover census):
`census/behavior-sweep-2026-10-10/` — `resultType: complete` appeared on exactly
the 7 verified strict-modern servers and nowhere else in the cohort (a clean
empirical discriminator, not a compliance verdict); Origin-strict did NOT track
modern-era-ness (9 origin-strict servers include hollow and legacy ones); no
server in the cohort demanded `-32022` for a MISSING version — strictness showed
up only on contradictory versions.

stdio sweep (`census/behavior-sweep-2026-10-10/stdio/`): `--behavior` works over
stdio too (one extra spawn, discover-first so modern-only servers are profiled).
The single modern server in the npm cohort (@upstash/context7-mcp) is also the
strictest: it ERRORS on a version-less request (`-32602`) instead of accepting it,
still answers `resultType: complete`, and answers a fictional cursor. The legacy
majority answers ping (compat tolerance), omits resultType, and accepts missing
versions. Note: context7 rejects removed `ping` with -32602 (invalid params),
not -32601 — error-code choice is server-specific; treat codes as diversity data.

### v0.5 — `constant-answer` verdict (spec-compliant fallback ≠ echo)

The fictional-era control distinguishes three post-echo shapes, and v0.5 labels them
explicitly (spec, basic lifecycle: an unsupported requested version may be answered
with *another version the server supports*):

- **BLIND ECHO** — answers the fictional era with the fictional era: false claims, negotiation decorative (typescript-sdk#2977 variant).
- **constant-answer** — answers EVERY era (real and fictional) with one fixed old era: the field never varies with the request; negotiation fully decorative (fixture `fixtures/stdio-constant-answer.js`).
- **negotiates-known + bogus-fallback** — serves known eras verbatim, answers fictional eras with its own latest: spec-compliant; the field carries true information but no validation signal.

All three validated via fixtures; the 2026-10-10 npm stdio census (`census/stdio-npm-2026-10-10.md`)
used v0.5-classification post-hoc on v0.4 data (16 popular packages: 0 echo, 1 constant-answer,
9 negotiates-known, 6 spawn-fail without credentials, 16/16 strict-fail).

### v0.4 — `--bogus-check` now covers stdio too

v0.3 wired the fictional-era control into the `--http` path only — on stdio the flag
was accepted but silently ignored, so a stdio blind echo (e.g. a setup shim like the
one [@autenai](https://dev.to/pennyforgehq/title-your-mcp-server-compiles-passes-its-tests-answers-the-inspector-and-still-speaks-the-20lp#comment-3h5h7)
shipped in 0.1.3) still got a plain `ACCEPTED`. v0.4 runs the same two fictional-era
handshakes through `probeEraStdio`; stdio fixtures (`fixtures/stdio-echo-shim.js`,
`fixtures/stdio-validating.js`) validate both outcomes:

- echo-shim: `BOGUS-CHECK: BLIND ECHO`, verdict = decorative-negotiation variant, `--strict` exits 1
- validating server: fictional eras rejected (`answered nothing, nothing`), verdict = DOWNGRADE, `--strict` exits 1 (it does not serve the newest era)

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
