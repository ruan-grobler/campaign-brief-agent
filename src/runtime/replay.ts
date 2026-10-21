// Offline runtime for the demo and the tests: it replays one recorded run, with no network and no key.
// Only the model's side comes from the recording: which tools each agent called, with what input, what it
// said, and its answers to the structured calls (kickoff note, checker, re-check). Every recorded tool call
// goes through the real tool code (runTool), the same way the API runtime handles the model's tool_use
// blocks, so validation, budgets and state are computed fresh by this code base.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAgencyData } from '../data.ts';
import type { RunEvent } from '../events.ts';
import { CHECKER_SYSTEM, SUMMARY_SYSTEM } from '../prompts.ts';
import { loadState } from '../state.ts';
import { runTool } from '../tools.ts';
import type { AgentCall, AgentEvents, AgentStats, Runtime, StructuredCall, StructuredResult } from './types.ts';

type StepFinished = Extract<RunEvent, { type: 'step_finished' }>;
type CheckEvent = Extract<RunEvent, { type: 'check_result' }>;

export interface Recording {
  runId: string;
  events: RunEvent[];
}

export const readEvents = (file: string): RunEvent[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RunEvent);

export const loadRecording = (dir: string): Recording => {
  const events = readEvents(join(dir, 'events.jsonl'));
  const first = events[0];
  if (first?.type !== 'run_started') throw new Error(`${dir}/events.jsonl does not start with run_started.`);
  return { runId: first.run_id, events };
};

// The step an event belongs to. Run-level events (start, finish) belong to 'run'.
export const stepOf = (event: RunEvent): string => {
  if (event.type === 'step_started') return event.step.id;
  return 'step_id' in event ? event.step_id : 'run';
};

// The same step ids the pipeline gives its agent steps.
const agentStep = (call: AgentCall, revision: number): string => {
  if (call.scope === 'orchestrator') return 'orchestrator';
  if (call.scope === 'team') return `team-${String(call.team).toLowerCase()}`;
  return `revise-${revision}`;
};

export const createReplayRuntime = (recording: Recording): Runtime => {
  const byStep = new Map<string, RunEvent[]>();
  for (const event of recording.events) byStep.set(stepOf(event), [...(byStep.get(stepOf(event)) ?? []), event]);

  const finishedOf = (step: string): StepFinished => {
    const finished = byStep.get(step)?.find((event): event is StepFinished => event.type === 'step_finished');
    if (!finished) throw new Error(`The recording of ${recording.runId} has no ${step} step.`);
    return finished;
  };

  let revisions = 0;
  let checks = 0;

  const runAgent = async (call: AgentCall, events: AgentEvents): Promise<AgentStats> => {
    // Yield first, so the parallel specialists all start before any of them runs, as in a live run.
    await Promise.resolve();
    if (call.scope === 'revise') revisions += 1;
    const step = agentStep(call, revisions);
    const finished = finishedOf(step);
    const ctx = { state: loadState(call.stateFile), data: loadAgencyData() };
    const calls = new Map<string, { name: string; input: unknown }>();
    for (const event of byStep.get(step) ?? []) {
      if (event.type === 'tool_call') {
        calls.set(event.call_id, { name: event.name, input: event.input });
        events.onToolCall(event.call_id, event.name, event.input);
      } else if (event.type === 'tool_result') {
        // Each tool runs where its result was recorded. Claude Code ran an agent's parallel calls one at a time,
        // in this order, and the step meter in every recorded result confirms it.
        const recorded = calls.get(event.call_id);
        if (!recorded) throw new Error(`${step}: a recorded tool result has no matching call (${event.call_id}).`);
        const outcome = runTool(ctx, call.stateFile, call.logFile, recorded.name, recorded.input);
        events.onToolResult(event.call_id, recorded.name, !outcome.isError, outcome.text);
      } else if (event.type === 'agent_text') {
        events.onText(event.text);
      }
    }
    if (finished.status === 'failed') throw new Error(finished.summary);
    const output = (finished.output ?? {}) as { stop?: AgentStats['stop']; detail?: string };
    return { stop: output.stop ?? 'completed', modelCalls: finished.model_calls, durationMs: finished.duration_ms, costUsd: finished.cost_usd, detail: output.detail };
  };

  const structured = async (call: StructuredCall): Promise<StructuredResult> => {
    if (call.system === SUMMARY_SYSTEM) {
      const finished = finishedOf('summary');
      const note = finished.output as { text?: unknown } | undefined;
      if (finished.status !== 'done' || typeof note?.text !== 'string') throw new Error('the recorded kickoff note call failed');
      return { data: { text: note.text }, modelCalls: finished.model_calls, durationMs: finished.duration_ms, costUsd: finished.cost_usd };
    }
    if (call.system === CHECKER_SYSTEM) {
      checks += 1;
      const step = `check-${checks}`;
      const finished = finishedOf(step);
      const result = byStep.get(step)?.find((event): event is CheckEvent => event.type === 'check_result');
      if (!result?.critique) throw new Error(result?.error ?? `the recording has no critique for ${step}`);
      return { data: result.critique, modelCalls: finished.model_calls, durationMs: finished.duration_ms, costUsd: finished.cost_usd };
    }
    throw new Error('The recording has no answer for this structured call.');
  };

  return { id: 'replay', label: `replay of the recorded run ${recording.runId}`, runAgent, structured };
};
