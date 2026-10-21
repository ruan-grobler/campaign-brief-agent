// Stdio MCP server that gives one headless Claude Code agent its tools.
// Claude Code starts one per agent run. Each agent has its own state file, so parallel specialists never share one.
// stdout carries the MCP protocol, so nothing in here may print to it.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadAgencyData } from './data.ts';
import { loadState } from './state.ts';
import { runTool, toolSpecs } from './tools.ts';

const stateFile = process.env.CBA_STATE_FILE;
const logFile = process.env.CBA_LOG_FILE;
if (!stateFile || !logFile) {
  console.error('CBA_STATE_FILE and CBA_LOG_FILE must be set. The orchestrator sets them when it starts an agent.');
  process.exit(1);
}

const ctx = { state: loadState(stateFile), data: loadAgencyData() };
const server = new Server({ name: 'brief', version: '0.2.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolSpecs(ctx.state.scope) }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const outcome = runTool(ctx, stateFile, logFile, request.params.name, request.params.arguments);
  return { content: [{ type: 'text', text: outcome.text }], isError: outcome.isError };
});

await server.connect(new StdioServerTransport());
