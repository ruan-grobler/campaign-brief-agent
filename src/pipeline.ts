// The run, front-end neutral: input guard, orchestrator, five specialists in parallel, merge, kickoff note,
// adversarial check, one revision, re-check, human approval, dry-run send. Every step emits events.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDecision, buildPacket, type DecisionInput, type ReviewPacket } from './approval.ts';
import { runChecker, type CheckResult } from './checker.ts';
import { EFFORT, LIMITS, MODEL, PATHS, POLICY, type Effort } from './config.ts';
import { blockingFindings, type Critique } from './critique.ts';
import { loadAgencyData } from './data.ts';
import { prettyDate } from './dates.ts';
import { createBus, type RunBus, type RunEvent, type RunStatus, type StepInfo, type StepStatus, type Totals } from './events.ts';
import { scanBrief, type ScanHit } from './injection.ts';
import { lintPlan } from './lint.ts';
import { mergeStates } from './merge.ts';
import { buildPayloads, writeOutbox } from './outbox.ts';
import {
  ORCHESTRATOR_SYSTEM,
  REVISER_SYSTEM,
  SLACK_SCHEMA,
  SUMMARY_SYSTEM,
  briefTitle,
  numberBrief,
  orchestratorPrompt,
  revisePrompt,
  specialistPrompt,
  specialistSystem,
  summaryPrompt,
} from './prompts.ts';
import { scoreRubric, type RubricCheck } from './rubric.ts';
import { newRunId, writeJson } from './runlog.ts';
import type { RuntimeChoice } from './runtime/select.ts';
import type { AgentEvents, AgentStats, Runtime } from './runtime/types.ts';
import { loadState, newState, saveState, viewOf } from './state.ts';
import { MUTATING_TOOLS } from './tools.ts';
import { TEAMS, type PlanState, type Scope, type Team } from './types.ts';

export type Gate = (packet: ReviewPacket, validate: (input: DecisionInput) => string[]) => Promise<DecisionInput>;

export interface RunOptions {
  briefPath: string;
  today: string;
  runtime: RuntimeChoice;
  gate?: Gate; // without a gate the run stops after the checks (the eval)
  label?: string;
  requiredTeams?: Team[];
  excludedTeams?: Team[];
  expectUntrusted?: boolean;
  forbidden?: RegExp[];
  onEvent?: (event: RunEvent) => void;
}

export interface RunResult {
  runId: string;
  runDir: string;
  status: RunStatus;
  state: PlanState;
  rubric: RubricCheck[];
  checks: CheckResult[];
  guardHits: ScanHit[];
  guardrails: string[];
  outboxDir?: string;
  totals: Totals;
}

export interface RunHandle {
  runId: string;
  runDir: string;
  bus: RunBus;
  done: Promise<RunResult>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface AgentStep extends StepInfo {
  scope: Scope;
  budget: number;
  input: { system: string; prompt: string };
}

const describeAgent = (state: PlanState, stats: AgentStats): string => {
  const calls = `${state.steps_used}/${state.max_steps} tool calls`;
  const ending = state.finished ? '' : `, stopped early (${stats.stop})`;
  if (state.scope === 'orchestrator') {
    return `${state.milestones.length} milestones, ${state.assignments.filter((item) => item.needed).length} teams assigned, ${state.flags.length} question(s), ${calls}${ending}`;
  }
  return `${state.tasks.length} task(s), ${state.flags.length} question(s), ${calls}${ending}`;
};

// Runs one agent against its own state file and turns everything it does into events.
const runAgentStep = async (bus: RunBus, runtime: Runtime, step: AgentStep, stateFile: string, logFile: string, effort: Effort): Promise<{ state: PlanState; stats: AgentStats }> => {
  bus.emit({ type: 'step_started', step });
  const started = Date.now();
  let toolCalls = 0;
  const events: AgentEvents = {
    onToolCall: (callId, name, input) => {
      toolCalls += 1;
      bus.emit({ type: 'tool_call', step_id: step.id, call_id: callId, name, input });
    },
    onToolResult: (callId, name, ok, text) => {
      bus.emit({ type: 'tool_result', step_id: step.id, call_id: callId, name, ok, text });
      if (!MUTATING_TOOLS.has(name)) return;
      try {
        bus.emit({ type: 'state_snapshot', step_id: step.id, state: viewOf(loadState(stateFile)) });
      } catch {
        // The tool server writes the file before it answers, so this only misses if the file is unreadable.
      }
    },
    onText: (text) => {
      bus.emit({ type: 'agent_text', step_id: step.id, text });
    },
  };
  try {
    const stats = await runtime.runAgent(
      { scope: step.scope, team: step.team, stateFile, logFile, system: step.input.system, prompt: step.input.prompt, maxSteps: step.budget, effort, timeoutMs: LIMITS.agentTimeoutMs },
      events,
    );
    const state = loadState(stateFile);
    bus.emit({ type: 'state_snapshot', step_id: step.id, state: viewOf(state) });
    bus.emit({
      type: 'step_finished',
      step_id: step.id,
      status: state.finished ? 'done' : 'stopped',
      duration_ms: Date.now() - started,
      model_calls: stats.modelCalls,
      tool_calls: toolCalls,
      cost_usd: stats.costUsd,
      summary: describeAgent(state, stats),
      output: { stop: stats.stop, detail: stats.detail, steps_used: state.steps_used, max_steps: state.max_steps, finish_note: state.finish_note },
    });
    return { state, stats };
  } catch (error) {
    bus.emit({ type: 'step_finished', step_id: step.id, status: 'failed', duration_ms: Date.now() - started, model_calls: 0, tool_calls: toolCalls, summary: message(error) });
    throw error;
  }
};

interface PlainResult<T> {
  value: T;
  summary: string;
  output?: unknown;
  modelCalls?: number;
  costUsd?: number;
  status?: StepStatus;
}

const runPlainStep = async <T>(bus: RunBus, step: StepInfo, work: () => Promise<PlainResult<T>>): Promise<T> => {
  bus.emit({ type: 'step_started', step });
  const started = Date.now();
  try {
    const result = await work();
    bus.emit({
      type: 'step_finished',
      step_id: step.id,
      status: result.status ?? 'done',
      duration_ms: Date.now() - started,
      model_calls: result.modelCalls ?? 0,
      tool_calls: 0,
      cost_usd: result.costUsd,
      summary: result.summary,
      output: result.output,
    });
    return result.value;
  } catch (error) {
    bus.emit({ type: 'step_finished', step_id: step.id, status: 'failed', duration_ms: Date.now() - started, model_calls: 0, tool_calls: 0, summary: message(error) });
    throw error;
  }
};

const templateNote = (state: PlanState): string => {
  const launch = state.facts?.launch_date;
  const lines = [`*${state.facts?.campaign ?? 'Campaign'}*${launch ? `: launch ${prettyDate(launch)}` : ''}.`];
  for (const team of TEAMS) {
    const tasks = state.tasks.filter((task) => task.team === team).sort((a, b) => a.due_date.localeCompare(b.due_date));
    if (tasks.length) lines.push(`• *${team}*: ${tasks.length} task(s), first due ${prettyDate(tasks[0]?.due_date ?? '')}.`);
  }
  if (state.flags.length) lines.push(`*Open*: ${state.flags.map((flag) => flag.id).join(', ')}.`);
  return lines.join('\n');
};

const execute = async (runId: string, runDir: string, bus: RunBus, options: RunOptions): Promise<RunResult> => {
  const { runtime, why } = options.runtime;
  const brief = readFileSync(options.briefPath, 'utf8');
  copyFileSync(options.briefPath, join(runDir, 'brief.md'));
  const { text: numbered, lines } = numberBrief(brief);
  const title = briefTitle(brief);
  const data = loadAgencyData();
  const file = (name: string): string => join(runDir, name);
  const guardrails: string[] = [];

  bus.emit({
    type: 'run_started',
    run_id: runId,
    title,
    brief_path: options.briefPath,
    brief_lines: lines,
    today: options.today,
    runtime: { id: runtime.id, label: runtime.label, why },
    model: MODEL,
    limits: LIMITS,
    policy: POLICY,
    label: options.label,
  });

  // 1. Input guard: deterministic, and deliberately not shown to the agents.
  const guardHits = await runPlainStep(bus, { id: 'guard', kind: 'guard', label: 'Input guard', input: { lines: lines.length } }, async () => {
    const hits = scanBrief(lines);
    bus.emit({ type: 'guard_result', step_id: 'guard', hits });
    const summary = hits.length ? `${hits.length} suspicious line(s): ${hits.map((hit) => `L${hit.line}`).join(', ')}` : 'No suspicious lines';
    return { value: hits, summary, output: hits };
  });

  // 2. Orchestrator: facts, milestones, team assignments, campaign-wide questions.
  const orchestratorFile = file('orchestrator.json');
  saveState(orchestratorFile, { ...newState(runId, options.today, lines.length, 'orchestrator'), max_steps: LIMITS.orchestratorSteps });
  const orchestrator = await runAgentStep(
    bus,
    runtime,
    {
      id: 'orchestrator',
      kind: 'agent',
      label: 'Orchestrator',
      scope: 'orchestrator',
      budget: LIMITS.orchestratorSteps,
      input: { system: ORCHESTRATOR_SYSTEM, prompt: orchestratorPrompt(numbered, options.today, LIMITS.orchestratorSteps) },
    },
    orchestratorFile,
    file('tools-orchestrator.jsonl'),
    EFFORT.orchestrator,
  );
  const plan = orchestrator.state;
  if (!plan.facts) throw new Error(`The orchestrator did not set the campaign facts (${orchestrator.stats.stop}${orchestrator.stats.detail ? `: ${orchestrator.stats.detail}` : ''}).`);
  if (!plan.finished) guardrails.push(`The orchestrator stopped before finish_orchestration (${orchestrator.stats.stop}).`);

  // 3. Specialists, all at once. Each has its own state file and tool server, so they never touch each other's work.
  const assignmentOf = (team: Team): PlanState['assignments'][number] | undefined => plan.assignments.find((item) => item.team === team);
  const working = TEAMS.filter((team) => assignmentOf(team)?.needed !== false);
  for (const team of TEAMS) if (!assignmentOf(team)) guardrails.push(`The orchestrator gave ${team} no assignment, so it planned from the brief alone.`);
  const teamStates = await Promise.all(
    working.map(async (team) => {
      const slug = team.toLowerCase();
      const teamFile = file(`team-${slug}.json`);
      saveState(teamFile, {
        ...newState(runId, options.today, lines.length, 'team', team),
        max_steps: LIMITS.specialistSteps,
        facts: plan.facts,
        milestones: plan.milestones,
        assignments: plan.assignments,
      });
      try {
        const result = await runAgentStep(
          bus,
          runtime,
          {
            id: `team-${slug}`,
            kind: 'agent',
            label: `${team} specialist`,
            group: 'specialists',
            scope: 'team',
            team,
            budget: LIMITS.specialistSteps,
            input: { system: specialistSystem(team), prompt: specialistPrompt(team, numbered, options.today, LIMITS.specialistSteps, plan) },
          },
          teamFile,
          file(`tools-${slug}.jsonl`),
          EFFORT.specialist,
        );
        if (!result.state.finished) guardrails.push(`The ${team} specialist stopped before finish_team (${result.stats.stop}).`);
        return result.state;
      } catch (error) {
        guardrails.push(`The ${team} specialist failed (${message(error)}), so its tasks may be missing.`);
        return loadState(teamFile);
      }
    }),
  );

  // 4. Merge, in code.
  const planFile = file('plan-state.json');
  let state = await runPlainStep(bus, { id: 'merge', kind: 'merge', label: 'Merge and rule checks' }, async () => {
    const merged = mergeStates(plan, teamStates);
    saveState(planFile, merged);
    bus.emit({ type: 'state_snapshot', step_id: 'merge', state: viewOf(merged) });
    const issues = lintPlan(merged, data.closedDays, { requireSlack: false });
    const errors = issues.filter((issue) => issue.level === 'error');
    return {
      value: merged,
      summary: `${merged.tasks.length} tasks from ${teamStates.length} specialists, ${errors.length ? `${errors.length} rule-check error(s)` : 'rule checks clean'}`,
      output: { issues },
    };
  });

  // 5. Kickoff note: one structured model call, with a template if it fails.
  const channel = state.facts?.slack_channel ?? '#launch';
  state = await runPlainStep(
    bus,
    { id: 'summary', kind: 'summary', label: 'Kickoff note', input: { system: SUMMARY_SYSTEM, prompt: summaryPrompt(state) } },
    async () => {
      try {
        const result = await runtime.structured({ system: SUMMARY_SYSTEM, prompt: summaryPrompt(state), schema: SLACK_SCHEMA, effort: EFFORT.summary, timeoutMs: LIMITS.checkerTimeoutMs });
        const text = (result.data as { text?: unknown }).text;
        if (typeof text !== 'string' || text.trim().length < 80) throw new Error('the note came back empty');
        state.slack = { channel, text: text.trim().slice(0, 2900) };
        saveState(planFile, state);
        bus.emit({ type: 'state_snapshot', step_id: 'summary', state: viewOf(state) });
        return { value: state, summary: `${state.slack.text.length} characters for ${channel}`, output: state.slack, modelCalls: result.modelCalls, costUsd: result.costUsd };
      } catch (error) {
        state.slack = { channel, text: templateNote(state) };
        saveState(planFile, state);
        guardrails.push(`The kickoff note fell back to a template (${message(error)}).`);
        return { value: state, summary: 'Template note, because the model call failed', output: state.slack, status: 'stopped' };
      }
    },
  );

  // 6. Adversarial check, one revision, focused re-check.
  const rubricFor = (current: PlanState): RubricCheck[] =>
    scoreRubric(current, {
      requiredTeams: options.requiredTeams ?? working,
      excludedTeams: options.excludedTeams,
      closed: data.closedDays,
      expectUntrusted: options.expectUntrusted,
      forbidden: options.forbidden,
    });
  const checks: CheckResult[] = [];
  const check = async (earlier?: Critique): Promise<CheckResult> => {
    const pass = checks.length + 1;
    const id = `check-${pass}`;
    const rubric = rubricFor(state);
    bus.emit({ type: 'step_started', step: { id, kind: 'check', label: earlier ? 'Re-check' : 'Adversarial check', input: { rubric, earlier_findings: earlier?.findings.length ?? 0 } } });
    const result = await runChecker(runtime, runDir, pass, numbered, state, data, rubric, earlier);
    checks.push(result);
    bus.emit({ type: 'check_result', step_id: id, pass, rubric, critique: result.critique, error: result.error });
    const passed = rubric.filter((item) => item.pass).length;
    bus.emit({
      type: 'step_finished',
      step_id: id,
      status: result.critique ? 'done' : 'failed',
      duration_ms: result.durationMs,
      model_calls: result.modelCalls,
      tool_calls: 0,
      cost_usd: result.costUsd,
      summary: result.critique
        ? `${blockingFindings(result.critique).length} blocking of ${result.critique.findings.length} finding(s), rubric ${passed}/${rubric.length}`
        : `The checker failed: ${result.error ?? 'unknown error'}`,
      output: result.critique ?? { error: result.error },
    });
    return result;
  };

  let latest = await check();
  for (let revision = 1; revision <= LIMITS.maxRevisions; revision += 1) {
    const critique = latest.critique;
    if (!critique) break;
    const failing = rubricFor(state).filter((item) => !item.pass);
    const ruleErrors = lintPlan(state, data.closedDays).filter((issue) => issue.level === 'error');
    if (blockingFindings(critique).length === 0 && failing.length === 0 && ruleErrors.length === 0) break;
    Object.assign(state, { scope: 'revise', max_steps: LIMITS.reviseSteps, steps_used: 0, finished: false });
    saveState(planFile, state);
    try {
      const revised = await runAgentStep(
        bus,
        runtime,
        {
          id: `revise-${revision}`,
          kind: 'agent',
          label: 'Revision',
          scope: 'revise',
          budget: LIMITS.reviseSteps,
          input: { system: REVISER_SYSTEM, prompt: revisePrompt(numbered, options.today, LIMITS.reviseSteps, state, critique.findings, failing, ruleErrors) },
        },
        planFile,
        file('tools-reviser.jsonl'),
        EFFORT.reviser,
      );
      state = revised.state;
      if (!state.finished) guardrails.push(`The revision stopped before finish_plan (${revised.stats.stop}).`);
    } catch (error) {
      guardrails.push(`The revision failed (${message(error)}), so the plan is the pre-revision version.`);
      state = loadState(planFile);
    }
    latest = await check(critique);
  }
  if (latest.error) guardrails.push(`The checker could not review the final plan (${latest.error}). Review it yourself before approving.`);

  const rubric = rubricFor(state);
  const ruleErrors = lintPlan(state, data.closedDays)
    .filter((issue) => issue.level === 'error')
    .map((issue) => issue.message);

  const finish = (status: RunStatus, outboxDir?: string): RunResult => {
    const totals = { ...bus.totals };
    writeJson(file('run.json'), {
      run_id: runId,
      status,
      label: options.label,
      title,
      brief: options.briefPath,
      today: options.today,
      runtime: runtime.id,
      model: MODEL,
      tasks: state.tasks.length,
      questions: state.flags.length,
      untrusted: state.untrusted.length,
      rubric,
      checks: checks.map((item) => ({
        pass: item.pass,
        error: item.error,
        findings: item.critique?.findings.length,
        blocking: item.critique ? blockingFindings(item.critique).length : undefined,
        model_calls: item.modelCalls,
        duration_ms: item.durationMs,
      })),
      guard_hits: guardHits,
      guardrails,
      outbox: outboxDir,
      totals,
    });
    bus.emit({ type: 'run_finished', status, totals });
    return { runId, runDir, status, state, rubric, checks, guardHits, guardrails, outboxDir, totals };
  };

  if (!options.gate) return finish('evaluated');

  // 7. Human approval.
  const packet = buildPacket({ runId, title, state, critique: latest.critique, rubric, guardHits, ruleErrors, guardrails });
  writeJson(file('review-packet.json'), packet);
  bus.emit({ type: 'step_started', step: { id: 'approval', kind: 'approval', label: 'Human approval' } });
  bus.emit({ type: 'awaiting_approval', packet });
  const gateStarted = Date.now();
  const input = await options.gate(packet, (candidate) => applyDecision(packet, state, candidate, data).errors);
  const { decision, tasks } = applyDecision(packet, state, input, data);
  writeJson(file('approval.json'), decision);
  bus.emit({ type: 'decision', decision });
  bus.emit({
    type: 'step_finished',
    step_id: 'approval',
    status: decision.approved ? 'done' : 'stopped',
    duration_ms: Date.now() - gateStarted,
    model_calls: 0,
    tool_calls: 0,
    summary: decision.approved
      ? `Approved ${decision.approved_tasks.length}, rejected ${decision.rejected_tasks.length}, edited ${decision.edited_tasks.length}`
      : decision.reason,
    output: decision,
  });
  if (!decision.approved) return finish('not_approved');

  // 8. Dry-run send.
  const outboxDir = await runPlainStep(bus, { id: 'send', kind: 'send', label: 'Send (dry run)' }, async () => {
    const payloads = buildPayloads({ runId, title, state, tasks, decision, data, critique: latest.critique, rubric, runtimeLabel: runtime.label });
    const written = writeOutbox(runId, payloads);
    bus.emit({ type: 'outbox_written', dir: written.dir, files: written.files, payloads });
    return { value: written.dir, summary: `${payloads.asana.length} Asana requests and 1 Slack message written to the outbox. Nothing was sent.`, output: written.files };
  });
  return finish('approved_dry_run', outboxDir);
};

export const startRun = (options: RunOptions): RunHandle => {
  const runId = newRunId();
  const runDir = join(PATHS.runs, runId);
  mkdirSync(runDir, { recursive: true });
  const bus = createBus(join(runDir, 'events.jsonl'));
  if (options.onEvent) bus.subscribe(options.onEvent);
  // Start on the next tick, so callers can subscribe before the first event.
  const done = Promise.resolve()
    .then(() => execute(runId, runDir, bus, options))
    .catch((error: unknown) => {
      bus.emit({ type: 'run_failed', error: message(error), totals: { ...bus.totals } });
      throw error;
    });
  return { runId, runDir, bus, done };
};
