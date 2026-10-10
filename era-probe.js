#!/usr/bin/env node
/* mcp-era-probe v0.3 — which protocol eras does an MCP server actually serve?
 *
 * Sends a real `initialize` handshake for each known MCP protocol version ("era") and
 * reports what the server accepted / downgraded / rejected, newest era first. Two
 * transports:
 *
 *   stdio:  node era-probe.js -- <server command> [args...]
 *   http:   node era-probe.js --http <endpoint-url> [--header "Authorization: Bearer x"]
 *                                  [--strict] [--bogus-check]
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
 * CI check for "this server is era-current". No dependencies; HTTP mode needs Node >= 18. */
'use strict';
const { spawn } = require('child_process');

const ERAS_OLDEST_FIRST = ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];
const ERAS = [...ERAS_OLDEST_FIRST].reverse(); // newest first — see header note
const LATEST = ERAS_OLDEST_FIRST[ERAS_OLDEST_FIRST.length - 1];
const HANDSHAKE_TIMEOUT_MS = Number(process.env.ERA_PROBE_TIMEOUT || 10000);
const CLIENT_INFO = { name: 'mcp-era-probe', version: '0.3.0' };
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
                  done({ era, outcome: served === era ? (live ? 'served' : 'served-no-live') : 'downgraded', served, detail: live ? `${(m2.result.tools || []).length} tool(s) listed` : `tools/list ${m2.error ? 'error ' + m2.error.code : 'malformed'}` });
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
  return { ...base, outcome, served, detail: liveDetail, ms: Date.now() - started, session_id: sessionId || undefined };
}

/* ---------- shared reporting ---------- */

/** newest era the server served verbatim (order-independent) */
function newestServed(served) {
  return ERAS_OLDEST_FIRST.filter((e) => served.includes(e)).pop();
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
  if (bc) {
    if (bc.echo) console.error('BOGUS-CHECK     : BLIND ECHO — the server also "serves" ' + BOGUS_ERAS.join(' and ') + ' verbatim; it does not read protocolVersion, so every "served verbatim" line above proves nothing');
    else console.error(`BOGUS-CHECK     : validates (answered ${BOGUS_ERAS.map((be) => bc[be] || 'nothing').join(', ')} to fictional eras)`);
  }
  const verdict = (served.includes(LATEST) && !(bc && bc.echo)) ? `serves the ${LATEST} era`
    : (bc && bc.echo) ? `echoes ANY requested era verbatim (${BOGUS_ERAS.join(', ')} confirmed) — negotiation is decorative (typescript-sdk#2977 failure class, decorative-negotiation variant)`
    : newest ? `serves ${newest} only — a ${LATEST}-only client cannot use this server (typescript-sdk#2977 failure class)`
    : downgradedTo.length ? `serves NOTHING verbatim; downgrades to ${downgradedTo.join(', ')} — every answered handshake used an older era (typescript-sdk#2977 failure class)`
    : 'serves NOTHING (all handshakes failed)';
  console.error(`VERDICT: ${verdict}`);
  console.log(JSON.stringify({ target, eras: ERAS, rows: rows.map(({ session_id, ...rest }) => rest), served, downgradedTo, one_initialize: oneInit || undefined, ...(bc ? { blind_echo: bc.echo || undefined, bogus_check: bc } : {}), verdict, probed_at: new Date().toISOString(), tool: 'mcp-era-probe/0.3.0', ...extra }));
  if (strict && !(served.includes(LATEST) && !(bc && bc.echo))) process.exit(1);
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
    if (!url) { console.error('usage: era-probe.js --http <url> [--header "Name: value"] [--strict] [--bogus-check]'); process.exit(64); }
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
    const sids = [...new Set(rows.map((r) => r.session_id).filter(Boolean))];
    for (const sid of sids.reverse()) {
      try {
        const ctrl = new AbortController();
        const killer = setTimeout(() => ctrl.abort(), 4000);
        await fetch(url, { method: 'DELETE', headers: { ...headers, 'Mcp-Session-Id': sid }, signal: ctrl.signal });
        clearTimeout(killer);
      } catch (_) { /* best effort */ }
    }
    report(url, rows, strict, { transport: 'streamable-http', ...(bogus ? { bogus_check: bogus } : {}) });
  } else {
    const { cmd, args } = splitArgv(argv);
    rows = [];
    for (const era of ERAS) {
      rows.push(await probeEraStdio(cmd, args, era));
      await SLEEP(50);
    }
    report(`${cmd} ${args.join(' ')}`.trim(), rows, strict, { transport: 'stdio' });
  }
}
main();
