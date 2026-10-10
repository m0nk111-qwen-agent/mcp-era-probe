#!/usr/bin/env node
/* era-census.js v0.3 — run mcp-era-probe against a cohort of endpoints (census mode).
 *
 *   node era-census.js --cohort <scorecard-or-list.json> --out <census.json> [--concurrency 10] [--bogus-check]
 *
 * Cohort JSON: either a previous probe output with results[].url, or {results:[{url,...}]}
 * shape — anything with an array of objects carrying a `url` field works; or a bare
 * ["https://...", ...] list.
 *
 * Per endpoint: spawn `era-probe.js --http <url>` (optionally --bogus-check), parse its
 * single stdout JSON line, collect the matrix. Counters are computed on COPIES of the
 * stored arrays (v0.3 fix: the first sweep mutated `served` in place via sort+pop and
 * corrupted 66/78 doc arrays while the counters stayed correct — never sort/pop stored
 * data). Exits 0 on completion; individual endpoint failures are data, not crashes.
 *
 * Validation history: 78-endpoint census 2026-10-10 (0/78 genuinely validate-and-serve
 * the newest era; 6 blind-echo servers exposed by --bogus-check; 66/78 silent downgraders).
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- args ----
const argv = process.argv.slice(2);
function arg(name, dflt) { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1]; }
const cohortPath = arg('--cohort');
const outPath = arg('--out', 'census.json');
const CONC = Number(arg('--concurrency', '10'));
const BOGUS = argv.includes('--bogus-check');
if (!cohortPath) { console.error('usage: era-census.js --cohort <list.json> --out <census.json> [--concurrency 10] [--bogus-check]'); process.exit(64); }

const HERE = path.dirname(__filename);
const PROBE = path.join(HERE, 'era-probe.js');

// ---- cohort ----
const raw = JSON.parse(fs.readFileSync(cohortPath, 'utf8'));
const items = Array.isArray(raw) ? raw.map((u) => ({ url: u }))
  : (raw.results ? (Array.isArray(raw.results) ? raw.results : Object.values(raw.results)) : []);
const cohort = items.filter((r) => r && r.url).map((r) => ({ url: r.url, oct6_negotiated: r.negotiated || undefined }));
if (!cohort.length) { console.error('no endpoints with `url` found in ' + cohortPath); process.exit(64); }
console.error(`era-census: ${cohort.length} endpoints, concurrency ${CONC}, bogus-check ${BOGUS ? 'on' : 'off'}`);

function probeOnce(url) {
  return new Promise((resolve) => {
    const args = [PROBE, '--http', url];
    if (BOGUS) args.push('--bogus-check');
    const child = spawn('node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); }, 30000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', () => {
      clearTimeout(t);
      const jline = out.trim().split('\n').filter(Boolean).pop();
      if (!jline) return resolve({ url, error: `no JSON line (stderr: ${err.slice(-120).replace(/\s+/g, ' ')})` });
      try {
        const j = JSON.parse(jline);
        resolve({ url, oct6_negotiated: undefined, result: { rows: j.rows, served: j.served, downgradedTo: j.downgradedTo, one_initialize: j.one_initialize || false, blind_echo: j.blind_echo || false, verdict: j.verdict, probed_at: j.probed_at } });
      } catch (e) { resolve({ url, error: `unparseable JSON line: ${e.message}` }); }
    });
    child.on('error', (e) => { clearTimeout(t); resolve({ url, error: `spawn failed: ${e.message}` }); });
  });
}

(async () => {
  const started = Date.now();
  const results = new Array(cohort.length);
  let i = 0, done = 0;
  async function worker() {
    while (i < cohort.length) {
      const idx = i++;
      results[idx] = await probeOnce(cohort[idx].url);
      done++;
      const r = results[idx].result;
      console.error(`[${done}/${cohort.length}] ${cohort[idx].url} -> ${results[idx].error ? 'ERROR' : (r.blind_echo ? 'BLIND-ECHO ' : '') + (r.rows.filter((x) => x.outcome === 'served').length ? 'serves ' + r.served.join(',') : 'nothing')}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, cohort.length) }, worker));

  // ---- counters (on copies — never mutate stored arrays) ----
  const byNewest = {}, cls = {};
  for (const r of results) {
    const res = r.result;
    if (!res) { cls[r.error ? 'error' : 'unknown'] = (cls[r.error ? 'error' : 'unknown'] || 0) + 1; continue; }
    if (res.blind_echo) cls['blind-echo'] = (cls['blind-echo'] || 0) + 1;
    const served = [...(res.served || [])]; // COPY: see header note
    let key;
    if (!served.length) key = 'serves-nothing-verbatim';
    else if (served.includes('2026-07-28')) key = 'serves-2026-07-28';
    else key = 'max:' + served.sort().pop();
    byNewest[key] = (byNewest[key] || 0) + 1;
    const silent = served.length > 0 && !served.includes('2026-07-28');
    if (silent) cls['silent-downgraders'] = (cls['silent-downgraders'] || 0) + 1;
  }
  const doc = {
    probe: 'mcp-era-probe census (era-census.js)',
    tool_version: '0.3.0',
    ts: new Date().toISOString(),
    cohort_source: path.basename(cohortPath),
    n: cohort.length,
    elapsed_s: Math.round((Date.now() - started) / 1000),
    bogus_check: BOGUS,
    counters: { by_newest_served: byNewest, classes: cls },
    results,
  };
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 1));
  console.error(JSON.stringify(doc.counters, null, 1));
  console.error(`era-census: wrote ${outPath}`);
})();
