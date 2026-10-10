/* Fixture C-HTTP — positive control over streamable-HTTP: a minimal dependency-free
 * HTTP server that serves the 2026-07-28 era verbatim and refuses any other era
 * with a JSON-RPC error. Plain application/json responses (the spec allows JSON for
 * non-streaming requests). Listens on ERA_FIXTURE_PORT (default 3103). */
'use strict';
const http = require('http');
const SERVED = '2026-07-28';
const PORT = Number(process.env.ERA_FIXTURE_PORT || 3103);

http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }); res.end(JSON.stringify({ error: 'POST only' })); return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let msg; try { msg = JSON.parse(Buffer.concat(chunks).toString()); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); return;
    }
    // a JSON-RPC response needs 200; a notification gets 202 — writeHead exactly once
    const isNotification = msg.id === undefined;
    res.writeHead(isNotification ? 202 : 200, isNotification ? {} : { 'Content-Type': 'application/json' });
    if (msg.method === 'initialize') {
      if (msg.params && msg.params.protocolVersion === SERVED) {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: SERVED, capabilities: { tools: {} }, serverInfo: { name: 'fixture-c-http-current', version: '1.0.0' } } }));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unsupported protocolVersion ${msg.params && msg.params.protocolVersion}; this server serves ${SERVED} only` } }));
      }
    } else if (msg.method === 'tools/list') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] } }));
    } else if (!isNotification) {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    } else {
      res.end();
    }
  });
}).listen(PORT, () => console.error(`fixture-c-http listening on :${PORT} (POST /)`));
