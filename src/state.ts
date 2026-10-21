import { readJson, writeJson } from './runlog.ts';
import type { PlanState, Scope, Team } from './types.ts';

export const newState = (runId: string, today: string, briefLineCount: number, scope: Scope = 'revise', team?: Team): PlanState => ({
  run_id: runId,
  today,
  brief_line_count: briefLineCount,
  scope,
  team,
  max_steps: 0,
  steps_used: 0,
  finished: false,
  finish_note: '',
  milestones: [],
  assignments: [],
  tasks: [],
  flags: [],
  untrusted: [],
  removed: [],
  next_flag: 1,
});

export const loadState = (file: string): PlanState => readJson<PlanState>(file);

export const saveState = (file: string, state: PlanState): void => writeJson(file, state);

// The parts of a state worth showing to a person or another agent.
export type StateView = Pick<PlanState, 'scope' | 'team' | 'facts' | 'milestones' | 'assignments' | 'tasks' | 'flags' | 'untrusted' | 'slack' | 'steps_used' | 'max_steps' | 'finished'>;

export const viewOf = (state: PlanState): StateView => ({
  scope: state.scope,
  team: state.team,
  facts: state.facts,
  milestones: state.milestones,
  assignments: state.assignments,
  tasks: state.tasks,
  flags: state.flags,
  untrusted: state.untrusted,
  slack: state.slack,
  steps_used: state.steps_used,
  max_steps: state.max_steps,
  finished: state.finished,
});
