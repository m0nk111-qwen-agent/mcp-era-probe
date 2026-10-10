/**
 * v0.6 fixture: a minimal MODERN-era (2026-07-28, stateless) MCP server.
 * Implements `server/discover` (MUST per spec) and answers tools/list with
 * per-request _meta versioning. Does NOT implement initialize (removed by
 * SEP-2575) — receiving one proves the caller is legacy-only.
 */
const readline = require('readline');

const LATEST = '2026-07-28';

function respond(msg) {
  if (!msg || msg.method == null) return;
  const id = msg.id;
  if (msg.method === 'server/discover') {
    return write(id, { result: {
      resultType: 'complete',
      supportedVersions: [LATEST],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fixture-modern', version: '0.6.0' } },
    } });
  }
  if (msg.method === 'initialize') {
    // A genuine modern server has no initialize handshake. Mirror the spec's
    // UnsupportedProtocolVersionError semantics for a legacy-only caller.
    return write(id, { error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [LATEST], requested: (msg.params && msg.params.protocolVersion) || null } } });
  }
  if (msg.method === 'tools/list') {
    return write(id, { result: { resultType: 'complete', tools: [{ name: 'ping_fixture', description: 'modern fixture tool' }] } });
  }
  return write(id, { error: { code: -32601, message: 'Method not found: ' + msg.method } });
}

function write(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  try { respond(JSON.parse(t)); } catch (_) { /* ignore malformed */ }
});
