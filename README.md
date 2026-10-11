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
`census/behavior-sweep-2026-10-10/` — `resultType: complete` co-occurred with the
7 verified strict-modern servers and appeared on no other server in the cohort.
This is a CORRELATED FEATURE OF THE MODERN-SPEC SUBSET, not an independent
discriminator: the same current SDKs that implement server/discover are the ones
emitting resultType on list responses (n=7 vs 33; one auth-gated resultType would
break "nowhere else"). Origin-strict (9 servers, 403 on a spoofed-Origin
initialize while the no-Origin control passes) is ORTHOGONAL to modern-era-ness —
4 of the 9 are hollow or legacy. Caveats: a 403 proves a guard exists, not which
era's spec it came from; servers that 403 both variants are "blocked/uninformative"
(auth/WAF/rate-limit — no positive control shown). No HTTP server in the cohort
rejected a MISSING `_meta` protocolVersion; note -32022 is specced for a
present-but-unsupported version, so a missing one may be assume-latest (compliance,
not laxness) — only one server (context7) rejected version-less requests at all,
with -32602 (n=1, server-specific). Cohort caveat: this census pre-filters for
servers that answer server/discover, so any "discriminator" is confounded with
admission criteria; npm stdio packages are a separate population. Tool counts
(1–46) are non-comparable (pagination, auth-gated listings, lazy registration).

stdio sweep (`census/behavior-sweep-2026-10-10/stdio/`): `--behavior` works over
stdio too (one extra spawn, discover-first so modern-only servers are profiled).
Within the npm stdio population, the single modern server (@upstash/context7-mcp)
is also the strictest: it ERRORS on a version-less request (`-32602`) instead of
accepting it, still answers `resultType: complete`, and answers a fictional
cursor. The legacy majority answers ping (compat tolerance), omits resultType,
and accepts missing versions. Note: context7 rejects removed `ping` with -32602
(invalid params), not -32601 — error-code choice is server-specific; treat codes
as diversity data. (Within-population comparison only; see the cohort caveat above.)

Completion sweep (2026-10-11, the 38 servers without 10-10 coverage —
`census/behavior-sweep-2026-10-11/`): the behavior matrix now spans the full
78-server HTTP cohort. Out-of-sample, the correlations hold and stay
correlations: resultType was absent on all 37 probed servers (28 legacy-era,
3 nothing-verbatim, 3 legacy-2025-03, 2 legacy-2025-06, 2 all-handshakes-failed;
1 transport-dead with HTTP 530), so across 78 servers resultType emission still
co-occurs ONLY with verified-modern servers — but the same-SDK confound and the
cohort pre-filter remain, so this stays "correlated feature of the modern-spec
subset", never a discriminator. Origin-strict added 5 more servers (all legacy;
14/78 total, era-mixed — orthogonal to era, confirmed twice). 24/37 still answer
the removed `ping`; 4 reject its modern-shaped request with -32600. 27/37 accept
version-less requests (the assume-latest compliance reading holds; still NO
server anywhere in the cohort rejected a missing protocolVersion, and the only
version-less rejector remains context7's -32602).

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

## v0.8 — the tool-call channel check (`--toolcheck`, 2026-10-11)

The era matrix says *which* protocol revision a server negotiates; the toolcheck asks
the next question: when a tool call goes wrong, **which error channel does the answer
take?** The specs are explicit that the two channels are different things
([2026-07-28 server/tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
"Error Handling", fetched 2026-10-11): **protocol errors** — *unknown tool, malformed
request, server errors* — are standard JSON-RPC errors (the spec's own example is
`-32602 "Unknown tool: invalid_tool_name"`); **tool execution errors** are *results*
with `isError: true`. The same split exists in
[2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and
[2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).
`structuredContent`/`outputSchema` also exist in all three eras.

**Zero-execution by design:** the default probe makes exactly one `tools/call`, and it
targets a tool name that cannot exist (`era-probe-nonexistent-tool`) — nothing on the
server can run. A real execution is opt-in only (`--call-tool NAME --call-args JSON`),
with the operator asserting the tool is read-only.

**Results (2026-10-11, `census/toolcheck-2026-10-11/`, 8 modern-era targets + 3 legacy contrast):**

| target (class) | tools/list @2026-07-28 | unknown tool, modern route | unknown tool, legacy route |
|---|---|---|---|
| mcp.projectory.ae (strict) | 5 tools, **5 declare outputSchema** | protocol `-32602` | — (no legacy session) |
| mcp.goji.agency (strict) | 9 tools | protocol `-32602` | — |
| mcp.botinfo.ai (strict) | 4 tools | protocol `-32602` | — |
| bidclub.ai (strict) | 6 tools | protocol `-32602` | — |
| bizmoon.ai (strict) | 5 tools | protocol `-32602` | — |
| mcp.getle.ad (dual-era) | 35 tools | HTTP 401 (auth-gated calls; list is public) | — |
| api.askmiles.ai (lenient) | 5 tools | **execution** (`isError:true`, `resultType:complete`) | — |
| @upstash/context7-mcp@4.3.0 (stdio, strictest) | 2 tools | protocol `-32602` | — |
| agentberg.ai (legacy contrast, max 2025-11-25) | — (stateless route 400) | — | **result, `isError` false** ("Unknown tool" as text in a *successful* result) |
| mcp.aivonic.ai (legacy contrast) | — | — | execution (`isError:true`) |
| mcp.autonomad.ai (legacy contrast) | — | — | execution ("not available on this connection") |

**What this says (amended after an adversarial review, same day):**

- The verified modern-era cohort answers an unknown tool the way the spec's
  Error Handling section shows: a JSON-RPC protocol error, `-32602` — 6/6 strict
  targets. The one lenient server (askmiles) puts the same condition in the
  *execution* channel, and the three legacy hand-rolled servers all use result
  channels the spec's text reserves for execution errors — worst case agentberg.ai,
  which answers a *successful* result whose text says "Unknown tool". A client keying
  on `isError`/JSON-RPC errors cannot distinguish "no such tool" from a real answer
  there. **Non-independence caveat:** the strict targets answered with identical error
  codes *and* wording, and all sit behind edge proxies (Cloudflare ×5, Vercel, Railway);
  the wording matches a shared SDK lineage — so this is evidence about ~1–2
  implementations behind 8 domains, not 6 independent confirmations. The legacy
  contrast cohort is hand-selected, not a random legacy sample. The driver looks like
  **implementation lineage (SDK vs hand-rolled), not the era label itself** — askmiles
  is a modern-era target and is the deviation case, so "newest = conformant" is *not*
  the right headline and this note does not claim it.
- **Header consistency is enforced where the spec requires it:** on `tools/call` the
  `Mcp-Name` header MUST mirror `params.name`
  ([2026-07-28 streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
  "Standard Request Headers" — REQUIRED for compliance). The first sweep round shipped
  the client name in that header; all five strict-modern HTTP servers rejected it with
  `-32020` ("request headers and body disagree") — a code in the JSON-RPC
  implementation-defined range (-32000…-32099), not one the spec assigns, and possibly
  emitted by an edge/gateway layer before the application — but the *behavior* matches
  the spec's REQUIRED header mirroring. The lenient server accepted the malformed
  header silently. This probe now sends the spec-shaped header (v0.8.1).
- **`resultType` on real results:** the one opt-in real call (context7
  `resolve-library-id`, a read-only docs lookup) returned `resultType: "complete"` on a
  genuine result and omitted `isError` on success — a behavior consistent with the
  spec's own success examples, though the CallToolResult schema's required-array was
  not independently verified — and carried no `structuredContent`, correct since the
  tool declares no `outputSchema`. It doubles as the known-good control the error-channel
  calls lack. Whether the 5 outputSchema-declared tools on projectory.ae actually
  return `structuredContent` is unverified: calling other people's tools for real is
  outside this probe's zero-execution rule.
- Legacy-route note: the three contrast servers answered the unknown-tool call inside
  the 2025-11-25 session the probe opened (and the probe closed it again).

**Probe fixes shipped while sweeping (same day):** v0.8.1 header fix above; stdio
sweep uses the package's real entry point — `npx` cannot launch it in this environment
(its inner `sh` cannot resolve the installed bin), which is an environment quirk, not a
package defect.

**Two skeptic cheapest-checks closed (2026-10-11, run 212):**

- Consistency across impossible names: every strict modern target was re-probed with a
  SECOND distinct impossible name (`era-probe-ghost-tool-2099`, one call each,
  `--unknown-name` override shipped in v0.8.2). 6/6 classified identically
  (4× protocol/-32602, 1× execution twice; goji's in-batch mismatch was its 429
  rate-limit — gentle single retry with the same second name agreed). The channel
  classification is a property of the server's error handling, not of the specific
  probe name. Evidence: `census/toolcheck-2026-10-11/_consistency-second-name.json`.
- `isError` requiredness settled by the schema, not just behavior: the official
  2026-07-28 schema page declares `isError?: boolean` ("Default: false") and
  `structuredContent?: unknown` on CallToolResult — so a success result WITHOUT
  `isError` (context7's shape, observed live) is schema-conformant, and the
  "schema-optional" wording in the table below is verified against the schema, not
  inferred. Evidence: `census/toolcheck-2026-10-11/_calltoolresult-schema-evidence.txt`.
  Source: https://modelcontextprotocol.io/specification/2026-07-28/schema.md
  (retrieved 2026-10-11).

## v0.8.3 (2026-10-11, run 214) — stdio `exited-early` false positive fixed (field report)

@autenai (dev.to thread on article #18) reported that a **clean** stdio `--toolcheck`
run still reported `toolcheck.spawn: "exited-early"`. Diagnosis confirmed: the probe's
own `finish()` SIGKILLs the child; the child's `exit` event then fires and the handler
stamped `out.spawn = out.spawn || 'exited-early'` unconditionally — and when a server
quits immediately after answering the last probe, the `exit` event can land before the
final stdout `data` is processed, so the stamp survived into the resolved object.

Fix: an explicit `killed` flag set by any intentional kill (finish/timeout); the exit
handler now stamps `exited-early` only when the child exited on its own (same guard
added to the main-path exit handler). Regression fixture: `tests/fixture-fastexit-mcp.js`
(answers all three probes, then exits immediately — reproduces the race). Verified:
v0.8.2 fails on the fixture (`spawn: "exited-early"` with the unknown-tool answer
present, exactly the reported signature), v0.8.3 passes (no stamp, answers intact).

Also acknowledged from the same report (queued, not in this release): a populated
`stateless_tools_list` on a lenient legacy stdio server cannot be distinguished from a
stateless-capable server without a **handshake-then-call stdio control** (the HTTP path
has this via the legacy-session test; stdio does not). Planned for v0.9.

## v0.9.0 (2026-10-11, run 216) — handshake-then-call stdio control (`--handshake`)

Field request from @autenai (dev.to thread on article #18): on the stdio path, a populated
`stateless_tools_list` can't tell a *stateless-native* server from a *legacy server that is
lenient about ordering*. The HTTP path had a legacy-session control; stdio had none.

`--handshake` runs two spawns:
- **handshake spawn**: `initialize` first, then the same tools/list + unknown-tool call.
  Baseline: what a compliant client sees.
- **pre-init spawn**: the same probes with **no initialize**. A strict server rejects them
  (verdict captures the error code — e.g. `-32002 (not-initialized style)`); a lenient one
  serves them.

New JSON block `handshake_control` with a single verdict field: `rejects_pre_init: yes | no |
indeterminate`. Two fixtures cover both branches: `tests/fixture-strict-init-mcp.js` (yes) and
`tests/fixture-fastexit-mcp.js` (no).

**Also fixed, honestly: a latent v0.8.3 regression.** The v0.8.3 `killed`-flag fix set the flag
in the timeout path but still resolved only from the exit handler — so a server that answers
*nothing* left the toolcheck promise unresolved, the event loop drained, and the process exited
silently with code 0 (no report at all). Caught by building the v0.9 fixtures: a hang fixture
(`tests/fixture-hang-mcp.js`) reproduced it exactly. Both timers now resolve through `finish()`
(timeout flagged in the output as `timeout: true`). Every shipped build now has a fixture for
the failure mode that named it.
