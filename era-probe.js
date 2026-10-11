#!/usr/bin/env node
/* mcp-era-probe v0.3 — which protocol eras does an MCP server actually serve?
 *
 * Sends a real `initialize` handshake for each known MCP protocol version ("era") and
 * reports what the server accepted / downgraded / rejected, newest era first. Two
 * transports:
 *
 *   stdio:  node era-probe.js -- <server command> [args...]
 *   http:   node era-probe.js --http <endpoint-url> [--header "Authorization: Bearer x"]
 *                                  [--strict] [--bogus-check] [--discover] [--strict-modern]
 *
 * v0.6 — --discover: the 2026-07-28 spec (SEP-2575) REMOVED the initialize handshake.
 * "Modern" servers (2026-07-28+) are stateless: every request carries its protocol
 * version in _meta, and servers MUST implement `server/discover` — which the spec
 * explicitly frames as the stdio backward-compatibility probe. Consequence: an
 * initialize-based probe CANNOT detect a genuine modern-era server (a true modern
 * server never negotiates 2026-07-28 via initialize). --discover sends the spec's
 * own discovery request and classifies the answer:
 *   discover-ok        -> modern-era (or dual-era) server; supportedVersions returned
 *   method-not-found   -> legacy-only server (<= 2025-11-25) — expected for nearly all
 *                         servers as of 2026-10
 *   unsupported-version(-32022) -> server implements modern error semantics (dual-era signal)
 * --strict-modern: exit 1 unless discover-ok AND supportedVersions includes 2026-07-28.
 *
 * HTTP mode speaks the streamable-HTTP transport (POST JSON-RPC, Accept both
 * application/json and text/event-stream, honor Mcp-Session-Id), the transport most
 * hosted MCP servers use. Newest-first ordering matters for stateful servers that
 * allow only ONE initialize per process: their single granted handshake should be
 * the most informative one (the newest era).
 *
 * Catches the failure class of modelcontextprotocol/typescript-sdk#2977: a migrated
 * server that "compiles, passes default tests, answers the Inspector", yet only
 * serves the previous era — invisibly.
 *
 * Output: per-era lines + a verdict block (stderr) + one JSON summary line (stdout).
 * --bogus-check (v0.3): also asks for two FICTIONAL eras (1999-01-01, 2099-01-01). A
 * server that echoes those verbatim does not read protocolVersion at all — "served
 * verbatim" then proves nothing, and the verdict says so (blind echo).
 * Exit 0 always (probe succeeded); use --strict to exit 1 when the server does not
 * genuinely serve the 2026-07-28 era (blind echo counts as NOT served) — useful as a
 * CI check for "this server is era-current". No dependencies; HTTP mode needs Node >= 18.
 *
 * v0.8 — --toolcheck: era-gated TOOL-CALL channel checks, zero-execution by default:
 *   (1) stateless tools/list @2026-07-28 -> outputSchema/structured-output declaration
 *       coverage + inputSchema.required stats;
 *   (2) tools/call for a tool name that CANNOT exist ('era-probe-nonexistent-tool') ->
 *       which channel the error takes. Spec basis (fetched 2026-10-11 from
 *       modelcontextprotocol.io/specification/<era>/server/tools): protocol errors —
 *       unknown tool, malformed request, server errors — are standard JSON-RPC errors
 *       (spec example: -32602 "Unknown tool"); tool execution errors are results with
 *       isError:true. The same split exists in 2025-11-25 and 2025-06-18. resultType
 *       (MRTR pattern, 2026-07-28) is recorded as an observation only.
 *   (3) legacy-route control: initialize @2025-11-25 -> in-session tools/call of the
 *       same nonexistent tool — does ONE server classify the same error the same way
 *       across eras?
 *   A REAL tool execution is opt-in only (--call-tool NAME [--call-args JSON]); the
 *   operator asserts the target tool is read-only. Nothing else ever invokes a tool. */
'use strict';
const { spawn } = require('child_process');

const ERAS_OLDEST_FIRST = ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];
const ERAS = [...ERAS_OLDEST_FIRST].reverse(); // newest first — see header note
const LATEST = ERAS_OLDEST_FIRST[ERAS_OLDEST_FIRST.length - 1];
const HANDSHAKE_TIMEOUT_MS = Number(process.env.ERA_PROBE_TIMEOUT || 10000);
const CLIENT_INFO = { name: 'mcp-era-probe', version: '0.5.0' };
const BOGUS_ERAS = ['1999-01-01', '2099-01-01']; // fictional eras for --bogus-check

function splitArgv(argv) {
  const i = argv.indexOf('--');
  if (i === -1) {
    console.error('usage: era-probe.js -- <server command> [args...]\n       era-probe.js --http <url> [--header "Name: value"]');
    process.exit(64);
  }
  return { cmd: argv[i + 1], args: argv.slice(i + 2) };
}

/* ---------- stdio probe (v0.1 logic, unchanged) ---------- */

/** Run one initialize handshake against a fresh server process. */
function probeEraStdio(cmd, args, era) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ era, outcome: 'spawn-error', detail: e.message });
    }
    const done = (r) => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ era, outcome: 'timeout', detail: `no initialize response in ${HANDSHAKE_TIMEOUT_MS}ms` }), HANDSHAKE_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); done({ era, outcome: 'spawn-error', detail: e.message }); });
    child.on('exit', (code) => { clearTimeout(timer); done({ era, outcome: 'crashed', detail: `server exited (code ${code}) before responding` }); });

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; } // non-protocol stdout noise
        if (msg.id === 1) {
          clearTimeout(timer);
          if (msg.error) {
            done({ era, outcome: 'rejected', detail: `error ${msg.error.code}: ${String(msg.error.message).slice(0, 120)}` });
          } else {
            const served = msg.result && msg.result.protocolVersion;
            // confirm liveness with the initialized notification + tools/list
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
            let buf2 = '';
            const t2 = setTimeout(() => done({ era, outcome: 'served-no-live', detail: `initialize answered ${served}, but tools/list got no reply` }), HANDSHAKE_TIMEOUT_MS);
            const onData2 = (d2) => {
              buf2 += d2.toString();
              let j;
              while ((j = buf2.indexOf('\n')) !== -1) {
                const l2 = buf2.slice(0, j).trim(); buf2 = buf2.slice(j + 1);
                if (!l2) continue;
                let m2; try { m2 = JSON.parse(l2); } catch (_) { continue; }
                if (m2.id === 2) {
                  clearTimeout(t2);
                  const live = !m2.error && m2.result && Array.isArray(m2.result.tools);
                  done({ era, outcome: served === era ? (live ? 'served' : 'served-no-live') : 'downgraded', served, detail: live ? `${(m2.result.tools || []).length} tool(s) listed` : `tools/list ${m2.error ? 'error ' + m2.error.code : 'malformed'}`, serverInfo: msg.result.serverInfo || undefined, capabilities: msg.result.capabilities || undefined });
                }
              }
            };
            child.stdout.on('data', onData2);
          }
        }
      }
    });

    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: era, capabilities: {}, clientInfo: CLIENT_INFO } };
    child.stdin.write(JSON.stringify(init) + '\n');
    child.stderr.resume(); // drain server logs
  });
}

/* ---------- streamable-HTTP probe (v0.2) ---------- */

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse one JSON-RPC response out of an HTTP response body (plain JSON or SSE). */
function responseFromBody(raw) {
  // 1) plain JSON body
  try {
    const j = JSON.parse(raw);
    if (j && (j.id !== undefined || j.error || j.result)) return { msg: j };
  } catch (_) { /* fall through to SSE */ }
  // 2) SSE stream: collect every `data:` payload, return the first JSON-RPC response
  const payloads = [];
  for (const line of raw.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const data = l.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const j = JSON.parse(data);
      if (j && (j.id !== undefined || j.method || j.result)) payloads.push(j);
    } catch (_) { /* skip non-JSON SSE line */ }
  }
  const resp = payloads.find((p) => p.id !== undefined);
  return resp ? { msg: resp, sse: true } : { sse: true };
}

/** Probe one era against a streamable-HTTP endpoint. */
async function probeEraHttp(url, extraHeaders, era) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...extraHeaders,
  };
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: era, capabilities: {}, clientInfo: CLIENT_INFO } };
  const started = Date.now();
  let res, raw;
  try {
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), HANDSHAKE_TIMEOUT_MS);
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(init), signal: ctrl.signal, redirect: 'follow' });
    raw = await res.text();
    clearTimeout(killer);
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { era, outcome: aborted ? 'timeout' : 'unreachable', detail: aborted ? `no initialize response in ${HANDSHAKE_TIMEOUT_MS}ms` : String(e.message || e).slice(0, 140), http_status: null };
  }
  const httpStatus = res.status;
  const ct = String(res.headers.get('content-type') || '');
  const sessionId = res.headers.get('mcp-session-id');
  const base = { era, http_status: httpStatus, content_type: ct.slice(0, 40), session: sessionId ? 'granted' : 'none' };

  if (httpStatus === 202 || (httpStatus >= 200 && httpStatus < 300 && !raw.trim())) {
    return { ...base, outcome: 'rejected', detail: `HTTP ${httpStatus} with empty body for initialize (server treated it as a notification?)` };
  }
  if (httpStatus >= 400) {
    let detail = `HTTP ${httpStatus}`;
    try {
      const j = JSON.parse(raw);
      if (j.error) detail += `, error ${j.error.code}: ${String(j.error.message).slice(0, 110)}`;
      else if (j.message || j.error_description) detail += `, ${String(j.message || j.error_description).slice(0, 110)}`;
    } catch (_) { if (raw.trim()) detail += `, body "${raw.trim().slice(0, 80)}"`; }
    return { ...base, outcome: 'rejected', detail };
  }
  if (httpStatus >= 300) return { ...base, outcome: 'unreachable', detail: `HTTP ${httpStatus} (redirect loop?)` };

  const { msg, sse } = responseFromBody(raw);
  if (!msg) {
    return { ...base, outcome: 'rejected', detail: `HTTP 200 ${sse ? '(SSE)' : ''} but no initialize response object (content-type "${ct.slice(0, 40)}")` };
  }
  if (msg.error) {
    return { ...base, outcome: 'rejected', detail: `error ${msg.error.code}: ${String(msg.error.message || '').slice(0, 120)}` };
  }
  const served = msg.result && msg.result.protocolVersion;
  if (!served) return { ...base, outcome: 'rejected', detail: 'initialize result without protocolVersion' };
  // v0.7 behavior observations: serverInfo (icons/description fields, SEP-973) and
  // the capabilities object (experimental `tasks` SEP-1686, `extensions` field) as
  // the server advertises them on the ACCEPTED era.
  const serverInfo = msg.result.serverInfo || undefined;
  const capabilities = msg.result.capabilities || undefined;

  /* liveness: initialized notification + tools/list on the same session (stateful
   * servers require the Mcp-Session-Id header; stateless servers take a fresh POST). */
  const liveHeaders = { ...headers, 'MCP-Protocol-Version': served, ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) };
  let liveDetail = 'tools/list not attempted';
  let live = null;
  try {
    const post = async (body) => {
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), HANDSHAKE_TIMEOUT_MS);
      const r = await fetch(url, { method: 'POST', headers: liveHeaders, body: JSON.stringify(body), signal: ctrl.signal, redirect: 'follow' });
      const t = await r.text();
      clearTimeout(killer);
      return { status: r.status, text: t };
    };
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const r2 = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    if (r2.status >= 400) {
      liveDetail = `tools/list HTTP ${r2.status}`;
    } else {
      const m2 = responseFromBody(r2.text).msg;
      if (m2 && m2.result && Array.isArray(m2.result.tools)) {
        live = true; liveDetail = `${m2.result.tools.length} tool(s) listed`;
      } else if (m2 && m2.error) {
        live = false; liveDetail = `tools/list error ${m2.error.code}`;
      } else {
        liveDetail = 'tools/list malformed';
      }
    }
  } catch (e) {
    liveDetail = `tools/list failed: ${String(e.message || e).slice(0, 80)}`;
  }
  // NOTE: no DELETE here — on servers that keep one transport for all sessions a
  // DELETE closes the transport for everyone and would blind the next era probes.
  // Sessions are cleaned up once, after the full matrix (see main()).
  const outcome = served === era ? (live === true ? 'served' : 'served-no-live') : 'downgraded';
  return { ...base, outcome, served, detail: liveDetail, ms: Date.now() - started, session_id: sessionId || undefined, serverInfo, capabilities };
}

/* ---------- shared reporting ---------- */

/** v0.7 era-gated BEHAVIOR checks — read-only, no tool execution, no state mutation.
 *  (1) origin-403 CONTROL PAIR (2025-11-25): strict Streamable HTTP servers return
 *      403 for an initialize from an invalid Origin. Verdict counts ONLY if the
 *      same request WITHOUT Origin passes — rules out auth/WAF false positives.
 *  (2) modern-era stateless tools/list x2 (2026-07-28): resultType is an
 *      OBSERVATION (MRTR defines it for tool execution, not list endpoints),
 *      order determinism = within-session stability only, bogus cursor = diversity
 *      data (no MUST defines invalid-cursor behavior).
 *  (3) removed-method probe: `ping` was REMOVED in 2026-07-28 — a strict modern
 *      server answers -32601; tolerance marks a compat shim.
 *  (4) missing-version probe: omit _meta.protocolVersion on a stateless request —
 *      separates stateless-strict (-32022 demanded) from lenient (accepted). */
async function behaviorHttp(url, headers) {
  const out = {};
  const baseInit = { jsonrpc: '2.0', id: 'behavior-origin', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-era-probe', version: '0.7.0' } } };
  const postRaw = async (hdrs, body) => {
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { method: 'POST', headers: hdrs, body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await res.text();
    clearTimeout(killer);
    const parsed = responseFromBody(raw);
    return { status: res.status, msg: parsed && parsed.msg };
  };
  // (1) Origin validation — control pair (no-Origin control first)
  try {
    const ctl = await postRaw({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, baseInit);
    const spoof = await postRaw({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers, Origin: 'https://evil.example.invalid' }, baseInit);
    out.origin_check = {
      control_no_origin: ctl.status, spoofed_origin: spoof.status,
      spec: '2025-11-25 expects 403 Forbidden for an invalid Origin',
      verdict: (ctl.status === 403) ? 'control-also-403 (auth/WAF wall, no signal)'
        : (spoof.status === 403 ? 'strict' : (spoof.status < 400 ? 'no-origin-validation' : `rejected-other (HTTP ${spoof.status})`)),
    };
    await SLEEP(120);
  } catch (e) {
    out.origin_check = { verdict: 'transport-error', message: String(e && e.message || e).slice(0, 100) };
  }
  // (2) modern-era stateless tools/list x2
  const modernList = (cursor, omitVersion) => {
    const meta = omitVersion ? {} : {
      'io.modelcontextprotocol/protocolVersion': LATEST,
      'io.modelcontextprotocol/clientInfo': { name: 'mcp-era-probe', version: '0.7.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    return postRaw({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers, 'Mcp-Method': 'tools/list', 'Mcp-Name': 'mcp-era-probe' },
      { jsonrpc: '2.0', id: 'behavior-list', method: 'tools/list', params: { ...(cursor ? { cursor } : {}), _meta: meta } });
  };
  try {
    const a = await modernList();
    const b = await modernList();
    if (a.msg && a.msg.result && Array.isArray(a.msg.result.tools)) {
      const names = a.msg.result.tools.map((t) => t.name);
      const bnames = (b.msg && b.msg.result && Array.isArray(b.msg.result.tools)) ? b.msg.result.tools.map((t) => t.name) : null;
      out.stateless_tools_list = {
        http_status: a.status, tools: names.length,
        resultType: a.msg.result.resultType || '(absent — treated as complete per MRTR; observation, not compliance)',
        order_stability_within_run: bnames ? JSON.stringify(names) === JSON.stringify(bnames) : undefined,
      };
    } else if (a.msg && a.msg.error) {
      out.stateless_tools_list = { http_status: a.status, error: a.msg.error.code, message: String(a.msg.error.message || '').slice(0, 100) };
    } else {
      out.stateless_tools_list = { http_status: a.status, verdict: 'no-parseable-response' };
    }
    await SLEEP(120);
    const bc = await modernList('era-probe-bogus-cursor');
    out.bogus_cursor = bc.msg && bc.msg.error
      ? { error: bc.msg.error.code, message: String(bc.msg.error.message || '').slice(0, 90) }
      : { http_status: bc.status, verdict: 'no-error (cursor ignored or empty page)' };
    await SLEEP(120);
    // (3) removed-method probe: ping left the spec in 2026-07-28
    const ping = await postRaw({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers, 'Mcp-Method': 'ping', 'Mcp-Name': 'mcp-era-probe' },
      { jsonrpc: '2.0', id: 'behavior-ping', method: 'ping', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST } } });
    out.removed_ping = ping.msg
      ? (ping.msg.error ? { error: ping.msg.error.code, verdict: ping.msg.error.code === -32601 ? '-32601 (no ping handler — strict-modern OR minimal server; ambiguous without discover)' : `error ${ping.msg.error.code}` } : { verdict: 'answered — ping still implemented (compat tolerance)' })
      : { http_status: ping.status, verdict: 'no-parseable-response' };
    await SLEEP(120);
    // (4) missing-version probe: stateless request with NO _meta.protocolVersion
    const nv = await modernList(null, true);
    out.missing_version = nv.msg
      ? (nv.msg.error ? { error: nv.msg.error.code, verdict: nv.msg.error.code === -32022 ? 'demands -32022 (stateless-strict)' : 'error-other' } : { verdict: 'accepted without version (lenient)' })
      : { http_status: nv.status, verdict: 'no-parseable-response' };
  } catch (e) {
    out.stateless_tools_list = out.stateless_tools_list || { verdict: 'transport-error', message: String(e && e.message || e).slice(0, 100) };
  }
  return out;
}

/** spec-exact modern-era discovery request (2026-07-28 server/discover) */
function discoverRequest(id) {
  return {
    jsonrpc: '2.0', id: id || 'discover-1', method: 'server/discover',
    params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': LATEST,
      'io.modelcontextprotocol/clientInfo': { name: 'mcp-era-probe', version: '0.7.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } },
  };
}

/** classify a raw JSON-RPC response (or error) for server/discover */
function classifyDiscover(json, httpStatus, detail) {
  if (json && json.result) {
    const sv = Array.isArray(json.result.supportedVersions) ? json.result.supportedVersions : null;
    const info = json.result._meta && json.result._meta['io.modelcontextprotocol/serverInfo'];
    if (sv && sv.length) {
      return { outcome: 'discover-ok', supportedVersions: sv, serverInfo: info || undefined,
               resultType: json.result.resultType || undefined, detail: detail || undefined };
    }
    // A discover-SHAPED response with no supportedVersions is hollow — seen in the
    // wild (echo machines adapting): 200 + result, but it advertises nothing and
    // serves fictional-era requests. Not a genuine modern-era server.
    return { outcome: 'discover-no-supported-versions', detail: 'result without supportedVersions — echo suspect', http_status: httpStatus };
  }
  const code = json && json.error && json.error.code;
  if (code === -32601) return { outcome: 'method-not-found', detail: 'no server/discover — legacy (<= 2025-11-25) implementation', ...({ http_status: httpStatus }) };
  if (code === -32022) {
    const sup = json.error.data && Array.isArray(json.error.data.supported) ? json.error.data.supported : null;
    return { outcome: 'unsupported-version', supportedVersions: sup || undefined, detail: 'modern-era error semantics (UnsupportedProtocolVersionError) — dual-era signal', http_status: httpStatus };
  }
  return { outcome: 'error', error: code != null ? code : undefined,
           message: (json && json.error && json.error.message) || detail || 'no parseable response', http_status: httpStatus };
}

/** HTTP server/discover probe (v0.6); opts.sessionId = run it inside an established
 *  session (--discover-last) — many legacy HTTP servers reject session-less requests. */
async function probeDiscoverHttp(url, extraHeaders, opts = {}) {
  const started = Date.now();
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 10000);
  let raw, json = null, httpStatus = null;
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream',
                    'MCP-Protocol-Version': LATEST,
                    // 2026-07-28 Streamable HTTP requires these on every POST (SEP-2243);
                    // strict modern servers REJECT the request without them (-32020
                    // "the required Mcp-Method header is absent"). Legacy servers ignore them.
                    'Mcp-Method': 'server/discover', 'Mcp-Name': 'mcp-era-probe',
                    ...extraHeaders };
  if (opts.sessionId) headers['Mcp-Session-Id'] = opts.sessionId;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(discoverRequest()), signal: ctrl.signal });
    httpStatus = res.status;
    raw = await res.text();
  } catch (e) {
    clearTimeout(killer);
    return { outcome: 'transport-error', message: String(e && e.message || e) };
  }
  clearTimeout(killer);
  try { const parsed = responseFromBody(raw); json = parsed && parsed.msg ? parsed.msg : null; } catch (_) { /* fallthrough */ }
  return classifyDiscover(json, httpStatus, json ? undefined : `unparseable: ${String(raw).slice(0, 120)}`);
}

/** stdio server/discover probe (v0.6): fresh spawn, one request, read the response */
function probeDiscoverStdio(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ outcome: 'spawn-fail', message: String(e && e.message || e) });
      return;
    }
    const started = Date.now();
    let buf = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 8000);
    const finish = (r) => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} resolve(r); };
    child.on('error', (e) => finish({ outcome: 'spawn-fail', message: String(e && e.message || e) }));
    child.stdout.on('data', (d) => {
      buf += d.toString();
      for (const line of buf.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          if (j.id === 'discover-1' || j.result || j.error) { finish(classifyDiscover(j, null)); return; }
        } catch (_) { /* not JSON yet */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', () => {
      if (buf.trim()) {
        for (const line of buf.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try {
            const j = JSON.parse(t);
            if (j.id === 'discover-1' || j.result || j.error) { finish(classifyDiscover(j, null)); return; }
          } catch (_) {}
        }
      }
      finish({ outcome: 'no-answer', detail: 'process exited before answering server/discover' });
    });
    try { child.stdin.write(JSON.stringify(discoverRequest()) + '\n'); } catch (_) {}
  });
}

/** v0.7 stdio behavior checks: ONE spawn, server/discover FIRST (the spec's own
 *  dual-era client behavior — modern servers answer it, legacy ones answer the
 *  legacy probes), then read-only observations — removed-ping, tools/list shape,
 *  bogus cursor, missing-version. Same read-only/no-execution rules as
 *  behaviorHttp; origin-403 is HTTP-only (Streamable HTTP concept). */
function behaviorStdio(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ spawn: 'spawn-fail', message: String(e && e.message || e) });
      return;
    }
    const out = {};
    let buf = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 12000);
    const finish = () => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} resolve(out); };
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (_) {} };
    const mcpMeta = (extra) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': LATEST, ...(extra || {}) } });
    let got = 0;
    const next = () => {
      got += 1;
      if (got === 1) send({ jsonrpc: '2.0', id: 'b-ping', method: 'ping', params: mcpMeta() });
      else if (got === 2) send({ jsonrpc: '2.0', id: 'b-list', method: 'tools/list', params: mcpMeta({ 'io.modelcontextprotocol/clientInfo': { name: 'mcp-era-probe', version: '0.7.0' }, 'io.modelcontextprotocol/clientCapabilities': {} }) });
      else if (got === 3) send({ jsonrpc: '2.0', id: 'b-cursor', method: 'tools/list', params: { cursor: 'era-probe-bogus-cursor', ...mcpMeta() } });
      else if (got === 4) send({ jsonrpc: '2.0', id: 'b-nover', method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'mcp-era-probe', version: '0.7.0' } } } });
      else finish();
    };
    child.on('error', () => { out.spawn = 'spawn-fail'; finish(); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.id === 'discover-1') {
          out.discover = m.error ? (m.error.code === -32601 ? 'method-not-found (legacy)' : `error ${m.error.code}`) : (m.result && Array.isArray(m.result.supportedVersions) && m.result.supportedVersions.length ? `ok — supportedVersions: ${m.result.supportedVersions.join(', ')}` : 'discover-shaped (no supportedVersions — echo suspect)');
          next();
        } else if (m.id === 'b-ping') {
          out.removed_ping = m.error ? { error: m.error.code, verdict: m.error.code === -32601 ? '-32601 (no ping handler — strict-modern OR minimal server; ambiguous)' : `error ${m.error.code}` } : { verdict: 'answered — ping still implemented (compat tolerance)' };
          next();
        } else if (m.id === 'b-list') {
          if (m.error) out.stateless_tools_list = { error: m.error.code, verdict: `error ${m.error.code}` };
          else if (m.result && Array.isArray(m.result.tools)) {
            out.stateless_tools_list = { tools: m.result.tools.length, resultType: m.result.resultType || '(absent — observation, not compliance)' };
          } else out.stateless_tools_list = { verdict: 'no-parseable-result' };
          next();
        } else if (m.id === 'b-cursor') {
          out.bogus_cursor = m.error ? { error: m.error.code, verdict: `error ${m.error.code}` } : { verdict: 'no-error (cursor ignored or empty page)' };
          next();
        } else if (m.id === 'b-nover') {
          out.missing_version = m.error ? { error: m.error.code, verdict: m.error.code === -32022 ? 'demands -32022 (stateless-strict)' : `error ${m.error.code}` } : { verdict: 'accepted without version (lenient)' };
          next();
        }
      }
    });
    child.on('exit', () => { if (got < 5) { out.spawn = out.spawn || 'exited-early'; finish(); } });
    send(discoverRequest());
  });
}


/** newest era the server served verbatim (order-independent) */
function newestServed(served) {
  return ERAS_OLDEST_FIRST.filter((e) => served.includes(e)).pop();
}

/* ---------- v0.8 tool-call channel checks ---------- */

const UNKNOWN_TOOL = 'era-probe-nonexistent-tool'; // cannot exist on any server
// --unknown-name NAME lets an operator re-run the channel probe with a different
// impossible name (consistency check: two distinct impossible names must classify
// identically — rules out name-specific caching/fluke answers). Same constraints:
// the name must not exist on any target.
let unknownToolOverride = null;
function UNKNOWN() { return unknownToolOverride || UNKNOWN_TOOL; }

/** classify a JSON-RPC response to a tools/call request: which channel did the
 *  answer take? protocol (JSON-RPC error) | execution (result.isError:true) |
 *  result-no-iserror (a "successful" result — for an unknown tool that is its own
 *  finding) | no-parseable-response. resultType/structuredContent recorded as
 *  observations only. */
function classifyCallChannel(status, msg) {
  if (msg && msg.error) {
    return { channel: 'protocol', code: msg.error.code, message: String(msg.error.message || '').slice(0, 140) };
  }
  if (msg && msg.result) {
    const r = msg.result;
    const channel = r.isError === true ? 'execution' : (r.isError === false ? 'result-iserror-false' : 'result-no-iserror');
    return {
      channel,
      resultType: r.resultType || undefined,
      has_structuredContent: Object.prototype.hasOwnProperty.call(r, 'structuredContent') || undefined,
      content_preview: Array.isArray(r.content) ? JSON.stringify(r.content).slice(0, 200) : undefined,
    };
  }
  return { channel: 'no-parseable-response', http_status: status };
}

/** tools/list coverage stats: structured-output declarations + required-arg shape */
function listCoverage(msg) {
  if (!msg || !msg.result || !Array.isArray(msg.result.tools)) {
    return { error: (msg && msg.error && msg.error.code) || 'no-tools-array', message: msg && msg.error ? String(msg.error.message).slice(0, 100) : undefined };
  }
  const tools = msg.result.tools;
  const withOut = tools.filter((t) => t.outputSchema);
  const withReq = tools.filter((t) => t.inputSchema && Array.isArray(t.inputSchema.required) && t.inputSchema.required.length);
  return {
    tools: tools.length,
    resultType: msg.result.resultType || '(absent — observation, not compliance)',
    outputSchema_declared: withOut.length,
    outputSchema_names: withOut.map((t) => t.name).slice(0, 10),
    inputSchema_with_required: withReq.length,
    sample_names: tools.map((t) => t.name).slice(0, 8),
    tool_schemas: tools.slice(0, 12).map((t) => ({
      name: t.name,
      required: (t.inputSchema && Array.isArray(t.inputSchema.required)) ? t.inputSchema.required : [],
      properties: (t.inputSchema && t.inputSchema.properties) ? Object.keys(t.inputSchema.properties).slice(0, 8) : [],
    })),
  };
}

/** v0.8 HTTP toolcheck — modern-era stateless route + legacy-route control.
 *  Zero-execution: the only tools/call targets a tool name that cannot exist.
 *  The legacy route opens its OWN session (initialize @2025-11-25) and closes it. */
async function toolcheckHttp(url, headers) {
  const postRaw = async (hdrs, body) => {
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { method: 'POST', headers: hdrs, body: JSON.stringify(body), signal: ctrl.signal });
    const raw = await res.text();
    clearTimeout(killer);
    const parsed = responseFromBody(raw);
    return { status: res.status, msg: parsed && parsed.msg };
  };
  const meta = {
    'io.modelcontextprotocol/protocolVersion': LATEST,
    'io.modelcontextprotocol/clientInfo': { name: 'mcp-era-probe', version: '0.8.2' },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
  const out = {};
  // (1) coverage via stateless tools/list @2026-07-28
  try {
    const list = await postRaw({ ...H, 'Mcp-Method': 'tools/list', 'Mcp-Name': 'mcp-era-probe' },
      { jsonrpc: '2.0', id: 'tc-list', method: 'tools/list', params: { _meta: meta } });
    out.stateless_tools_list = list.status >= 400 ? { http_status: list.status, verdict: `HTTP ${list.status}` } : listCoverage(list.msg);
    await SLEEP(120);
    // (2) unknown-tool call on the modern route — the zero-execution error-channel probe
    //     Mcp-Name MUST mirror params.name on tools/call (2026-07-28 streamable-http,
    //     "Standard Request Headers" — REQUIRED for compliance; strict servers answer
    //     -32020 when the header and the body disagree).
    const unk = await postRaw({ ...H, 'Mcp-Method': 'tools/call', 'Mcp-Name': UNKNOWN() },
      { jsonrpc: '2.0', id: 'tc-unk', method: 'tools/call', params: { name: UNKNOWN(), arguments: {}, _meta: meta } });
    out.unknown_tool_modern = classifyCallChannel(unk.status, unk.msg);
    await SLEEP(120);
  } catch (e) {
    out.stateless_tools_list = out.stateless_tools_list || { verdict: 'transport-error', message: String(e && e.message || e).slice(0, 100) };
    return out;
  }
  // (3) legacy-route control: own session, same unknown tool, era 2025-11-25
  try {
    const init = { jsonrpc: '2.0', id: 'tc-init', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'mcp-era-probe', version: '0.8.2' } } };
    // the session id lives on the RESPONSE HEADERS — raw fetch, not postRaw:
    const ctrl = new AbortController();
    const killer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { method: 'POST', headers: H, body: JSON.stringify(init), signal: ctrl.signal });
    await res.text();
    clearTimeout(killer);
    const sessionId = res.headers.get('mcp-session-id');
    if (!sessionId) {
      out.unknown_tool_legacy = { verdict: 'no-session-granted (stateless or refused legacy handshake)' };
    } else {
      const lr = await postRaw({ ...H, 'MCP-Protocol-Version': '2025-11-25', 'Mcp-Session-Id': sessionId },
        { jsonrpc: '2.0', id: 'tc-unk-legacy', method: 'tools/call', params: { name: UNKNOWN(), arguments: {} } });
      out.unknown_tool_legacy = { ...classifyCallChannel(lr.status, lr.msg), route: 'initialize@2025-11-25 + Mcp-Session-Id' };
      // cleanup: close the session we opened
      try {
        const c2 = new AbortController();
        const k2 = setTimeout(() => c2.abort(), 4000);
        await fetch(url, { method: 'DELETE', headers: { ...H, 'Mcp-Session-Id': sessionId }, signal: c2.signal });
        clearTimeout(k2);
      } catch (_) { /* best effort */ }
    }
  } catch (e) {
    out.unknown_tool_legacy = { verdict: 'transport-error', message: String(e && e.message || e).slice(0, 100) };
  }
  out.unknown_tool_name = UNKNOWN();
  return out;
}

/** v0.8 stdio toolcheck: ONE spawn — server/discover, stateless tools/list @modern,
 *  unknown-tool call @modern. Same zero-execution rule as the HTTP path. */
function toolcheckStdio(cmd, args) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ spawn: 'spawn-fail', message: String(e && e.message || e) }); return; }
    const out = {};
    let buf = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 15000);
    const finish = () => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} out.unknown_tool_name = UNKNOWN(); resolve(out); };
    const meta = {
      'io.modelcontextprotocol/protocolVersion': LATEST,
      'io.modelcontextprotocol/clientInfo': { name: 'mcp-era-probe', version: '0.8.2' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (_) {} };
    const next = (step) => {
      if (step === 'list') send({ jsonrpc: '2.0', id: 'tc-list', method: 'tools/list', params: { _meta: meta } });
      else if (step === 'unk') send({ jsonrpc: '2.0', id: 'tc-unk', method: 'tools/call', params: { name: UNKNOWN(), arguments: {}, _meta: meta } });
      else finish();
    };
    child.on('error', () => { out.spawn = 'spawn-fail'; finish(); });
    child.stderr.on('data', () => {});
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.id === 'discover-1') {
          out.discover = m.error ? (m.error.code === -32601 ? 'method-not-found (legacy)' : `error ${m.error.code}`)
            : (m.result && Array.isArray(m.result.supportedVersions) && m.result.supportedVersions.length ? `ok — ${m.result.supportedVersions.join(', ')}` : 'discover-shaped, no supportedVersions');
          next('list');
        } else if (m.id === 'tc-list') {
          out.stateless_tools_list = m.error ? { error: m.error.code } : listCoverage(m);
          next('unk');
        } else if (m.id === 'tc-unk') {
          out.unknown_tool_modern = classifyCallChannel(null, m);
          next('done');
        }
      }
    });
    child.on('exit', () => { out.spawn = out.spawn || 'exited-early'; finish(); });
    send(discoverRequest('discover-1'));
  });
}

/** v0.8 OPT-IN real execution (--call-tool NAME --call-args JSON). The operator
 *  asserts the tool is read-only; the probe makes exactly ONE call and reports the
 *  raw channel classification (isError / structuredContent / resultType). */
async function callToolHttp(url, headers, name, argsObj) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), 20000);
  const res = await fetch(url, {
    method: 'POST',
    // Mcp-Name mirrors params.name on tools/call (REQUIRED, 2026-07-28 streamable-http)
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers, 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'tc-real', method: 'tools/call', params: { name, arguments: argsObj, _meta: {
      'io.modelcontextprotocol/protocolVersion': LATEST,
      'io.modelcontextprotocol/clientInfo': { name: 'mcp-era-probe', version: '0.8.2' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }),
    signal: ctrl.signal,
  });
  const raw = await res.text();
  clearTimeout(killer);
  const parsed = responseFromBody(raw);
  return classifyCallChannel(res.status, parsed && parsed.msg);
}

/** v0.8 opt-in real execution over stdio: one spawn — handshake via the modern
 *  stateless route (works for dual-era servers), then the single real call. */
function callToolStdio(cmd, args, name, argsObj) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ spawn: 'spawn-fail', message: String(e && e.message || e) }); return; }
    let buf = '';
    const meta = {
      'io.modelcontextprotocol/protocolVersion': LATEST,
      'io.modelcontextprotocol/clientInfo': { name: 'mcp-era-probe', version: '0.8.2' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (_) {} };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 25000);
    const finish = (r) => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch (_) {} resolve(r); };
    let listed = false;
    child.stderr.on('data', () => {});
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (!listed && m.result !== undefined) { listed = true; send({ jsonrpc: '2.0', id: 'tc-real', method: 'tools/call', params: { name, arguments: argsObj, _meta: meta } }); }
        else if (m.id === 'tc-real') finish({ target: `${cmd} ${args.join(' ')}`.trim(), tool: name, ...classifyCallChannel(null, m), raw_result: m.result || m.error || undefined });
      }
    });
    child.on('error', (e) => finish({ spawn: 'spawn-fail', message: String(e && e.message || e) }));
    child.on('exit', (code) => finish({ spawn: `exited-early (code ${code})` }));
    send(discoverRequest('discover-1'));
  });
}


function report(target, rows, strict, extra) {
  for (const r of rows) {
    const mark = r.outcome === 'served' ? 'ACCEPTED ' : r.outcome === 'downgraded' ? 'DOWNGRADE' : r.outcome.toUpperCase().padEnd(9);
    const httpBit = r.http_status != null ? `HTTP ${r.http_status} ` : '';
    const bits = [r.outcome === 'downgraded' ? `-> serves ${r.served}` : '', r.detail ? `(${httpBit}${r.detail})` : ''].filter(Boolean).join(' ');
    console.error(`${mark}  ${r.era}  ${bits}`);
  }
  const served = rows.filter((r) => r.outcome === 'served').map((r) => r.era);
  const downgradedTo = [...new Set(rows.filter((r) => r.outcome === 'downgraded').map((r) => r.served))];
  console.error('---');
  console.error(`served verbatim : ${served.length ? served.join(', ') : '(none)'}`);
  if (downgradedTo.length) console.error(`downgraded to   : ${downgradedTo.join(', ')}  <- ${LATEST}-era clients will NOT get this era`);
  const oneInit = rows.some((r) => /already initialized/i.test(String(r.detail)));
  if (oneInit) console.error('note            : server refused repeat initialize ("already initialized") — single-session/stateful shape; era evidence comes from the first handshake only');
  const newest = newestServed(served);
  const bc = extra && extra.bogus_check;
  const disc = extra && (extra.discover || extra.discover_in_session);
  const discIn = extra && extra.discover_in_session;
  // v0.5: two honest shapes beyond blind echo that the fictional-era control distinguishes.
  // spec (basic lifecycle): if the requested version is unsupported the server responds with
  // another version it supports — so "answers bogus eras with its latest" is COMPLIANT;
  // but when the server answers EVERYTHING (real or fictional) with the same fixed era,
  // negotiation is fully decorative: the field never varies with the request.
  let bogusNote = null;
  if (bc && !bc.echo) {
    const b1 = bc[BOGUS_ERAS[0]], b2 = bc[BOGUS_ERAS[1]];
    if (b1 && b2 && b1 === b2) {
      const downgradedAll = rows.length && rows.every((r) => r.outcome === 'downgraded' && r.served === b1);
      if (downgradedAll) {
        bogusNote = `constant-answer — the server answered every era (real and fictional) with ${b1}; protocolVersion never varies with the request, negotiation is fully decorative`;
      } else if (served.length) {
        bogusNote = `negotiates known eras verbatim; answers unknown/fictional eras with its fallback (${b1}) — spec-compliant downgrade path (basic lifecycle: unsupported version -> another supported version)`;
      }
    }
  }
  if (bc) {
    if (bc.echo) console.error('BOGUS-CHECK     : BLIND ECHO — the server also "serves" ' + BOGUS_ERAS.join(' and ') + ' verbatim; it does not read protocolVersion, so every "served verbatim" line above proves nothing');
    else console.error(`BOGUS-CHECK     : ${bogusNote ? bogusNote : `validates (answered ${BOGUS_ERAS.map((be) => bc[be] || 'nothing').join(', ')} to fictional eras)`}`);
  }
  const modernOk = disc && disc.outcome === 'discover-ok' && Array.isArray(disc.supportedVersions) && disc.supportedVersions.includes(LATEST);
  if (disc) {
    if (disc.outcome === 'discover-ok') {
      console.error(`DISCOVER       : server/discover OK — supportedVersions: ${disc.supportedVersions ? disc.supportedVersions.join(', ') : '(none listed)'}${modernOk ? '  <- genuine MODERN-era server (stateless, per-request _meta)' : ''}`);
    } else {
      console.error(`DISCOVER       : ${disc.outcome}${disc.detail ? ' — ' + disc.detail : ''}${disc.message ? ' (' + disc.message + ')' : ''}`);
    }
    if (discIn && extra.discover && discIn.outcome !== extra.discover.outcome) {
      console.error(`DISCOVER(in-session): ${discIn.outcome}${discIn.supportedVersions ? ' — supportedVersions: ' + discIn.supportedVersions.join(', ') : discIn.detail ? ' — ' + discIn.detail : ''}`);
    }
  }
  if (extra && extra.behavior) {
    const bh = extra.behavior;
    if (bh.origin_check) {
      const oc = bh.origin_check;
      console.error(`BEHAVIOR-origin : ${oc.verdict}${oc.spoofed_origin != null ? ` (control ${oc.control_no_origin}, spoofed ${oc.spoofed_origin})` : ''} — ${oc.spec || oc.message || ''}`);
    }
    if (bh.stateless_tools_list) {
      const st = bh.stateless_tools_list;
      console.error(`BEHAVIOR-list   : ${st.tools != null ? st.tools + ' tool(s) stateless @' + LATEST : st.verdict || ('error ' + st.error)}${st.resultType ? ', resultType: ' + st.resultType : ''}${st.order_stability_within_run != null ? `, order stable: ${st.order_stability_within_run}` : ''}`);
    }
    if (bh.bogus_cursor) {
      const bc = bh.bogus_cursor;
      console.error(`BEHAVIOR-cursor : ${bc.error != null ? 'error ' + bc.error + ' — ' + (bc.message || '') : (bc.verdict || 'ok')}`);
    }
    if (bh.removed_ping) console.error(`BEHAVIOR-ping   : ${bh.removed_ping.verdict}${bh.removed_ping.error != null ? ' (' + bh.removed_ping.error + ')' : ''}`);
    if (bh.missing_version) console.error(`BEHAVIOR-nover  : ${bh.missing_version.verdict}${bh.missing_version.error != null ? ' (' + bh.missing_version.error + ')' : ''}`);
  }
  if (extra && extra.toolcheck) {
    const tc = extra.toolcheck;
    if (tc.stateless_tools_list) {
      const st = tc.stateless_tools_list;
      console.error(`TOOLCHECK-list  : ${st.tools != null ? st.tools + ' tool(s); outputSchema declared: ' + st.outputSchema_declared + '; inputSchema w/ required: ' + st.inputSchema_with_required : (st.verdict || ('error ' + st.error))}${st.resultType ? ', resultType: ' + st.resultType : ''}`);
    }
    if (tc.unknown_tool_modern) {
      const um = tc.unknown_tool_modern;
      console.error(`TOOLCHECK-unk-mod: ${um.channel}${um.code != null ? ' (code ' + um.code + ')' : ''}${um.message ? ' — ' + um.message : ''}${um.resultType ? ', resultType: ' + um.resultType : ''} (route: stateless @${LATEST})`);
    }
    if (tc.unknown_tool_legacy) {
      const ul = tc.unknown_tool_legacy;
      const ulTxt = ul.verdict || (ul.channel + (ul.code != null ? ' (code ' + ul.code + ')' : '') + (ul.message ? ' — ' + ul.message : ''));
      console.error(`TOOLCHECK-unk-legacy: ${ulTxt}`);
    }
  }
  if (extra && extra.real_tool_call) {
    const rc = extra.real_tool_call;
    console.error(`CALL (real)     : ${rc.tool ? rc.tool + ' -> ' : ''}${rc.channel}${rc.code != null ? ' (code ' + rc.code + ')' : ''}${rc.resultType ? ', resultType: ' + rc.resultType : ''}${rc.has_structuredContent ? ', structuredContent PRESENT' : ''}`);
  }
  const verdict = modernOk ? `modern-era server (${LATEST}, stateless) — implements server/discover with ${LATEST} in supportedVersions`
    : (served.includes(LATEST) && !(bc && bc.echo)) ? `serves the ${LATEST} era via initialize`
    : (bc && bc.echo) ? `echoes ANY requested era verbatim (${BOGUS_ERAS.join(', ')} confirmed) — negotiation is decorative (typescript-sdk#2977 failure class, decorative-negotiation variant)`
    : (bc && bogusNote && bogusNote.startsWith('constant-answer')) ? bogusNote
    : newest ? `serves ${newest} only — a ${LATEST}-only client cannot use this server (typescript-sdk#2977 failure class)`
    : downgradedTo.length ? `serves NOTHING verbatim; downgrades to ${downgradedTo.join(', ')} — every answered handshake used an older era (typescript-sdk#2977 failure class)`
    : 'serves NOTHING (all handshakes failed)';
  console.error(`VERDICT: ${verdict}`);
  const strictModern = extra && extra._strictModern;
  const restExtra = extra ? (({ discover, _strictModern, ...rest }) => rest)(extra) : {};
  console.log(JSON.stringify({ target, eras: ERAS, rows: rows.map(({ session_id, ...rest }) => rest), served, downgradedTo, one_initialize: oneInit || undefined, ...(disc ? { discover: disc } : {}), ...(bc ? { blind_echo: bc.echo || undefined, bogus_check: bc } : {}), verdict, probed_at: new Date().toISOString(), tool: 'mcp-era-probe/0.8.2', ...restExtra }));
  if (strict && !(served.includes(LATEST) && !(bc && bc.echo))) process.exit(1);
  if (strictModern && !modernOk) process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const headers = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--header') {
      const v = argv[i + 1] || '';
      const m = v.match(/^([^:]+):\s*(.*)$/);
      if (!m) { console.error(`--header needs "Name: value", got "${v}"`); process.exit(64); }
      headers[m[1].trim()] = m[2].trim();
      i++;
    }
  }
  let rows;
  if (argv.includes('--http')) {
    const i = argv.indexOf('--http');
    const url = argv[i + 1];
    if (!url) { console.error('usage: era-probe.js --http <url> [--header "Name: value"] [--strict] [--bogus-check] [--discover]'); process.exit(64); }
    // v0.6: modern-era discovery FIRST (a modern client calls server/discover before
    // anything else; legacy servers answer method-not-found, which is itself evidence).
    let discover = null;
    if (argv.includes('--discover')) {
      discover = await probeDiscoverHttp(url, headers);
      await SLEEP(50);
    }
    rows = [];
    for (const era of ERAS) {
      rows.push(await probeEraHttp(url, headers, era));
      await SLEEP(50); // be gentle: one small POST per era
    }
    let bogus = null;
    if (argv.includes('--bogus-check')) {
      // validation control (v0.3): a server that echoes a FICTIONAL era verbatim does
      // not read protocolVersion at all — its per-era "served verbatim" rows prove
      // nothing. Two fictional eras, one below and one above every real one.
      bogus = {};
      for (const be of BOGUS_ERAS) {
        const r = await probeEraHttp(url, headers, be);
        bogus[be] = r.served || null;
        await SLEEP(50);
      }
      bogus.echo = BOGUS_ERAS.every((be) => bogus[be] === be);
    }
    // polite-client cleanup: close the sessions we opened, once, after the matrix
    // v0.6 --discover-last: run server/discover INSIDE the last open session before
    // cleanup (many legacy HTTP servers reject session-less requests outright).
    let discoverLast = null;
    const sidsPre = [...new Set(rows.map((r) => r.session_id).filter(Boolean))];
    if (argv.includes('--discover-last') && sidsPre.length) {
      discoverLast = await probeDiscoverHttp(url, headers, { sessionId: sidsPre[sidsPre.length - 1] });
      await SLEEP(50);
    }
    // v0.7: read-only behavior checks (origin-403, stateless tools/list shape,
    // order determinism, bogus cursor) — before session cleanup.
    let behavior = null;
    if (argv.includes('--behavior')) {
      behavior = await behaviorHttp(url, headers);
      await SLEEP(50);
    }
    // v0.8: tool-call channel checks (zero-execution unless --call-tool given)
    const uni = argv.indexOf('--unknown-name');
    if (uni !== -1) unknownToolOverride = String(argv[uni + 1] || '').trim() || null;
    let toolcheck = null;
    if (argv.includes('--toolcheck')) {
      toolcheck = await toolcheckHttp(url, headers);
      await SLEEP(50);
    }
    let realCall = null;
    const cti = argv.indexOf('--call-tool');
    if (cti !== -1) {
      const cname = argv[cti + 1];
      const cai = argv.indexOf('--call-args');
      let cargs = {};
      if (cai !== -1) { try { cargs = JSON.parse(argv[cai + 1]); } catch (e) { console.error('bad --call-args JSON:', e.message); process.exit(64); } }
      console.error(`WARNING: --call-tool = ONE REAL tool execution (${cname}) — operator asserts read-only.`);
      realCall = await callToolHttp(url, headers, cname, cargs);
      await SLEEP(50);
    }
    const sids = [...new Set(rows.map((r) => r.session_id).filter(Boolean))];
    for (const sid of sids.reverse()) {
      try {
        const ctrl = new AbortController();
        const killer = setTimeout(() => ctrl.abort(), 4000);
        await fetch(url, { method: 'DELETE', headers: { ...headers, 'Mcp-Session-Id': sid }, signal: ctrl.signal });
        clearTimeout(killer);
      } catch (_) { /* best effort */ }
    }
    report(url, rows, strict, { transport: 'streamable-http', ...(discover ? { discover } : {}), ...(discoverLast ? { discover_in_session: discoverLast } : {}), ...(behavior ? { behavior } : {}), ...(toolcheck ? { toolcheck } : {}), ...(realCall ? { real_tool_call: realCall } : {}), ...(bogus ? { bogus_check: bogus } : {}), _strictModern: argv.includes('--strict-modern') });
  } else {
    const { cmd, args } = splitArgv(argv);
    // v0.6: stdio modern-era discovery first — the spec's own backward-compatibility
    // probe ("a client that supports both modern and legacy servers SHOULD send
    // server/discover first", stdio Backward Compatibility).
    let discover = null;
    if (argv.includes('--discover')) {
      discover = await probeDiscoverStdio(cmd, args);
      await SLEEP(50);
    }
    rows = [];
    for (const era of ERAS) {
      rows.push(await probeEraStdio(cmd, args, era));
      await SLEEP(50);
    }
    let bogus = null;
    if (argv.includes('--bogus-check')) {
      // v0.4: run the same fictional-era control through the stdio transport.
      // v0.3 shipped this wired into --http only (reported by a real user with a
      // stdio shim — @autenai, dev.to thread on article #14); stdio targets
      // silently skipped the control and could still false-pass a blind echo.
      bogus = {};
      for (const be of BOGUS_ERAS) {
        const r = await probeEraStdio(cmd, args, be);
        bogus[be] = r.served || null;
        await SLEEP(50);
      }
      bogus.echo = BOGUS_ERAS.every((be) => bogus[be] === be);
    }
    // v0.7 stdio behavior: one extra spawn, read-only observations
    let behavior = null;
    if (argv.includes('--behavior')) {
      behavior = await behaviorStdio(cmd, args);
      await SLEEP(50);
    }
    // v0.8 stdio toolcheck + opt-in real call
    const uni = argv.indexOf('--unknown-name');
    if (uni !== -1) unknownToolOverride = String(argv[uni + 1] || '').trim() || null;
    let toolcheck = null;
    if (argv.includes('--toolcheck')) {
      toolcheck = await toolcheckStdio(cmd, args);
      await SLEEP(50);
    }
    let realCall = null;
    const cti = argv.indexOf('--call-tool');
    if (cti !== -1) {
      const cname = argv[cti + 1];
      const cai = argv.indexOf('--call-args');
      let cargs = {};
      if (cai !== -1) { try { cargs = JSON.parse(argv[cai + 1]); } catch (e) { console.error('bad --call-args JSON:', e.message); process.exit(64); } }
      console.error(`WARNING: --call-tool = ONE REAL tool execution (${cname}) — operator asserts read-only.`);
      realCall = await callToolStdio(cmd, args, cname, cargs);
      await SLEEP(50);
    }
    report(`${cmd} ${args.join(' ')}`.trim(), rows, strict, { transport: 'stdio', ...(discover ? { discover } : {}), ...(behavior ? { behavior } : {}), ...(toolcheck ? { toolcheck } : {}), ...(realCall ? { real_tool_call: realCall } : {}), ...(bogus ? { bogus_check: bogus } : {}), _strictModern: argv.includes('--strict-modern') });
  }
}
main();
