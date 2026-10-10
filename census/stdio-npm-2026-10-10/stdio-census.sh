#!/bin/bash
# stdio-census.sh — npm MCP launcher cohort, probed with era-probe v0.4 stdio + --bogus-check.
# SAFETY: every phase runs under env -i with a scrubbed environment (no wallet/token vars,
# throwaway HOME/TMPDIR/npm cache in /tmp/stdio-census, cwd /tmp/stdio-census/run).
set -u
BASE=/tmp/stdio-census
SC=/tmp/stdio-census/run
SCRUB=(env -i PATH="$PATH" HOME="$BASE/home" TMPDIR="$BASE/tmp" npm_config_cache="$BASE/npmcache")
mkdir -p "$SC" "$BASE/out"
cd "$SC"

# pkg|version|binname (binname empty = auto-detect via npm ls --json bins)
PKGS=(
"chrome-devtools-mcp|latest|"
"@upstash/context7-mcp|latest|"
"@modelcontextprotocol/server-filesystem|latest|"
"hostinger-api-mcp|latest|"
"@notionhq/notion-mcp-server|latest|"
"@azure/mcp|latest|"
"@currents/mcp|latest|"
"@sentry/mcp-server|latest|"
"@sap-ux/fiori-mcp-server|latest|"
"@ui5/mcp-server|latest|"
"scryfall-mcp-server|latest|"
"@aikidosec/mcp|latest|"
"@apify/actors-mcp-server|latest|"
"@zencoderai/slack-mcp-server|latest|"
"@winor30/mcp-server-datadog|latest|"
"@autenai/mcp|0.1.4|"
)

PROBE=/workspace/.tmp-tests/era-probe/era-probe.js
OUT=$BASE/out/stdio-census.jsonl
: > "$OUT"

for row in "${PKGS[@]}"; do
  pkg="${row%%|*}"; rest="${row#*|}"; ver="${rest%%|*}"; bin="${rest#*|}"
  echo "=== $pkg@$ver"
  PDIR="$SC/$(echo "$pkg" | tr '/@' '__')"
  mkdir -p "$PDIR"
  if [ ! -e "$PDIR/node_modules/.package-lock.json" ]; then
    ( cd "$PDIR" && "${SCRUB[@]}" npm install --no-audit --no-fund --loglevel=error "$pkg@$ver" > "$BASE/out/$(echo "$pkg"|tr '/@' '__')-install.log" 2>&1 )
    rc=$?
    echo "install rc=$rc"
    [ $rc -ne 0 ] && echo "{\"package\":\"$pkg\",\"version\":\"$ver\",\"outcome\":\"install-failed\"}" >> "$OUT" && continue
  fi
  # locate the bin (package.json bin field -> node_modules/.bin/<name>) or fall back to main
  BINPATH=$( cd "$PDIR" && "${SCRUB[@]}" node -e "
    const fs=require('fs');
    let pj={};
    for (const p of ['node_modules/'+process.argv[1].replace(/^@/,'node_modules/@').split('/').slice(0,2).join('/').replace(/__nope/,''), 'node_modules/'+process.argv[1]]) {
      try { const j=JSON.parse(fs.readFileSync('node_modules/'+process.argv[1]+'/package.json','utf8')); pj=j; break; } catch(e){}
    }
    const b = typeof pj.bin==='string'? pj.bin : (pj.bin? Object.values(pj.bin)[0] : pj.main);
    console.log(b || '');
  " "$pkg" 2>/dev/null )
  if [ -z "$BINPATH" ]; then echo "{\"package\":\"$pkg\",\"version\":\"$ver\",\"outcome\":\"no-bin\"}" >> "$OUT"; continue; fi
  FULL="$PDIR/node_modules/$pkg/$BINPATH"
  case "$BINPATH" in /*) FULL="$BINPATH";; esac
  [ -e "$FULL" ] || FULL=$(find "$PDIR/node_modules/$pkg" -name "$(basename "$BINPATH")" -type f 2>/dev/null | head -1)
  if [ ! -e "$FULL" ]; then echo "{\"package\":\"$pkg\",\"version\":\"$ver\",\"outcome\":\"bin-not-found\"}" >> "$OUT"; continue; fi
  echo "probe bin: $FULL"
  ( cd "$SC" && "${SCRUB[@]}" node "$PROBE" --strict --bogus-check -- node "$FULL" > "$BASE/out/$(echo "$pkg"|tr '/@' '__')-probe.json" 2>"$BASE/out/$(echo "$pkg"|tr '/@' '__')-probe.err" )
  rc=$?
  # normalize into the census line: take the last {..} line of probe output
  RES=$(grep -ao '{.*}' "$BASE/out/$(echo "$pkg"|tr '/@' '__')-probe.json" | tail -1)
  if [ -z "$RES" ]; then RES='{}'; fi
  RES=$(echo "$RES" | python3 -c "
import json,sys
try:
    d=json.loads(sys.stdin.read())
    print(json.dumps({'package':'''$pkg''','version':'''$ver''','bin':'$(basename "$FULL")','strict_rc':'$rc','verdict':d.get('verdict'),'served':d.get('served'),'blind_echo':bool(d.get('blind_echo')),'bogus_check':d.get('bogus_check'),'transport':'stdio'}))
except Exception as e:
    print(json.dumps({'package':'''$pkg''','version':'''$ver''','strict_rc':'$rc','outcome':'parse-error','detail':str(e)[:60]}))
")
  echo "$RES" >> "$OUT"
  echo "  -> $RES"
done
echo "=== DONE; results in $OUT"
