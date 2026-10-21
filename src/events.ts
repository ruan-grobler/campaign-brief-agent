// One event stream per run. The terminal, the web control room and the audit log all read the same events,
// so what you watch live is exactly what you can replay later from runs/<run-id>/events.jsonl.
import { appendFileSync } from 'node:fs';
import type { Decision, ReviewPacket } from './approval.ts';
import type { Critique } from './critique.ts';
import type { ScanHit } from './injection.ts';
import type { OutboxPayloads } from './outbox.ts';
import type { RubricCheck } from './rubric.ts';
import type { StateView } from './state.ts';
import type { Scope, Team } from './types.ts';

export type StepKind = 'guard' | 'agent' | 'merge' | 'summary' | 'check' | 'approval' | 'send';
export type StepStatus = 'done' | 'stopped' | 'failed';
export type RunStatus = 'approved_dry_run' | 'not_approved' | 'evaluated';

export interface StepInfo {
  id: string;
  kind: StepKind;
  label: string;
  group?: string; // 'specialists' marks the parallel lane
  scope?: Scope;
  team?: Team;
  budget?: number; // tool-call budget for agent steps
  input?: { system?: string; prompt?: string; [key: string]: unknown };
}

export interface Totals {
  duration_ms: number;
  model_calls: number;
  tool_calls: number;
  cost_usd: number;
  steps: number;
}

export type RunEventBody =
  | {
      type: 'run_started';
      run_id: string;
      title: string;
      brief_path: string;
      brief_lines: string[];
      today: string;
      runtime: { id: string; label: string; why: string };
      model: string;
      limits: Record<string, number>;
      policy: Record<string, number>;
      label?: string;
    }
  | { type: 'step_started'; step: StepInfo }
  | {
      type: 'step_finished';
      step_id: string;
      status: StepStatus;
      duration_ms: number;
      model_calls: number;
      tool_calls: number;
      cost_usd?: number;
      summary: string;
      output?: unknown;
    }
  | { type: 'tool_call'; step_id: string; call_id: string; name: string; input: unknown }
  | { type: 'tool_result'; step_id: string; call_id: string; name: string; ok: boolean; text: string }
  | { type: 'agent_text'; step_id: string; text: string }
  | { type: 'state_snapshot'; step_id: string; state: StateView }
  | { type: 'guard_result'; step_id: string; hits: ScanHit[] }
  | { type: 'check_result'; step_id: string; pass: number; rubric: RubricCheck[]; critique?: Critique; error?: string }
  | { type: 'awaiting_approval'; packet: ReviewPacket }
  | { type: 'decision'; decision: Decision }
  | { type: 'outbox_written'; dir: string; files: Record<string, string>; payloads: OutboxPayloads }
  | { type: 'run_finished'; status: RunStatus; totals: Totals }
  | { type: 'run_failed'; error: string; totals: Totals };

export type RunEvent = RunEventBody & { ts: string; seq: number };

export interface RunBus {
  events: RunEvent[];
  totals: Totals;
  emit: (body: RunEventBody) => RunEvent;
  subscribe: (listener: (event: RunEvent) => void) => () => void;
}

export const createBus = (file: string): RunBus => {
  const events: RunEvent[] = [];
  const totals: Totals = { duration_ms: 0, model_calls: 0, tool_calls: 0, cost_usd: 0, steps: 0 };
  const listeners = new Set<(event: RunEvent) => void>();
  const started = Date.now();
  const emit = (body: RunEventBody): RunEvent => {
    if (body.type === 'step_finished') {
      totals.model_calls += body.model_calls;
      totals.tool_calls += body.tool_calls;
      totals.cost_usd += body.cost_usd ?? 0;
      totals.steps += 1;
    }
    totals.duration_ms = Date.now() - started;
    const event = { ...body, ts: new Date().toISOString(), seq: events.length } as RunEvent;
    events.push(event);
    appendFileSync(file, `${JSON.stringify(event)}\n`);
    for (const listener of listeners) listener(event);
    return event;
  };
  const subscribe = (listener: (event: RunEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  return { events, totals, emit, subscribe };
};
