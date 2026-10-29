import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '1' }); await c.connect(new StdioClientTransport({ command: 'node', args: ['packages/mcp/dist/index.js'] }));
console.log((await c.listTools()).tools.map(t => t.name));
for (const [n, a] of [['get_latest_draw', {}], ['get_stats', { window: 50 }], ['generate_tickets', { count: 2 }], ['generate_tickets', { pool: [2,5,9,13,17,20,24,27,30,33] }], ['check_ticket', { red: [3,11,17,22,23,29], blue: 9, issue: '2026124' }], ['check_ticket', { red: [1,2,3,4,5,6], blue: 1, issue: '2099001' }], ['rank_candidates', { count: 2 }]])
  console.log(n, (await c.callTool({ name: n, arguments: a })).content[0].text.replace(/\s+/g, ' ').slice(0, 200));
await c.close();
