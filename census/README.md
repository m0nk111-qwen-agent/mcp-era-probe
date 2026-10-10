# MCP era census — 78 public endpoints, 2026-10-10

**Probe:** [mcp-era-probe](https://github.com/m0nk111-qwen-agent/mcp-era-probe) v0.2 (4 real `initialize` handshakes per endpoint — eras 2026-07-28, 2025-11-25, 2025-06-18, 2025-03-26 — plus `tools/list` liveness; streamable-HTTP; 50 ms spacing; one session cleanup DELETE per endpoint after the matrix). Cohort: 78 public streamable-HTTP endpoints that answered an anonymous initialize on 2026-10-06 (from our security-posture scorecard of that date). Sweep: concurrency 10, 30 s per-endpoint timeout, run 2026-10-10 ~09:45Z; per-endpoint re-checks and validation probes later the same day.

## Headline

**Zero of 78 endpoints genuinely validate-and-serve the newest protocol era (2026-07-28) with a working session.** The six that appear to are echoing back whatever version the client claims — they also "serve" `1999-01-01` and `2099-01-01` verbatim.

## Distribution (final, validated)

| class | n | notes |
|---|---|---|
| blind echo, works at any claimed era | 6 | answers ANY `protocolVersion` verbatim incl. fictional ones; `tools/list` works → sessions function, but the handshake is a lie |
| validates, accepts 2026-07-28 handshake, session broken | 1 | `tools/list` → HTTP 400 at that era; served the new era on 2026-10-06 (deployed then rolled back?) |
| max 2025-11-25 verbatim | 43 | the published SDK default era; validates properly (bogus probes answered their real latest) |
| max 2025-06-18 verbatim | 19 | |
| max 2025-03-26 verbatim | 4 | |
| serves NOTHING verbatim — downgrades every request to one fixed default | 4 | purest #2977 failure shape; defaults 2024-11-05 (×2), 2025-03-26, 2025-06-18 |
| dead (all handshakes failed) | 2 | one is a registry template-URL artifact (`{project_slug}` braces in the URL) |

**Silent downgraders: 66/78 (85%)** — a client asking only for 2026-07-28 gets an older era with no signal, on two thirds of the cohort. **Full-compat (answers all 4 eras verbatim): 6/78.**

## Methodology + honesty notes

- The 12 sampled validators answered bogus eras with their real latest → their per-era "served verbatim" rows reflect genuine era validation. Blind echo was found only in the 2026-07-28 cluster (6/6 of it).
- One endpoint (getle.ad) **lost** the new era between 2026-10-06 and 2026-10-10 — the wave moves both ways.
- The sweep's concurrency (10) caused transient handshake failures on some endpoints; affected results were re-checked gently (concurrency 1) and the table reflects the re-checks.
- Driver bug (found + fixed same day): the counters pass mutated the `served` arrays via `sort().pop()`; all summaries here are recomputed from the intact per-era rows.
- Protocol-era ≠ security. A downgrading server is spec-compliant behavior; the failure is a *client-side interop* hazard (typescript-sdk#2977 class), not a vulnerability.

## Files

- `census.json` — per-endpoint matrix: 4 rows each (era, http_status, content_type, outcome, served, tools count), plus validation classes and re-check notes.
- `bogus-echo-validation.json` — the bogus-era probe data (15 sampled + 4 targeted endpoints).

## Addendum — the `server/discover` sweep (v0.6, same day, ~20:00–22:30Z)

**Why the headline above needed an instrument fix:** the 2026-07-28 spec **removed the `initialize` handshake entirely** (SEP-2575, stateless MCP — version travels per-request in `_meta`; servers MUST implement `server/discover`). A genuine modern-era server therefore has *no reason to answer an initialize handshake at all* — initialize-based probes are structurally blind to the real modern cohort, and the only servers they can see claiming the new era are echo machines negotiating via a method the modern spec deleted. mcp-era-probe v0.6 adds the missing probe: a spec-exact `server/discover` request (HTTP + stdio, in-session mode, `--strict-modern` CI gate), carrying the modern `Mcp-Method`/`Mcp-Name` headers (SEP-2243 — a strict server rejects the POST with `-32020` "required Mcp-Method header is absent" without them; that error is itself a modern-era signal).

**Results (94 targets: 78 HTTP + 16 npm, `census/discover-sweep-2026-10-10/`):**

| class | n | notes |
|---|---|---|
| **genuine modern/dual-era** | **8** | `server/discover` + non-empty `supportedVersions` + fictional-era `_meta` (2099-01-01) rejected with the spec's `-32022` + working stateless `tools/list`: **@upstash/context7-mcp@4.3.0** (npm, strictest — `-32022` + `data.supported`), goji.agency (also enforces SEP-2243 headers), projectory.ae, getle.ad, botinfo.ai, bidclub.ai, bizmoon.ai — 7 strict; **askmiles.ai** genuine but lenient (serves fictional claims without validating) |
| discover-shaped echo machines | 2 | advisorsai.ai ×2: 200 + result but **no `supportedVersions`**, serves fictional-era `tools/list` verbatim — the echo class adapting to the new method shape |
| legacy-only (no `server/discover`) | 38 | 29 HTTP + 9 npm answer `-32601` — honest legacy, expected for ≤2025-11-25 SDKs |
| probe hit, not independently reproducible | 2 | afg.ai, analyticslegends.ai — excluded until a raw recheck reproduces the hit |
| session/auth walls (no verdict) | 38 | 400/401/404/530 on the session-less probe; modern-era status unknown |
| npm auth spawn-fails | 6 | @azure, @apify, @currents, @sentry, @zencoderai, @winor30 |

**Verified artifact:** `discover-sweep-2026-10-10/verified-modern-era.json` — every genuine entry re-verified with independent raw requests (separate client fingerprint, correct per-request headers): fictional-era rejection AND working stateless `tools/list` confirmed per server.

**Honest instrument note:** this census is two instruments deep now. The initialize-based matrix above stands as measured with that instrument; the `server/discover` sweep is the one aligned with how the newest era actually works. This is the documented "instrument blindness" failure class of internet measurement (early TLS 1.3 scans with restrictive ClientHellos, gQUIC/draft HTTP/3 counting) — the remedy is publishing both the scanner config and its blind spots, which this file does.
