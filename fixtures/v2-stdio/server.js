/* Fixture B — the published "v2" npm line TODAY: @modelcontextprotocol/server@2.3.1
 * (latest on npm as of 2026-10-10) with serveStdio. Notable: even this latest v2
 * package exports LATEST_PROTOCOL_VERSION = '2025-11-25' — the 2026-07-28 spec
 * revision is not yet in the published npm line. Installing "the new major" does
 * not mean getting the new era. */
const { McpServer } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');
const { z } = require('zod');

serveStdio(() => {
  const server = new McpServer({ name: 'fixture-b-v2line', version: '2.0.0' });
  server.registerTool('echo', { description: 'echo', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `B: ${text}` }] }));
  return server;
});
