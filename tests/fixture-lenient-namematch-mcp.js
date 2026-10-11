/* Regression fixture for era-probe v0.9.2 (autenai field report, run-224): a LENIENT
 * server — serves tools/list even WITHOUT initialize (ordering not enforced), and
 * refuses unknown-tool calls with the SAME -32602 before and after initialize.
 * Expected v0.9.2 verdict: rejects_pre_init: no, basis cites the served pre-init
 * tools/list — the v0.9.1 code called this "yes" (false positive). */
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
    if (m.method === 'initialize') { inited = true; resp(m.id, { result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'lenient-fixture', version: '0.1' } } }); }
    else if (m.method === 'tools/list') { resp(m.id, { result: { tools: [{ name: 'lone-tool' }] } }); }
    else if (m.method === 'tools/call') { resp(m.id, { error: { code: -32602, message: 'Unknown tool' } }); }
    else { resp(m.id, { result: {} }); }
  }
});
