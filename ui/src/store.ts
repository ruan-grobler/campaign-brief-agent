// Folds the run's event stream into one view model. Live runs and replays go through the same reducer.
import type { Decision, EventOf, PlanTask, ReviewPacket, RunEvent, ScanHit, StateView, StepInfo, StepStatus, Team } from './types.ts';

export interface ToolCallView {
  call_id: string;
  name: string;
  input: unknown;
  ts: string;
  result?: { ok: boolean; text: string; ts: string };
}

export interface StepView extends StepInfo {
  status: 'running' | StepStatus;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  model_calls: number;
  tool_calls: number;
  cost_usd?: number;
  summary?: string;
  output?: unknown;
  calls: ToolCallView[];
  texts: string[];
  snapshot?: StateView;
}

export interface RunView {
  started?: EventOf<'run_started'>;
  steps: StepView[];
  byId: Map<string, StepView>;
  guardHits: ScanHit[];
  checks: EventOf<'check_result'>[];
  packet?: ReviewPacket;
  decision?: Decision;
  outbox?: EventOf<'outbox_written'>;
  finished?: EventOf<'run_finished'>;
  failed?: string;
  orchestrator?: StateView;
  teams: Map<string, StateView>;
  merged?: StateView;
  lastTs?: string;
  lastSeq: number;
}

export const emptyView = (): RunView => ({ steps: [], byId: new Map(), guardHits: [], checks: [], teams: new Map(), lastSeq: -1 });

// Returns false for an event already applied (an EventSource reconnect replays the stream).
export const applyEvent = (view: RunView, event: RunEvent): boolean => {
  if (event.seq <= view.lastSeq) return false;
  view.lastSeq = event.seq;
  view.lastTs = event.ts;
  const step = 'step_id' in event ? view.byId.get(event.step_id) : undefined;
  switch (event.type) {
    case 'run_started':
      view.started = event;
      break;
    case 'step_started': {
      const created: StepView = { ...event.step, status: 'running', started_at: event.ts, model_calls: 0, tool_calls: 0, calls: [], texts: [] };
      view.steps.push(created);
      view.byId.set(created.id, created);
      break;
    }
    case 'step_finished':
      if (step) {
        Object.assign(step, {
          status: event.status,
          ended_at: event.ts,
          duration_ms: event.duration_ms,
          model_calls: event.model_calls,
          tool_calls: event.tool_calls,
          cost_usd: event.cost_usd,
          summary: event.summary,
          output: event.output,
        });
      }
      break;
    case 'tool_call':
      step?.calls.push({ call_id: event.call_id, name: event.name, input: event.input, ts: event.ts });
      if (step) step.tool_calls = step.calls.length;
      break;
    case 'tool_result': {
      const call = step?.calls.find((item) => item.call_id === event.call_id);
      if (call) call.result = { ok: event.ok, text: event.text, ts: event.ts };
      break;
    }
    case 'agent_text':
      step?.texts.push(event.text);
      break;
    case 'state_snapshot':
      if (step) step.snapshot = event.state;
      if (event.state.scope === 'revise') view.merged = event.state;
      else if (event.state.scope === 'orchestrator') view.orchestrator = event.state;
      else view.teams.set(event.step_id, event.state);
      break;
    case 'guard_result':
      view.guardHits = event.hits;
      break;
    case 'check_result':
      view.checks.push(event);
      break;
    case 'awaiting_approval':
      view.packet = event.packet;
      break;
    case 'decision':
      view.decision = event.decision;
      break;
    case 'outbox_written':
      view.outbox = event;
      break;
    case 'run_finished':
      view.finished = event;
      break;
    case 'run_failed':
      view.failed = event.error;
      break;
  }
  return true;
};

export interface BoardPlan {
  facts?: StateView['facts'];
  milestones: StateView['milestones'];
  tasks: PlanTask[];
  flags: StateView['flags'];
  untrusted: StateView['untrusted'];
  merged: boolean;
}

// Before the merge the board shows each specialist's live work; after it, the merged plan.
export const boardPlan = (view: RunView): BoardPlan => {
  if (view.merged) return { ...view.merged, merged: true };
  const teams = [...view.teams.values()];
  return {
    facts: view.orchestrator?.facts ?? teams[0]?.facts,
    milestones: view.orchestrator?.milestones ?? teams[0]?.milestones ?? [],
    tasks: teams.flatMap((team) => team.tasks),
    flags: [...(view.orchestrator?.flags ?? []), ...teams.flatMap((team) => team.flags)],
    untrusted: [...(view.orchestrator?.untrusted ?? []), ...teams.flatMap((team) => team.untrusted)],
    merged: false,
  };
};

export const specialistOf = (view: RunView, team: Team): StepView | undefined => view.steps.find((step) => step.group === 'specialists' && step.team === team);

export interface Counters {
  modelCalls: number;
  toolCalls: number;
  costUsd: number;
}

export const counters = (view: RunView): Counters =>
  view.steps.reduce(
    (sum, step) => ({ modelCalls: sum.modelCalls + step.model_calls, toolCalls: sum.toolCalls + step.tool_calls, costUsd: sum.costUsd + (step.cost_usd ?? 0) }),
    { modelCalls: 0, toolCalls: 0, costUsd: 0 },
  );

export type Stage = 'plan' | 'checks' | 'approval' | 'outbox';

export const currentStage = (view: RunView): Stage => {
  if (view.outbox) return 'outbox';
  if (view.packet) return 'approval';
  const last = view.steps.at(-1);
  if (last && (last.kind === 'check' || last.kind === 'agent' && last.scope === 'revise')) return 'checks';
  return 'plan';
};

export const stageLabel = (view: RunView): string => {
  if (view.failed) return 'Run failed';
  if (view.finished) return view.finished.status === 'approved_dry_run' ? 'Dry run sent' : view.finished.status === 'evaluated' ? 'Evaluated' : 'Not approved';
  if (view.packet && !view.decision) return 'Waiting for you';
  const running = view.steps.filter((step) => step.status === 'running');
  if (running.some((step) => step.group === 'specialists')) return `${running.length} specialists working`;
  return running.at(-1)?.label ?? 'Starting';
};
