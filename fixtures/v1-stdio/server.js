/* Fixture A — the classic pre-2026 server shape: @modelcontextprotocol/sdk (v1 line)
 * McpServer + StdioServerTransport. This is exactly what the official v1->v2 codemod
 * LEAVES BEHIND per typescript-sdk#2977: the code compiles and answers 2025-era
 * clients, but nothing here serves the 2026-07-28 era. */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'fixture-a-legacy', version: '1.0.0' });
server.tool('echo', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `A: ${text}` }] }));

server.connect(new StdioServerTransport()).catch((e) => { console.error(e); process.exit(1); });
