/* Fixture B-HTTP — the STATEFUL streamable-HTTP shape (SDK default): one
 * McpServer + one StreamableHTTPServerTransport with a real session id
 * (sessionIdGenerator), connected once at startup. This exercises the probe's
 * Mcp-Session-Id handling (initialize grants a session; follow-ups must send it)
 * and the SSE-response path (enableJsonResponse defaults to false). Same v1-line
 * SDK, so same downgrade signature as fixture A-HTTP.
 * Requires the v1-stdio node_modules on the resolution path.
 * Listens on ERA_FIXTURE_PORT (default 3102). */
'use strict';
const http = require('http');
const { randomUUID } = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const PORT = Number(process.env.ERA_FIXTURE_PORT || 3102);

const server = new McpServer({ name: 'fixture-b-http-stateful', version: '1.0.0' });
server.tool('echo', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `B: ${text}` }] }));
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
server.connect(transport).catch((e) => { console.error(e); process.exit(1); });

http.createServer(async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.writeHead(405, { Allow: 'POST, DELETE' }); res.end(); return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const parsedBody = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      await transport.handleRequest(req, res, parsedBody);
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e.message || e).slice(0, 120) } }));
    }
  });
}).listen(PORT, () => console.error(`fixture-b-http (stateful) listening on :${PORT} (POST /)`));
