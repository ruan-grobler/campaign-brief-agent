// Replays one recorded eval case through the real pipeline and checks the result against the recording.
// The recorded agents ran in parallel, so events are compared per step, in order. Fields that measure the
// wall clock or name the run (timestamps, durations, run id and label, runtime) are expected to differ.
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT } from './config.ts';
import { blockingFindings } from './critique.ts';
import type { RunEvent } from './events.ts';
import { startRun } from './pipeline.ts';
import { createReplayRuntime, loadRecording, readEvents, stepOf } from './runtime/replay.ts';
import { readJson } from './runlog.ts';
import { caseOptions, scoreCase, type CaseResult, type EvalCase } from './scoring.ts';

type Json = Record<string, unknown>;

export const REPLAY_WHY = 'Replays the tool calls and model answers recorded in the 19 Oct 2026 eval. No network, no API key.';

// Cost totals are sums of the same recorded per-step costs, added in a different order, so they are
// compared to 9 decimal places.
const roundCost = (value: unknown): unknown => (typeof value === 'number' ? Number(value.toFixed(9)) : value);
const repoPath = (value: unknown): unknown => (typeof value === 'string' && value.startsWith('/') ? relative(ROOT, value) : value);
const copy = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

const normaliseEvent = (event: RunEvent): Json => {
  const out = copy(event);
  delete out.ts;
  delete out.seq;
  if (out.type === 'run_started') {
    delete out.run_id;
    delete out.runtime;
    delete out.label;
    out.brief_path = repoPath(out.brief_path);
  }
  if (out.type === 'step_finished') delete out.duration_ms;
  if (out.type === 'run_finished' || out.type === 'run_failed') {
    const totals = out.totals as Json;
    delete totals.duration_ms;
    totals.cost_usd = roundCost(totals.cost_usd);
  }
  return out;
};

const normaliseSummary = (summary: Json): Json => {
  const out = copy(summary);
  delete out.run_id;
  delete out.label;
  delete out.runtime;
  out.brief = repoPath(out.brief);
  const totals = out.totals as Json | undefined;
  if (totals) {
    delete totals.duration_ms;
    totals.cost_usd = roundCost(totals.cost_usd);
  }
  for (const check of (out.checks as Json[] | undefined) ?? []) delete check.duration_ms;
  return out;
};

const normaliseScore = (score: CaseResult): Json => {
  const out = copy(score);
  delete out.run_id;
  delete out.duration_ms;
  out.cost_usd = roundCost(out.cost_usd);
  return out;
};

const show = (value: unknown): string => {
  const text = JSON.stringify(value) ?? 'nothing';
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
};

// Long strings, such as prompts, are shown from just before the first character that differs.
const showStrings = (recorded: string, replayed: string): string => {
  let at = 0;
  while (at < recorded.length && recorded[at] === replayed[at]) at += 1;
  const from = Math.max(0, at - 20);
  const window = (text: string): string => `${from ? '…' : ''}${show(text.slice(from, from + 70))}`;
  return `first differs at character ${at + 1}: recorded ${window(recorded)}, replayed ${window(replayed)}`;
};

// The path to the first value that differs, with both values, e.g. text: recorded "...", replayed "...".
export const firstDifference = (recorded: unknown, replayed: unknown, path = ''): string => {
  if (isDeepStrictEqual(recorded, replayed)) return '';
  if (typeof recorded === 'string' && typeof replayed === 'string' && Math.max(recorded.length, replayed.length) > 80) {
    return `${path || 'value'}: ${showStrings(recorded, replayed)}`;
  }
  const bothObjects = recorded !== null && replayed !== null && typeof recorded === 'object' && typeof replayed === 'object';
  if (bothObjects && Array.isArray(recorded) === Array.isArray(replayed)) {
    const keys = [...new Set([...Object.keys(recorded), ...Object.keys(replayed)])];
    for (const key of keys) {
      const inner = firstDifference((recorded as Json)[key], (replayed as Json)[key], path ? `${path}.${key}` : key);
      if (inner) return inner;
    }
  }
  return `${path || 'value'}: recorded ${show(recorded)}, replayed ${show(replayed)}`;
};

const byStep = (events: RunEvent[]): Map<string, RunEvent[]> => {
  const steps = new Map<string, RunEvent[]>();
  for (const event of events) steps.set(stepOf(event), [...(steps.get(stepOf(event)) ?? []), event]);
  return steps;
};

// One line per step that differs, naming the first event and field that does.
export const compareEvents = (recorded: RunEvent[], replayed: RunEvent[]): string[] => {
  const want = byStep(recorded);
  const got = byStep(replayed);
  const problems: string[] = [];
  for (const step of new Set([...want.keys(), ...got.keys()])) {
    const left = want.get(step) ?? [];
    const right = got.get(step) ?? [];
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const a = left[index];
      const b = right[index];
      if (!a || !b) {
        problems.push(`${step}: the recording has ${left.length} event(s), the replay ${right.length}.`);
        break;
      }
      const difference = firstDifference(normaliseEvent(a), normaliseEvent(b));
      if (difference) {
        problems.push(`${step}: event ${index + 1} of ${left.length} (${a.type}${'name' in a ? ` ${a.name}` : ''}) differs. ${difference}`);
        break;
      }
    }
  }
  return problems;
};

export const compareSummary = (recorded: Json, replayed: Json): string[] => {
  const difference = firstDifference(normaliseSummary(recorded), normaliseSummary(replayed));
  return difference ? [`run.json differs. ${difference}`] : [];
};

export const compareScore = (recorded: CaseResult, replayed: CaseResult): string[] => {
  const difference = firstDifference(normaliseScore(recorded), normaliseScore(replayed));
  return difference ? [`eval score differs. ${difference}`] : [];
};

export interface ReplayOutcome {
  name: string;
  recorded: CaseResult;
  replayed?: CaseResult;
  firstBlocking?: number; // blocking findings at the first check, before the revision
  events: number; // recorded events compared
  toolCalls: number; // recorded tool calls the replay ran through the real tools
  pushedBack: number; // of those, calls the tools rejected in full or in part
  divergences: string[];
  runDir?: string;
  error?: string;
}

type ToolResult = Extract<RunEvent, { type: 'tool_result' }>;

// Runs the case on its pinned date with no human gate, as the eval does, then compares event by event.
export const replayCase = async (item: EvalCase, recorded: CaseResult, recordedDir: string): Promise<ReplayOutcome> => {
  try {
    const recording = loadRecording(recordedDir);
    const handle = startRun({ ...caseOptions(item), runtime: { runtime: createReplayRuntime(recording), why: REPLAY_WHY }, label: `demo replay: ${item.name}` });
    const result = await handle.done;
    const replayed = scoreCase(item, result);
    const events = readEvents(join(handle.runDir, 'events.jsonl'));
    const results = events.filter((event): event is ToolResult => event.type === 'tool_result');
    const divergences = [
      ...compareEvents(recording.events, events),
      ...compareSummary(readJson<Json>(join(recordedDir, 'run.json')), readJson<Json>(join(handle.runDir, 'run.json'))),
      ...compareScore(recorded, replayed),
    ];
    const first = result.checks[0]?.critique;
    return {
      name: item.name,
      recorded,
      replayed,
      firstBlocking: first ? blockingFindings(first).length : undefined,
      events: recording.events.length,
      toolCalls: results.length,
      pushedBack: results.filter((event) => !event.ok || event.text.includes('REJECTED')).length,
      divergences,
      runDir: handle.runDir,
    };
  } catch (error) {
    return { name: item.name, recorded, events: 0, toolCalls: 0, pushedBack: 0, divergences: [], error: error instanceof Error ? error.message : String(error) };
  }
};
