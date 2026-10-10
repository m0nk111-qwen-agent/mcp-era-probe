/* Fixture C — positive control: a minimal dependency-free stdio server that
 * implements the 2026-07-28 era only. Use it to see what a fully era-current
 * server looks like to the probe (all older eras downgraded/rejected, 2026-07-28
 * accepted verbatim). */
const readline = require('readline');
const SERVED = '2026-07-28';
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch (_) { return; }
  if (msg.method === 'initialize') {
    if (msg.params && msg.params.protocolVersion === SERVED) {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: SERVED, capabilities: { tools: {} }, serverInfo: { name: 'fixture-c-current', version: '1.0.0' } } });
    } else {
      // strict server: refuse any other era outright
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unsupported protocolVersion ${msg.params && msg.params.protocolVersion}; this server serves ${SERVED} only` } });
    }
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }
});
process.stdin.resume();
