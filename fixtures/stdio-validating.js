#!/usr/bin/env node
/* stdio VALIDATING fixture — the honest-server shape:
 * serves its real latest era (2025-11-25); downgrades requests for newer eras
 * to 2025-11-25; REJECTS unknown eras (incl. fictional ones) with a JSON-RPC error.
 * Used to validate era-probe v0.4's stdio --bogus-check on a genuine server. */
const readline = require('readline');
const REAL = '2025-11-25';
const KNOWN = ['2025-11-25', '2025-06-18', '2025-03-26'];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'initialize' && msg.id === 1) {
    const asked = msg.params && msg.params.protocolVersion;
    if (KNOWN.includes(asked)) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: asked, capabilities: {}, serverInfo: { name: 'honest-stdio', version: '1.0.0' } } }) + '\n');
    } else if (asked === '2026-07-28') {
      // silent-downgrader shape: answer with the real latest without comment
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: REAL, capabilities: {}, serverInfo: { name: 'honest-stdio', version: '1.0.0' } } }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: `unsupported protocolVersion: ${asked}` } }) + '\n');
    }
  } else if (msg.method === 'tools/list' && msg.id === 2) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'real_tool', description: 'honest fixture tool', inputSchema: { type: 'object' } }] } }) + '\n');
  }
});
