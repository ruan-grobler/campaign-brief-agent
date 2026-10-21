// Runtime for machines without an API key: headless Claude Code (`claude -p`) on the user's Claude plan.
// The tools reach each agent through its own local MCP server.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { LIMITS, MODEL, PATHS, type Effort } from '../config.ts';
import type { AgentCall, AgentEvents, AgentStats, Runtime, StructuredCall, StructuredResult } from './types.ts';

const TOOL_PREFIX = 'mcp__brief__';

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { content?: Block[] };
  mcp_servers?: { name: string; status: string }[];
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  terminal_reason?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
}

// Isolation: no built-in tools, none of the user's settings, hooks, CLAUDE.md or MCP servers, no saved session.
const baseArgs = (system: string, effort: Effort): string[] => [
  '--model', MODEL,
  '--effort', effort,
  '--system-prompt', system,
  '--tools', '',
  '--setting-sources', '',
  '--strict-mcp-config',
  '--permission-mode', 'dontAsk',
  '--no-session-persistence',
];

// Some Claude hosts set this variable, which strips the mcp__brief__ prefix from tool names.
const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX;
  return env;
};

const parseEvent = (line: string): StreamEvent | undefined => {
  try {
    return JSON.parse(line) as StreamEvent;
  } catch {
    return undefined;
  }
};

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
};

interface SpawnOutcome {
  code: number | null;
  timedOut: boolean;
  stderr: string;
}

const spawnClaude = (args: string[], timeoutMs: number, onEvent: (event: StreamEvent, stop: () => void) => void): Promise<SpawnOutcome> =>
  new Promise((resolve, reject) => {
    mkdirSync(PATHS.agentCwd, { recursive: true });
    const child = spawn('claude', args, { cwd: PATHS.agentCwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = (): void => {
      child.kill('SIGTERM');
    };
    let buffer = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const flush = (line: string): void => {
      const event = line.trim() ? parseEvent(line) : undefined;
      if (event) onEvent(event, stop);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(flush);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      flush(buffer);
      resolve({ code, timedOut, stderr });
    });
  });

const runAgent = async (call: AgentCall, events: AgentEvents): Promise<AgentStats> => {
  const mcpConfig = call.stateFile.replace(/\.json$/, '.mcp.json');
  const env = { CBA_STATE_FILE: call.stateFile, CBA_LOG_FILE: call.logFile };
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { brief: { command: process.execPath, args: [PATHS.mcpServer], env } } }, null, 2));
  const args = [
    '-p', call.prompt,
    ...baseArgs(call.system, call.effort),
    '--mcp-config', mcpConfig,
    '--allowedTools', 'mcp__brief',
    // Hard backstop behind the tool server's step budget.
    '--max-turns', String(call.maxSteps + LIMITS.turnCapSlack),
    '--output-format', 'stream-json',
    '--verbose',
  ];

  const toolNames = new Map<string, string>();
  let result: StreamEvent | undefined;
  let serverProblem = '';
  const outcome = await spawnClaude(args, call.timeoutMs, (event, stop) => {
    if (event.type === 'system' && event.subtype === 'init') {
      const status = event.mcp_servers?.find((server) => server.name === 'brief')?.status ?? 'missing';
      if (status !== 'connected' && status !== 'pending') {
        serverProblem = status;
        stop();
      }
    }
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use' && block.id && block.name) {
        const name = block.name.replace(TOOL_PREFIX, '');
        toolNames.set(block.id, name);
        events.onToolCall(block.id, name, block.input);
      } else if (event.type === 'assistant' && block.type === 'text' && block.text?.trim()) {
        events.onText(block.text);
      } else if (event.type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
        events.onToolResult(block.tool_use_id, toolNames.get(block.tool_use_id) ?? 'tool', !block.is_error, resultText(block.content));
      }
    }
    if (event.type === 'result') result = event;
  });

  if (serverProblem) {
    const check = `CBA_STATE_FILE=${call.stateFile} CBA_LOG_FILE=${call.logFile} node ${PATHS.mcpServer}`;
    throw new Error(`Claude Code could not start the tool server (status: ${serverProblem}). Check it with: ${check}`);
  }
  // One turn is one model request, so turns are the model-call count.
  const base = { modelCalls: result?.num_turns ?? 0, durationMs: result?.duration_ms ?? 0, costUsd: result?.total_cost_usd };
  if (outcome.timedOut) return { ...base, stop: 'timeout', detail: `no result after ${Math.round(call.timeoutMs / 1000)}s` };
  if (result?.terminal_reason === 'max_turns' || result?.subtype === 'error_max_turns') return { ...base, stop: 'turn_cap' };
  if (!result || result.is_error) {
    return { ...base, stop: 'error', detail: (result?.result ?? outcome.stderr.trim().slice(-600)) || `claude exited with code ${outcome.code}` };
  }
  return { ...base, stop: 'completed' };
};

const structured = async (call: StructuredCall): Promise<StructuredResult> => {
  const args = [
    '-p', call.prompt,
    ...baseArgs(call.system, call.effort),
    '--json-schema', JSON.stringify(call.schema),
    '--max-turns', '4',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  let result: StreamEvent | undefined;
  const outcome = await spawnClaude(args, call.timeoutMs, (event) => {
    if (event.type === 'result') result = event;
  });
  if (outcome.timedOut) throw new Error(`no answer after ${Math.round(call.timeoutMs / 1000)}s`);
  if (!result || result.is_error || result.structured_output === undefined) {
    throw new Error((result?.result ?? outcome.stderr.trim().slice(-600)) || `claude exited with code ${outcome.code} without structured output`);
  }
  return { data: result.structured_output, modelCalls: result.num_turns ?? 1, durationMs: result.duration_ms ?? 0, costUsd: result.total_cost_usd };
};

export const claudeCodeRuntime: Runtime = {
  id: 'claude-code',
  label: `headless Claude Code (claude -p) on your Claude plan, ${MODEL}`,
  runAgent,
  structured,
};
