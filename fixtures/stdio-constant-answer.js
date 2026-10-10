#!/usr/bin/env node
/* stdio CONSTANT-ANSWER fixture — answers EVERY initialize (real or fictional era)
 * with the same pinned old era (2024-11-05), then tools/list.
 * v0.5's bogus-check should classify this as "constant-answer — negotiation is
 * fully decorative" (field never varies with the request). */
const readline = require('readline');
const FIXED = '2024-11-05';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'initialize' && msg.id === 1) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: FIXED, capabilities: {}, serverInfo: { name: 'constant-answer', version: '0.9.9' } } }) + '\n');
  } else if (msg.method === 'tools/list' && msg.id === 2) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'pin', description: 'constant-answer fixture tool', inputSchema: { type: 'object' } }] } }) + '\n');
  }
});
