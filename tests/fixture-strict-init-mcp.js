/* Regression fixture for era-probe v0.9 handshake control: a STRICT server that
 * enforces initialize-before-requests — any non-initialize request first gets
 * error -32002 (not-initialized style). Used to verify rejects_pre_init: yes. */
'use strict';
process.stdin.setEncoding('utf8');
let buf = '';
let inited = false;
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    const resp = (id, msg) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id }, msg)) + '\n');
    if (m.method === 'initialize') { inited = true; resp(m.id, { result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'strict-fixture', version: '0.1' } } }); }
    else if (!inited) { resp(m.id, { error: { code: -32002, message: 'Server not initialized' } }); }
    else if (m.method === 'tools/list') { resp(m.id, { result: { tools: [{ name: 'strict-tool' }] } }); }
    else if (m.method === 'tools/call') { resp(m.id, { result: { isError: true, content: [{ type: 'text', text: 'Unknown tool: ' + (m.params && m.params.name) }] } }); }
    else { resp(m.id, { result: {} }); }
  }
});
