#!/usr/bin/env node
/* mcp-era-probe v0.1 — which protocol eras does an MCP stdio server actually serve?
 *
 * Sends an `initialize` handshake for each known MCP protocol version (era) over stdio,
 * one fresh server process per era, and reports what the server accepted / downgraded /
 * rejected. Catches the failure class of modelcontextprotocol/typescript-sdk#2977:
 * a migrated server that "compiles, passes default tests, answers the Inspector",
 * yet only serves the previous era — invisibly.
 *
 * Usage:   node era-probe.js -- <command to launch the server> [args...]
 * Example: node era-probe.js -- node fixtures/v1-stdio/server.js
 * Output:  per-era lines + a verdict line. Exit 0 always (probe succeeded); use
 *          --strict to exit 1 when any requested era is not served verbatim.
 * No dependencies. */
'use strict';
const { spawn } = require('child_process');

const ERAS = ['2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28'];
const HANDSHAKE_TIMEOUT_MS = Number(process.env.ERA_PROBE_TIMEOUT || 10000);

function splitArgv(argv) {
  const i = argv.indexOf('--');
  if (i === -1) {
    console.error('usage: era-probe.js -- <server command> [args...]');
    process.exit(64);
  }
  return { cmd: argv[i + 1], args: argv.slice(i + 2) };
}

/** Run one initialize handshake against a fresh server process. */
function probeEra(cmd, args, era) {
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

    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: era, capabilities: {}, clientInfo: { name: 'mcp-era-probe', version: '0.1.0' } } };
    child.stdin.write(JSON.stringify(init) + '\n');
    child.stderr.resume(); // drain server logs
  });
}

async function main() {
  const { cmd, args } = splitArgv(process.argv.slice(2));
  const strict = process.argv.includes('--strict');
  const rows = [];
  for (const era of ERAS) {
    const r = await probeEra(cmd, args, era);
    rows.push(r);
    const mark = r.outcome === 'served' ? 'ACCEPTED ' : r.outcome === 'downgraded' ? 'DOWNGRADE' : r.outcome.toUpperCase().padEnd(9);
    console.error(`${mark}  ${era}  ${r.outcome === 'downgraded' ? `-> serves ${r.served}` : ''}${r.detail ? '  (' + r.detail + ')' : ''}`);
  }
  const served = rows.filter((r) => r.outcome === 'served').map((r) => r.era);
  const downgradedTo = [...new Set(rows.filter((r) => r.outcome === 'downgraded').map((r) => r.served))];
  console.error('---');
  console.error(`served verbatim : ${served.length ? served.join(', ') : '(none)'}`);
  if (downgradedTo.length) console.error(`downgraded to   : ${downgradedTo.join(', ')}  <- 2026-07-28-era clients will NOT get this era`);
  const verdict = served.includes('2026-07-28') ? 'serves the 2026-07-28 era'
    : served.length ? `serves ${served[served.length - 1]} only — a 2026-07-28-only client cannot use this server (typescript-sdk#2977 failure class)`
    : 'serves NOTHING (all handshakes failed)';
  console.error(`VERDICT: ${verdict}`);
  console.error(JSON.stringify({ server: `${cmd} ${args.join(' ')}`.trim(), eras: ERAS, rows, served, downgradedTo, verdict, probed_at: new Date().toISOString(), tool: 'mcp-era-probe/0.1.0' }));
  if (strict && !served.includes('2026-07-28')) process.exit(1);
}
main();
