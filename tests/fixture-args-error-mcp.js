/* A3 fixture for the args-level error-contract probe: a lenient server whose KNOWN
 * tool, called with a nonexistent/invalid argument, answers a JSON-RPC PROTOCOL ERROR
 * (-32602 Invalid params) instead of the spec's isError result. Tests that the probe
 * records args_contract: protocol-error (vs isError / 200-payload). */
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
    if (m.method === 'initialize') { inited = true; resp(m.id, { result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'args-error-fixture', version: '0.1' } } }); }
    else if (!inited) { resp(m.id, { error: { code: -32002, message: 'Server not initialized' } }); }
    else if (m.method === 'tools/list') { resp(m.id, { result: { tools: [{ name: 'lookup', description: 'looks up an id', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }] } }); }
    else if (m.method === 'tools/call') {
      const params = m.params || {};
      if (!params.id) resp(m.id, { error: { code: -32602, message: 'Invalid params: id required' } });
      else resp(m.id, { result: { isError: false, content: [{ type: 'text', text: 'found ' + params.id }] } });
    }
    else { resp(m.id, { result: {} }); }
  }
});
