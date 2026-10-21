import type { Effort } from '../config.ts';
import type { Scope, Team } from '../types.ts';

export interface AgentCall {
  scope: Scope;
  team?: Team;
  stateFile: string;
  logFile: string;
  system: string;
  prompt: string;
  maxSteps: number;
  effort: Effort;
  timeoutMs: number;
}

// How the agent process ended. Whether its work is finished comes from its state file, not from here.
export interface AgentStats {
  stop: 'completed' | 'turn_cap' | 'timeout' | 'error';
  modelCalls: number;
  durationMs: number;
  costUsd?: number;
  detail?: string;
}

export interface StructuredCall {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  effort: Effort;
  timeoutMs: number;
}

export interface StructuredResult {
  data: unknown;
  modelCalls: number;
  durationMs: number;
  costUsd?: number;
}

export interface AgentEvents {
  onToolCall: (callId: string, name: string, input: unknown) => void;
  onToolResult: (callId: string, name: string, ok: boolean, text: string) => void;
  onText: (text: string) => void;
}

export interface Runtime {
  id: 'claude-code' | 'claude-api' | 'replay';
  label: string;
  runAgent: (call: AgentCall, events: AgentEvents) => Promise<AgentStats>;
  structured: (call: StructuredCall) => Promise<StructuredResult>;
}
