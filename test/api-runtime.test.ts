// The API runtime cannot run live without a key, so a scripted stand-in for the Claude API checks the loop.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { createApiRuntime } from '../src/runtime/api.ts';
import type { AgentCall, AgentEvents } from '../src/runtime/types.ts';
import { loadState, newState, saveState } from '../src/state.ts';

interface FakeRequest {
  messages: { role: string; content: unknown }[];
}

const toolTurn = (blocks: { id: string; name: string; input: unknown }[]): Record<string, unknown> => ({
  type: 'message',
  role: 'assistant',
  stop_reason: 'tool_use',
  stop_details: null,
  content: blocks.map((block) => ({ type: 'tool_use', ...block })),
});

const fakeClient = (nextMessage: () => Record<string, unknown>, requests: FakeRequest[]): Anthropic =>
  ({
    beta: {
      messages: {
        stream: (params: FakeRequest) => {
          requests.push(structuredClone(params));
          const message = nextMessage();
          return { finalMessage: async () => message };
        },
      },
    },
  }) as unknown as Anthropic;

const facts = { client: 'Fernway Labs', campaign: 'Fernway 2.0', launch_date: '2026-12-01', markets: ['US'], slack_channel: '#launch-fernway' };

const tempAgent = (maxSteps: number): AgentCall => {
  const dir = mkdtempSync(join(tmpdir(), 'cba-test-'));
  const stateFile = join(dir, 'team-media.json');
  saveState(stateFile, { ...newState('run-test', '2026-10-19', 50, 'team', 'Media'), max_steps: maxSteps, facts });
  return { scope: 'team', team: 'Media', stateFile, logFile: join(dir, 'tools.jsonl'), system: 'test', prompt: 'Plan the Media work.', maxSteps, effort: 'medium', timeoutMs: 60_000 };
};

const quiet: AgentEvents = { onToolCall: () => {}, onToolResult: () => {}, onText: () => {} };

const task = {
  id: 'MED-1',
  title: 'Build Meta and TikTok campaigns in draft',
  team: 'Media',
  due_date: '2026-11-24',
  timing: 'before_launch',
  acceptance_criteria: ['Campaigns built in draft', 'Tracking links checked'],
  depends_on: [],
  brief_refs: ['L36'],
  confidence: 0.9,
};

test('runs the tools the model picks, returns every result together, stops once the work is finished', async () => {
  const call = tempAgent(10);
  const script = [
    toolTurn([{ id: 'tu_1', name: 'get_playbooks', input: { keys: ['paid_social_ua'] } }]),
    toolTurn([
      { id: 'tu_2', name: 'add_tasks', input: { tasks: [task] } },
      { id: 'tu_3', name: 'flag_for_human', input: { question: 'Is the Spanish creative in scope?', why: 'Changes MED-1.' } },
    ]),
    toolTurn([{ id: 'tu_4', name: 'finish_team', input: { note: 'Planned and checked.' } }]),
  ];
  const requests: FakeRequest[] = [];
  const calls: string[] = [];
  const stats = await createApiRuntime(fakeClient(() => script.shift() ?? {}, requests)).runAgent(call, {
    ...quiet,
    onToolCall: (_id, name) => calls.push(name),
  });

  assert.equal(stats.stop, 'completed');
  assert.equal(stats.modelCalls, 3);
  assert.deepEqual(calls, ['get_playbooks', 'add_tasks', 'flag_for_human', 'finish_team']);
  const state = loadState(call.stateFile);
  assert.equal(state.finished, true);
  assert.equal(state.tasks.length, 1);
  const lastMessage = requests[2]?.messages.at(-1) as { role: string; content: { tool_use_id: string }[] };
  assert.equal(lastMessage.role, 'user');
  assert.deepEqual(lastMessage.content.map((result) => result.tool_use_id), ['tu_2', 'tu_3']);
});

test('a model that never stops is cut off by the step budget and then the turn cap', async () => {
  const call = tempAgent(2);
  let n = 0;
  const runtime = createApiRuntime(fakeClient(() => toolTurn([{ id: `tu_${(n += 1)}`, name: 'get_plan', input: {} }]), []));
  const stats = await runtime.runAgent(call, quiet);
  assert.equal(stats.stop, 'turn_cap');
  assert.equal(stats.modelCalls, 6);
  assert.equal(loadState(call.stateFile).finished, false);
});
