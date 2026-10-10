/* Fixture A-HTTP — the post-codemod server shape over streamable-HTTP:
 * @modelcontextprotocol/sdk v1-line (1.32.1) McpServer + StreamableHTTPServerTransport,
 * stateless mode (a fresh transport+server per POST — the canonical SDK stateless
 * example). Same failure class as fixture A over stdio: compiles, answers every
 * era a default client sends, serves only the 2025-11-25 era.
 *
 * Requires: fixtures/v1-stdio/package.json deps installed (`npm i` there, or run with
 * that node_modules on the resolution path). Listens on ERA_FIXTURE_PORT (default 3101). */
'use strict';
const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const PORT = Number(process.env.ERA_FIXTURE_PORT || 3101);

http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' }); res.end(JSON.stringify({ error: 'POST only' })); return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const parsedBody = JSON.parse(Buffer.concat(chunks).toString());
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const server = new McpServer({ name: 'fixture-a-http-legacy', version: '1.0.0' });
      server.tool('echo', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `A: ${text}` }] }));
      res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e.message || e).slice(0, 120) } }));
    }
  });
}).listen(PORT, () => console.error(`fixture-a-http listening on :${PORT} (POST /)`));
