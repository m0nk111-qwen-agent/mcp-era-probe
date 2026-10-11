#!/usr/bin/env node
/* Tool-check sweep 2026-10-11 — era-probe v0.8 --toolcheck across:
 *  - the 7 verified strict/lenient modern-or-dual HTTP servers (discover-sweep 2026-10-10)
 *  - 3 legacy-era contrast servers (2025-11-25 max, sessions granted, behavior-sweep 2026-10-11)
 * Zero-execution probes only: stateless tools/list coverage + tools/call of a tool
 * name that cannot exist, modern route + legacy-route control.
 * Gentle: concurrency 2, one run per target. Output: census/toolcheck-2026-10-11/
 * usage: node toolcheck-sweep-2026-10-11.js            (all 10)
 *        node toolcheck-sweep-2026-10-11.js <substring>  (just matching targets)
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUTDIR = path.join(__dirname, '..', 'census', 'toolcheck-2026-10-11');
fs.mkdirSync(OUTDIR, { recursive: true });

const COHORT = [
  // verified modern-or-dual (census/discover-sweep-2026-10-10/verified-modern-era.json)
  { name: 'mcp.goji.agency', url: 'https://mcp.goji.agency/mcp', class: 'strict-modern' },
  { name: 'mcp.projectory.ae', url: 'https://mcp.projectory.ae/mcp', class: 'strict-modern' },
  { name: 'mcp.getle.ad', url: 'https://mcp.getle.ad/mcp', class: 'strict-dual-era-4' },
  { name: 'mcp.botinfo.ai', url: 'https://mcp.botinfo.ai/mcp', class: 'strict-modern' },
  { name: 'bidclub.ai', url: 'https://bidclub.ai/api/mcp', class: 'strict-modern' },
  { name: 'bizmoon.ai', url: 'https://bizmoon.ai/api/mcp', class: 'strict-modern' },
  { name: 'api.askmiles.ai', url: 'https://api.askmiles.ai/mcp', class: 'genuine-lenient' },
  // legacy contrast (behavior-sweep-2026-10-11: max 2025-11-25, sessions granted)
  { name: 'agentberg.ai', url: 'https://agentberg.ai/mcp', class: 'legacy-2025-11-25' },
  { name: 'mcp.aivonic.ai', url: 'https://mcp.aivonic.ai', class: 'legacy-2025-11-25' },
  { name: 'mcp.autonomad.ai', url: 'https://mcp.autonomad.ai/mcp', class: 'legacy-2025-11-25' },
];

const filter = process.argv[2] || '';
const targets = COHORT.filter((t) => t.name.includes(filter));

function runOne(t) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, '..', 'era-probe.js'), '--http', t.url, '--discover', '--toolcheck'];
    const p = spawn('node', args, { cwd: __dirname });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 75000);
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('exit', (code) => {
      clearTimeout(timer);
      let json = null;
      const line = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      try { json = line ? JSON.parse(line) : null; } catch (_) {}
      resolve({ name: t.name, url: t.url, class: t.class, exit: code, json, stderr_tail: stderr.split('\n').filter(Boolean).slice(-8) });
    });
  });
}

async function main() {
  const results = [];
  for (let i = 0; i < targets.length; i += 2) {
    const batch = targets.slice(i, i + 2);
    const rs = await Promise.all(batch.map(runOne));
    for (const r of rs) {
      results.push(r);
      fs.writeFileSync(path.join(OUTDIR, `${r.name.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(r.json || { error: 'no-json', stderr_tail: r.stderr_tail }, null, 1));
      const tc = r.json && r.json.toolcheck;
      console.log(`== ${r.name} (${r.class}) exit=${r.exit}`);
      if (tc) {
        const st = tc.stateless_tools_list || {};
        console.log(`   list: ${st.tools != null ? st.tools + ' tools, outputSchema=' + st.outputSchema_declared + ', req-args=' + st.inputSchema_with_required + ', resultType=' + (st.resultType || '-') : JSON.stringify(st).slice(0, 100)}`);
        const um = tc.unknown_tool_modern || {};
        console.log(`   unk-modern: ${JSON.stringify(um).slice(0, 160)}`);
        const ul = tc.unknown_tool_legacy || {};
        console.log(`   unk-legacy: ${JSON.stringify(ul).slice(0, 160)}`);
      } else {
        console.log(`   NO toolcheck — ${r.stderr_tail.join(' | ').slice(0, 200)}`);
      }
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  fs.writeFileSync(path.join(OUTDIR, '_sweep-meta.json'), JSON.stringify({ date: '2026-10-11', probe: 'mcp-era-probe v0.8.0 --toolcheck (--discover)', zero_execution: true, cohort: targets.map((t) => ({ name: t.name, url: t.url, class: t.class })), note: 'unknown-tool name: era-probe-nonexistent-tool (cannot exist); no real tool was invoked in this sweep' }, null, 1));
  console.log(`\nwrote ${results.length} artifacts -> ${OUTDIR}`);
}
main();
