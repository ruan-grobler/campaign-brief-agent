// Deterministic plan checks. Rule-based on purpose: they must give the same answer every run.
import { POLICY } from './config.ts';
import { closedReason, isIsoDate, nextWorkingDay, weekday } from './dates.ts';
import { teamOfId, type Milestone, type PlanState, type PlanTask, type Team } from './types.ts';

export interface LintIssue {
  level: 'error' | 'warning';
  code: string;
  task_id?: string;
  related?: string; // the other task involved, for dependency issues
  message: string;
}

export interface LintContext {
  today: string;
  briefLines: number;
  closed: Map<string, string>;
  launchDate?: string;
  known: Map<string, PlanTask>;
  milestones: Map<string, Milestone>;
  // Set while one specialist plans: other teams' work is reachable only through milestones.
  team?: Team;
  // While a plan is being built, a task may point at a dependency that is added later.
  final: boolean;
}

export const contextFor = (state: PlanState, closed: Map<string, string>, known?: Map<string, PlanTask>, final = false): LintContext => ({
  today: state.today,
  briefLines: state.brief_line_count,
  closed,
  launchDate: state.facts?.launch_date,
  known: known ?? new Map(state.tasks.map((task) => [task.id, task])),
  milestones: new Map(state.milestones.map((milestone) => [milestone.id, milestone])),
  team: state.scope === 'team' ? state.team : undefined,
  final,
});

// Is this a real working day, on or after the run date?
export const dateProblems = (iso: string, label: string, today: string, closed: Map<string, string>): { code: string; message: string }[] => {
  if (!isIsoDate(iso)) return [{ code: 'bad_date', message: `${label}: "${iso}" is not a real YYYY-MM-DD date.` }];
  const problems: { code: string; message: string }[] = [];
  const reason = closedReason(iso, closed);
  if (reason !== undefined) {
    const what = reason === 'weekend' ? `a ${weekday(iso)} (weekend)` : `an agency closed day (${reason})`;
    problems.push({ code: 'non_working_day', message: `${label}: ${iso} is ${what}. Next working day is ${nextWorkingDay(iso, closed)}.` });
  }
  if (iso < today) problems.push({ code: 'past_date', message: `${label}: ${iso} is before the run date ${today}.` });
  return problems;
};

export const lintTask = (task: PlanTask, ctx: LintContext): LintIssue[] => {
  const issues: LintIssue[] = [];
  const add = (level: LintIssue['level'], code: string, message: string, related?: string): void => {
    issues.push({ level, code, task_id: task.id, related, message });
  };

  for (const problem of dateProblems(task.due_date, task.id, ctx.today, ctx.closed)) add('error', problem.code, problem.message);

  const launch = ctx.launchDate;
  if (launch && isIsoDate(launch) && isIsoDate(task.due_date)) {
    if (task.timing === 'before_launch' && task.due_date >= launch) {
      add('error', 'timing', `${task.id} is before_launch but due ${task.due_date}, on or after the launch date ${launch}.`);
    } else if (task.timing === 'launch_day' && task.due_date !== launch) {
      add('error', 'timing', `${task.id} is launch_day but due ${task.due_date}, not the launch date ${launch}.`);
    } else if (task.timing === 'after_launch' && task.due_date <= launch) {
      add('error', 'timing', `${task.id} is after_launch but due ${task.due_date}, on or before the launch date ${launch}.`);
    }
  }

  for (const ref of task.brief_refs) {
    const line = Number(ref.slice(1));
    if (!(line >= 1 && line <= ctx.briefLines)) add('error', 'bad_brief_ref', `${task.id}: ${ref} is not a line in the brief (L1 to L${ctx.briefLines}).`);
  }

  if (task.acceptance_criteria.filter((criterion) => criterion.trim()).length < POLICY.minCriteria) {
    add('error', 'criteria', `${task.id} needs at least ${POLICY.minCriteria} acceptance criteria.`);
  }

  if (!(task.confidence >= 0 && task.confidence <= 1)) add('error', 'confidence', `${task.id}: confidence must be a number from 0 to 1.`);
  else if (task.confidence < POLICY.assumptionBelow && !task.assumption?.trim()) {
    add('error', 'assumption_required', `${task.id}: confidence ${task.confidence} is below ${POLICY.assumptionBelow}, so it needs an assumption saying what you assumed.`);
  }

  const milestone = ctx.milestones.get(task.id);
  if (milestone && isIsoDate(task.due_date) && task.due_date > milestone.due_by) {
    add('error', 'milestone_late', `${task.id} is a milestone due by ${milestone.due_by}, but the task is due ${task.due_date}.`);
  }

  for (const dep of task.depends_on) {
    if (dep === task.id) {
      add('error', 'self_dependency', `${task.id} depends on itself.`);
      continue;
    }
    if (ctx.team && teamOfId(dep) !== ctx.team) {
      const shared = ctx.milestones.get(dep);
      if (!shared) {
        const reachable = [...ctx.milestones.keys()].filter((id) => teamOfId(id) !== ctx.team).join(', ') || 'none defined';
        add('error', 'cross_team_dependency', `${task.id} depends on ${dep}, but other teams' work is only reachable through milestones: ${reachable}.`, dep);
      } else if (isIsoDate(task.due_date) && shared.due_by > task.due_date) {
        add('error', 'dependency_after', `${task.id} is due ${task.due_date} but depends on milestone ${dep}, due by ${shared.due_by}.`, dep);
      }
      continue;
    }
    const other = ctx.known.get(dep);
    if (!other) {
      add(ctx.final ? 'error' : 'warning', 'unknown_dependency', `${task.id} depends on ${dep}, which is not in the plan${ctx.final ? '' : ' yet'}.`, dep);
      continue;
    }
    if (isIsoDate(other.due_date) && isIsoDate(task.due_date) && other.due_date > task.due_date) {
      add('error', 'dependency_after', `${task.id} is due ${task.due_date} but depends on ${dep}, which is due later (${other.due_date}).`, dep);
    }
  }

  return issues;
};

const findCycle = (tasks: PlanTask[]): string[] | undefined => {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'visiting');
    path.push(id);
    for (const dep of byId.get(id)?.depends_on ?? []) {
      if (!byId.has(dep)) continue;
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return undefined;
};

const structural = (tasks: PlanTask[], milestones: Milestone[], known: Map<string, PlanTask>): LintIssue[] => {
  const issues: LintIssue[] = [];
  const cycle = findCycle(tasks);
  if (cycle) issues.push({ level: 'error', code: 'dependency_cycle', message: `Dependency cycle: ${cycle.join(' -> ')}.` });
  const titles = new Map<string, string>();
  for (const task of tasks) {
    const key = task.title.trim().toLowerCase();
    const first = titles.get(key);
    if (first) issues.push({ level: 'warning', code: 'duplicate_title', task_id: task.id, message: `${task.id} has the same title as ${first}.` });
    else titles.set(key, task.id);
  }
  for (const milestone of milestones) {
    const task = known.get(milestone.id);
    if (!task) issues.push({ level: 'error', code: 'milestone_missing', task_id: milestone.id, message: `Milestone ${milestone.id} (${milestone.title}) has no task.` });
    else if (task.team !== milestone.team) {
      issues.push({ level: 'error', code: 'milestone_owner', task_id: milestone.id, message: `Milestone ${milestone.id} belongs to ${milestone.team}, but the task is owned by ${task.team}.` });
    }
  }
  if (tasks.length === 0) issues.push({ level: 'error', code: 'no_tasks', message: 'The plan has no tasks.' });
  return issues;
};

// The merged plan: every task, every milestone, and (once written) the Slack note.
export const lintPlan = (state: PlanState, closed: Map<string, string>, options: { requireSlack: boolean } = { requireSlack: true }): LintIssue[] => {
  const ctx = { ...contextFor(state, closed, undefined, true), team: undefined };
  const issues = [...state.tasks.flatMap((task) => lintTask(task, ctx)), ...structural(state.tasks, state.milestones, ctx.known)];
  if (options.requireSlack && !state.slack) issues.push({ level: 'error', code: 'no_slack_summary', message: 'There is no Slack summary. Call set_slack_summary.' });
  return issues;
};

// One specialist's share: its own tasks, and the milestones its team promised.
export const lintTeam = (state: PlanState, closed: Map<string, string>): LintIssue[] => {
  const ctx = contextFor(state, closed, undefined, true);
  const own = state.milestones.filter((milestone) => milestone.team === state.team);
  return [...state.tasks.flatMap((task) => lintTask(task, ctx)), ...structural(state.tasks, own, ctx.known)];
};
