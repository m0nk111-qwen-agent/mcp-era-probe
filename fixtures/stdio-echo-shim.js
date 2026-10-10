#!/usr/bin/env node
/* stdio ECHO-SHIM fixture — mimics the @autenai 0.1.3 setup-shim shape:
 * answers initialize with WHATEVER protocolVersion the client asked for (verbatim),
 * then answers tools/list. Used to validate era-probe v0.4's stdio --bogus-check. */
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'initialize' && msg.id === 1) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: 'echo-shim', version: '0.0.1' } } }) + '\n');
  } else if (msg.method === 'tools/list' && msg.id === 2) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'noop', description: 'echo-shim tool', inputSchema: { type: 'object' } }] } }) + '\n');
  }
});
