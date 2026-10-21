import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAgencyData } from '../src/data.ts';
import { lintPlan } from '../src/lint.ts';
import { newState } from '../src/state.ts';
import { executeTool, toolSpecs } from '../src/tools.ts';
import type { PlanState, PlanTask } from '../src/types.ts';

const data = loadAgencyData();
const facts = { client: 'Fernway Labs', campaign: 'Fernway 2.0', launch_date: '2026-12-01', markets: ['US', 'UK'], slack_channel: '#launch-fernway' };
const milestones = [{ id: 'CRE-1', team: 'Creative' as const, title: 'English ad finals approved', due_by: '2026-11-20', for_teams: ['Media' as const] }];

const mediaState = (maxSteps = 10): PlanState => ({ ...newState('run-test', '2026-10-19', 50, 'team', 'Media'), max_steps: maxSteps, facts, milestones });

const task = (overrides: Partial<PlanTask> = {}): PlanTask => ({
  id: 'MED-1',
  title: 'Build Meta and TikTok campaigns in draft',
  team: 'Media',
  due_date: '2026-11-24',
  timing: 'before_launch',
  acceptance_criteria: ['Campaigns built in draft', 'Tracking links checked'],
  depends_on: [],
  brief_refs: ['L36'],
  confidence: 0.9,
  ...overrides,
});

const run = (state: PlanState, name: string, input: unknown): ReturnType<typeof executeTool> => executeTool(name, input, { state, data });

test('each scope only sees its own tools', () => {
  const names = (scope: 'orchestrator' | 'team' | 'revise'): string[] => toolSpecs(scope).map((spec) => spec.name);
  assert.ok(names('orchestrator').includes('define_milestones'));
  assert.ok(!names('orchestrator').includes('add_tasks'));
  assert.ok(names('team').includes('finish_team'));
  assert.ok(!names('team').includes('set_slack_summary'));
  assert.ok(names('revise').includes('finish_plan'));
});

test('a specialist can only add its own team\'s tasks', () => {
  const state = mediaState();
  const out = run(state, 'add_tasks', { tasks: [task({ id: 'CRE-9', team: 'Creative', title: 'Make banners for the launch' })] });
  assert.equal(out.isError, true);
  assert.match(out.text, /you plan Media work only/);
});

test('other teams are reachable only through milestones, and the milestone date counts', () => {
  const state = mediaState();
  const notMilestone = run(state, 'add_tasks', { tasks: [task({ depends_on: ['CRE-4'] })] });
  assert.match(notMilestone.text, /only reachable through milestones: CRE-1/);
  const tooEarly = run(state, 'add_tasks', { tasks: [task({ due_date: '2026-11-19', depends_on: ['CRE-1'] })] });
  assert.match(tooEarly.text, /depends on milestone CRE-1, due by 2026-11-20/);
  const fine = run(state, 'add_tasks', { tasks: [task({ depends_on: ['CRE-1'] })] });
  assert.match(fine.text, /Added 1 of 1/);
});

test('timing must agree with the launch date', () => {
  const state = mediaState();
  const out = run(state, 'add_tasks', { tasks: [task({ due_date: '2026-12-02' })] });
  assert.match(out.text, /before_launch but due 2026-12-02, on or after the launch date 2026-12-01/);
  const launchDay = run(state, 'add_tasks', { tasks: [task({ id: 'MED-2', title: 'Go live on launch day', timing: 'launch_day', due_date: '2026-12-01' })] });
  assert.match(launchDay.text, /Added 1 of 1/);
});

test('a weekend due date is rejected with the next working day', () => {
  const state = mediaState();
  const out = run(state, 'add_tasks', { tasks: [task({ due_date: '2026-11-28' })] });
  assert.match(out.text, /weekend/);
  assert.match(out.text, /2026-11-30/);
});

test('confidence below 0.8 needs an assumption', () => {
  const state = mediaState();
  const out = run(state, 'add_tasks', { tasks: [task({ confidence: 0.6 })] });
  assert.match(out.text, /needs an assumption/);
  const withAssumption = run(state, 'add_tasks', { tasks: [task({ confidence: 0.6, assumption: 'Budget lands by 4 Nov.' })] });
  assert.match(withAssumption.text, /Added 1 of 1/);
});

test('update_tasks checks the batch as a whole, so a dependency chain can move together', () => {
  const state = { ...newState('run-test', '2026-10-19', 50, 'revise'), max_steps: 10, facts };
  run(state, 'add_tasks', { tasks: [task({ id: 'CRE-1', team: 'Creative', title: 'Deliver final ad creative', due_date: '2026-11-20' }), task({ depends_on: ['CRE-1'] })] });
  const both = run(state, 'update_tasks', { updates: [{ id: 'CRE-1', changes: { due_date: '2026-11-25' } }, { id: 'MED-1', changes: { due_date: '2026-11-30' } }] });
  assert.match(both.text, /Updated 2 of 2/);
  const alone = run(state, 'update_tasks', { updates: [{ id: 'CRE-1', changes: { due_date: '2026-11-30' } }, { id: 'MED-1', changes: { title: 'Build campaigns for both markets' } }] });
  assert.match(alone.text, /Updated 2 of 2/);
});

test('finish_team refuses while a promised milestone has no task', () => {
  const state: PlanState = { ...newState('run-test', '2026-10-19', 50, 'team', 'Creative'), max_steps: 10, facts, milestones };
  run(state, 'add_tasks', { tasks: [task({ id: 'CRE-2', team: 'Creative', title: 'Produce store screenshots' })] });
  const finish = run(state, 'finish_team', { note: 'Creative plan done.' });
  assert.equal(finish.isError, true);
  assert.match(finish.text, /Milestone CRE-1 .* has no task/);
});

test('the orchestrator cannot hand over until every team is assigned', () => {
  const state = { ...newState('run-test', '2026-10-19', 50, 'orchestrator'), max_steps: 10 };
  run(state, 'set_campaign_facts', facts);
  const rejected = run(state, 'define_milestones', { milestones: [{ id: 'MED-1', team: 'Creative', title: 'Ad finals approved', due_by: '2026-11-20', for_teams: ['Media'] }] });
  assert.match(rejected.text, /a Creative milestone id starts with CRE-/);
  run(state, 'assign_teams', { assignments: [{ team: 'Media', needed: true, scope: 'Paid UA on Meta and TikTok.', brief_refs: ['L36'], depends_on_milestones: [] }] });
  const finish = run(state, 'finish_orchestration', { note: 'Split by team.' });
  assert.equal(finish.isError, true);
  assert.match(finish.text, /No assignment for PR, Creative, Organic, Data/);
});

test('once the step budget is spent, only the finish tool still runs', () => {
  const state = mediaState(2);
  run(state, 'calc_dates', { items: [{ label: 'x', from: '2026-12-01', working_days: -5 }] });
  run(state, 'calc_dates', { items: [{ label: 'y', from: '2026-12-01', working_days: -3 }] });
  const blocked = run(state, 'add_tasks', { tasks: [task()] });
  assert.match(blocked.text, /Step budget used up/);
  const finish = run(state, 'finish_team', { note: 'Out of budget.' });
  assert.equal(finish.isError, false);
  assert.equal(state.finished, true);
});

test('volume caps: a specialist gets at most 10 tasks and 2 questions', () => {
  const state = mediaState(30);
  const many = Array.from({ length: 11 }, (_, index) => task({ id: `MED-${index + 1}`, title: `Media task number ${index + 1}` }));
  const tooMany = run(state, 'add_tasks', { tasks: many });
  assert.match(tooMany.text, /the cap is 10, so 10 more fit/);
  assert.equal(state.tasks.length, 0);
  run(state, 'flag_for_human', { question: 'Is the Spanish creative in scope?', why: 'Changes MED-2.' });
  run(state, 'flag_for_human', { question: 'Can paid go live before the store listing?', why: 'Changes MED-4.' });
  const third = run(state, 'flag_for_human', { question: 'Should we pause on Black Friday?', why: 'Changes pacing.' });
  assert.match(third.text, /the most your role may/);
  assert.equal(state.flags.length, 2);
});

test('invalid input still costs a step and says what is wrong', () => {
  const state = mediaState();
  const out = run(state, 'add_tasks', { tasks: [task({ id: 'BAD' })] });
  assert.match(out.text, /Invalid input for add_tasks/);
  assert.equal(state.steps_used, 1);
});

test('lintPlan finds a dependency cycle and a missing milestone', () => {
  const state: PlanState = {
    ...newState('run-test', '2026-10-19', 50, 'revise'),
    facts,
    milestones,
    tasks: [task({ id: 'MED-1', depends_on: ['MED-2'] }), task({ id: 'MED-2', title: 'Second task', depends_on: ['MED-1'] })],
  };
  const codes = lintPlan(state, data.closedDays, { requireSlack: false }).map((issue) => issue.code);
  assert.ok(codes.includes('dependency_cycle'));
  assert.ok(codes.includes('milestone_missing'));
});
