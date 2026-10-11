/* Regression fixture for era-probe v0.9.2 fallback path: pre-init it answers ONLY
 * tools/call (with -32602, same as post-init) and stays SILENT on pre-init tools/list.
 * Expected verdict: indeterminate, basis "pre-init error -32602 matches post-init
 * error (name-based refusal, not ordering)" — the fallback autenai described. */
'use strict';
process.stdin.setEncoding('utf8');
let buf = '';
let inited = false;
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    const resp = (id, msg) => process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: '2.0', id }, msg)) + '\n');
    if (m.method === 'initialize') { inited = true; resp(m.id, { result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'silent-list-fixture', version: '0.1' } } }); }
    else if (!inited && m.method === 'tools/list') { /* silent: no answer */ }
    else if (m.method === 'tools/call') { resp(m.id, { error: { code: -32602, message: 'Unknown tool' } }); }
    else if (inited && m.method === 'tools/list') { resp(m.id, { result: { tools: [{ name: 'late-tool' }] } }); }
    else { resp(m.id, { result: {} }); }
  }
});
