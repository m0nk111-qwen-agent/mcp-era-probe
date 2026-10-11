#!/usr/bin/env node
/* Consistency re-check (skeptic cheapest-check #1, 2026-10-11): each strict-modern
 * target is probed with TWO DISTINCT impossible tool names (default + --unknown-name
 * override). Conformance claim holds only if both names classify identically. */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const OUTDIR = path.join(__dirname, 'toolcheck-2026-10-11');
const PROBE = path.join(__dirname, '..', 'era-probe.js');
const TARGETS = [
  ['mcp.goji.agency', 'https://mcp.goji.agency/mcp'],
  ['mcp.projectory.ae', 'https://mcp.projectory.ae/mcp'],
  ['mcp.botinfo.ai', 'https://mcp.botinfo.ai/mcp'],
  ['bidclub.ai', 'https://bidclub.ai/api/mcp'],
  ['bizmoon.ai', 'https://bizmoon.ai/api/mcp'],
  ['api.askmiles.ai', 'https://api.askmiles.ai/mcp'],
];
const NAME2 = 'era-probe-ghost-tool-2099'; // second impossible name
function run(url, extraArgs) {
  return new Promise((resolve) => {
    const p = spawn('node', [PROBE, '--http', url, '--toolcheck', ...extraArgs]);
    let stdout = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 60000);
    p.stdout.on('data', (d) => { stdout += d; });
    p.on('exit', () => { clearTimeout(t);
      const line = stdout.split('\n').filter((l) => l.trim().startsWith('{')).pop();
      let j = null; try { j = line ? JSON.parse(line) : null; } catch (_) {}
      resolve(j && j.toolcheck ? j.toolcheck : { error: 'no-toolcheck' });
    });
  });
}
(async () => {
  const out = {};
  for (const [name, url] of TARGETS) {
    const pass1 = await run(url, []);
    await new Promise((r) => setTimeout(r, 1200));
    const pass2 = await run(url, ['--unknown-name', NAME2]);
    const sig = (tc) => tc.unknown_tool_modern ? `${tc.unknown_tool_modern.channel}/${tc.unknown_tool_modern.code}` : JSON.stringify(tc).slice(0, 40);
    out[name] = {
      name1: pass1.unknown_tool_name || 'era-probe-nonexistent-tool', result1: sig(pass1),
      name2: pass2.unknown_tool_name || NAME2, result2: sig(pass2),
      consistent: sig(pass1) === sig(pass2) && sig(pass1) !== 'undefined/undefined',
    };
    console.log(`${name}: pass1=${out[name].result1} pass2=${out[name].result2} => ${out[name].consistent ? 'CONSISTENT' : 'MISMATCH'}`);
    await new Promise((r) => setTimeout(r, 1200));
  }
  fs.writeFileSync(path.join(OUTDIR, '_consistency-second-name.json'), JSON.stringify({ date: '2026-10-11', purpose: 'skeptic cheapest-check #1: second impossible name, one call each per target', zero_execution: true, second_name: NAME2, results: out }, null, 1));
  console.log('written');
})();
