/* Regression fixture for era-probe v0.8.3 (Auten's field report, run-214):
 * answers server/discover, tools/list, tools/call(unknown) then process.exit(0)
 * IMMEDIATELY after writing the last response — reproduces the race where the
 * child's 'exit' event lands before the final stdout 'data' is processed.
 * Pre-fix behavior: clean run stamped toolcheck.spawn = "exited-early". */
'use strict';
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch (_) { continue; }
    const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    if (m.method === 'server/discover') {
      reply(m.id, { supportedVersions: ['2025-11-25'] });
    } else if (m.method === 'tools/list') {
      reply(m.id, { tools: [{ name: 'fixture-tool', description: 'regression fixture' }] });
    } else if (m.method === 'tools/call') {
      reply(m.id, { isError: true, content: [{ type: 'text', text: 'Unknown tool: ' + (m.params && m.params.name) }] });
      // exit IMMEDIATELY — do not wait for stdin close
      setImmediate(() => process.exit(0));
    }
  }
});
