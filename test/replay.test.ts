// The demo's replay runtime and its check against the recording. Offline: recorded model output only.
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../src/config.ts';
import type { Critique } from '../src/critique.ts';
import type { RunEvent, RunEventBody } from '../src/events.ts';
import { CHECKER_SYSTEM, SLACK_SCHEMA, SUMMARY_SYSTEM } from '../src/prompts.ts';
import { compareEvents, firstDifference, replayCase } from '../src/replay-check.ts';
import { createReplayRuntime, readEvents, type Recording } from '../src/runtime/replay.ts';
import type { AgentCall, StructuredCall } from '../src/runtime/types.ts';
import { readJson } from '../src/runlog.ts';
import { loadCases, type CaseResult } from '../src/scoring.ts';
import { loadState, newState, saveState } from '../src/state.ts';

const RECORDED = join(ROOT, 'examples', 'recorded-eval');
const recordedResults = readJson<{ results: CaseResult[] }>(join(RECORDED, 'results-2026-10-19.json')).results;

let seq = 0;
const at = (body: RunEventBody, ts = '2026-10-19T13:08:38.000Z'): RunEvent => ({ ...body, ts, seq: (seq += 1) }) as RunEvent;
const recording = (events: RunEvent[]): Recording => ({ runId: 'run-test', events });

const finished = (stepId: string, output: unknown = { stop: 'completed' }): RunEvent =>
  at({ type: 'step_finished', step_id: stepId, status: 'done', duration_ms: 4000, model_calls: 3, tool_calls: 2, cost_usd: 0.25, summary: 'done', output });

const facts = { client: 'Fernway Labs', campaign: 'Fernway 2.0', launch_date: '2026-12-01', markets: ['US'], slack_channel: '#launch-fernway' };

const mediaAgent = (): AgentCall => {
  const dir = mkdtempSync(join(tmpdir(), 'cba-replay-'));
  const stateFile = join(dir, 'team-media.json');
  saveState(stateFile, { ...newState('run-test', '2026-10-19', 50, 'team', 'Media'), max_steps: 10, facts });
  return { scope: 'team', team: 'Media', stateFile, logFile: join(dir, 'tools.jsonl'), system: 'test', prompt: 'Plan the Media work.', maxSteps: 10, effort: 'medium', timeoutMs: 60_000 };
};

const structuredCall = (system: string): StructuredCall => ({ system, prompt: 'test', schema: SLACK_SCHEMA, effort: 'low', timeoutMs: 60_000 });

const critique = (summary: string): Critique => ({ verdict: 'approve', summary, requirements: [], findings: [] });

test('the replay runs each recorded tool call through the real tools, where its result was recorded', async () => {
  const call = mediaAgent();
  const question = { question: 'Is the Spanish creative in scope?', why: 'It changes the Media plan.' };
  const runtime = createReplayRuntime(
    recording([
      at({ type: 'tool_call', step_id: 'team-media', call_id: 'tu_1', name: 'flag_for_human', input: question }),
      at({ type: 'tool_call', step_id: 'team-media', call_id: 'tu_2', name: 'get_plan', input: {} }),
      at({ type: 'tool_result', step_id: 'team-media', call_id: 'tu_1', name: 'flag_for_human', ok: true, text: 'recorded text is not reused' }),
      at({ type: 'tool_result', step_id: 'team-media', call_id: 'tu_2', name: 'get_plan', ok: true, text: 'recorded text is not reused' }),
      at({ type: 'agent_text', step_id: 'team-media', text: 'Media plan handed back.' }),
      finished('team-media'),
    ]),
  );
  const seen: string[] = [];
  const results: string[] = [];
  const stats = await runtime.runAgent(call, {
    onToolCall: (id, name) => seen.push(`call ${id} ${name}`),
    onToolResult: (id, _name, ok, text) => {
      seen.push(`result ${id} ${ok} steps_used=${loadState(call.stateFile).steps_used}`);
      results.push(text);
    },
    onText: (text) => seen.push(`text ${text}`),
  });

  assert.deepEqual(seen, [
    'call tu_1 flag_for_human',
    'call tu_2 get_plan',
    'result tu_1 true steps_used=1',
    'result tu_2 true steps_used=2',
    'text Media plan handed back.',
  ]);
  assert.match(results[0] ?? '', /Flagged Q1 for the human approver[\s\S]*\[step 1 of 10\]$/);
  assert.match(results[1] ?? '', /0 task\(s\), 0 milestone\(s\), 1 question\(s\)[\s\S]*\[step 2 of 10\]$/);
  assert.deepEqual(stats, { stop: 'completed', modelCalls: 3, durationMs: 4000, costUsd: 0.25, detail: undefined });
  assert.equal(loadState(call.stateFile).flags.length, 1);
});

test('the replay answers structured calls with the recorded kickoff note, then each check in order', async () => {
  const note = { channel: '#launch-fernway', text: '*Fernway 2.0*: launch Tue 01 Dec. Media builds campaigns by 24 Nov, PR briefs press from 17 Nov.' };
  const runtime = createReplayRuntime(
    recording([
      finished('summary', note),
      at({ type: 'check_result', step_id: 'check-1', pass: 1, rubric: [], critique: critique('first review') }),
      finished('check-1', critique('first review')),
      at({ type: 'check_result', step_id: 'check-2', pass: 2, rubric: [], critique: critique('re-check') }),
      finished('check-2', critique('re-check')),
    ]),
  );

  const summary = await runtime.structured(structuredCall(SUMMARY_SYSTEM));
  assert.deepEqual(summary.data, { text: note.text });
  assert.equal(summary.modelCalls, 3);
  assert.equal(((await runtime.structured(structuredCall(CHECKER_SYSTEM))).data as Critique).summary, 'first review');
  assert.equal(((await runtime.structured(structuredCall(CHECKER_SYSTEM))).data as Critique).summary, 're-check');
  await assert.rejects(runtime.structured(structuredCall(CHECKER_SYSTEM)), /has no check-3 step/);
  await assert.rejects(runtime.structured(structuredCall('Some other system prompt.')), /no answer for this structured call/);
});

test('an agent step the recording does not have fails loudly instead of inventing output', async () => {
  const runtime = createReplayRuntime(recording([finished('team-media')]));
  const call = { ...mediaAgent(), scope: 'team' as const, team: 'PR' as const };
  await assert.rejects(runtime.runAgent(call, { onToolCall: () => {}, onToolResult: () => {}, onText: () => {} }), /has no team-pr step/);
});

test('the check ignores clocks and run ids, and names the first field that differs', () => {
  const started = (ts: string, runId: string): RunEvent =>
    at(
      {
        type: 'run_started',
        run_id: runId,
        title: 'Fernway 2.0 launch',
        brief_path: join(ROOT, 'examples', 'brief.md'),
        brief_lines: ['# Campaign brief: Fernway 2.0 launch'],
        today: '2026-10-19',
        runtime: { id: runId === 'run-a' ? 'claude-code' : 'replay', label: 'x', why: 'y' },
        model: 'claude-opus-5-5',
        limits: {},
        policy: {},
      },
      ts,
    );
  const stream = (ts: string, runId: string, text: string, durationMs: number): RunEvent[] => [
    started(ts, runId),
    at({ type: 'tool_call', step_id: 'team-media', call_id: 'tu_1', name: 'add_tasks', input: { tasks: [] } }, ts),
    at({ type: 'tool_result', step_id: 'team-media', call_id: 'tu_1', name: 'add_tasks', ok: true, text }, ts),
    at({ type: 'step_finished', step_id: 'team-media', status: 'done', duration_ms: durationMs, model_calls: 2, tool_calls: 1, summary: '1 task(s)' }, ts),
  ];
  const recorded = stream('2026-10-19T13:08:38.000Z', 'run-a', 'Added 1 of 1 task(s): MED-1.', 61_000);
  assert.deepEqual(compareEvents(recorded, stream('2026-10-21T08:00:00.000Z', 'run-b', 'Added 1 of 1 task(s): MED-1.', 3)), []);
  const changed = compareEvents(recorded, stream('2026-10-21T08:00:00.000Z', 'run-b', 'Added 0 of 1 task(s): none.', 3));
  assert.deepEqual(changed, ['team-media: event 2 of 3 (tool_result add_tasks) differs. text: recorded "Added 1 of 1 task(s): MED-1.", replayed "Added 0 of 1 task(s): none."']);
  assert.match(compareEvents(recorded, recorded.slice(0, 3)).join(' '), /team-media: the recording has 3 event\(s\), the replay 2/);
  assert.equal(firstDifference({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }), 'a.b.1: recorded 2, replayed 3');
});

for (const item of loadCases()) {
  test(`replaying the recorded ${item.name} eval run through the real pipeline reproduces every event`, async () => {
    const entry = recordedResults.find((result) => result.name === item.name);
    assert.ok(entry?.run_id, `no recorded run for ${item.name}`);
    const recordedRun = readJson<{ totals: { tool_calls: number } }>(join(RECORDED, entry.run_id, 'run.json'));
    const outcome = await replayCase(item, entry, join(RECORDED, entry.run_id));
    try {
      assert.equal(outcome.error, undefined);
      assert.deepEqual(outcome.divergences, []);
      assert.ok(outcome.events > 100);
      assert.equal(outcome.toolCalls, recordedRun.totals.tool_calls);
      assert.equal(outcome.replayed?.passed, entry.passed);
      assert.equal(outcome.replayed?.total, entry.total);
      assert.equal(outcome.replayed?.tasks, entry.tasks);
      assert.equal(outcome.replayed?.blocking, entry.blocking);
    } finally {
      if (outcome.runDir) rmSync(outcome.runDir, { recursive: true, force: true });
    }
  });
}

test('a tampered recording is caught, because the replay goes through the real validation', async () => {
  const item = loadCases().find((entry) => entry.name === 'orbit-injection');
  const entry = recordedResults.find((result) => result.name === 'orbit-injection');
  assert.ok(item && entry?.run_id);
  const source = join(RECORDED, entry.run_id);
  const dir = mkdtempSync(join(tmpdir(), 'cba-tampered-'));
  copyFileSync(join(source, 'run.json'), join(dir, 'run.json'));
  let moved = false;
  const lines = readFileSync(join(source, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const event = JSON.parse(line) as RunEvent;
      if (!moved && event.type === 'tool_call' && event.step_id === 'team-media' && event.name === 'add_tasks') {
        // The agent's first Media task (MED-1), moved to a Saturday.
        const first = (event.input as { tasks: { due_date: string }[] }).tasks[0];
        if (first) first.due_date = '2026-11-28';
        moved = first !== undefined;
      }
      return JSON.stringify(event);
    });
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`);
  assert.ok(moved);

  const outcome = await replayCase(item, entry, dir);
  try {
    assert.equal(outcome.error, undefined);
    assert.match(outcome.divergences[0] ?? '', /^team-media: event \d+ of \d+ \(tool_result add_tasks\) differs/);
    assert.match(outcome.divergences.join('\n'), /eval score differs/);
    const replayed = readEvents(join(outcome.runDir ?? '', 'events.jsonl'));
    const added = replayed.find((event) => event.type === 'tool_result' && event.step_id === 'team-media' && event.name === 'add_tasks');
    assert.match(added?.type === 'tool_result' ? added.text : '', /REJECTED MED-1: 2026-11-28 is a Sat \(weekend\)\. Next working day is 2026-11-30\./);
  } finally {
    if (outcome.runDir) rmSync(outcome.runDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
