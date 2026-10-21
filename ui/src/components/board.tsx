import type { JSX } from 'preact';
import { TEAM_COLOUR, daysBetween, prettyDate, timingLabel } from '../format.ts';
import { boardPlan, specialistOf, type RunView } from '../store.ts';
import { TEAMS, type PlanTask } from '../types.ts';
import { Confidence, Empty, Pill, StatusDot } from './common.tsx';

const TaskCard = ({ task, threshold, milestone }: { task: PlanTask; threshold: number; milestone: boolean }): JSX.Element => (
  <article class={`task ${task.confidence < threshold ? 'task-exception' : ''}`}>
    <header class="task-head">
      <span class="task-id">{task.id}</span>
      {milestone ? <Pill tone="accent">milestone</Pill> : null}
      {task.confidence < threshold ? <Pill tone="warn">needs you</Pill> : null}
      <span class="task-due">{prettyDate(task.due_date)}</span>
    </header>
    <p class="task-title">{task.title}</p>
    <footer class="task-foot">
      <Confidence value={task.confidence} threshold={threshold} />
      <span class="task-timing">{timingLabel(task.timing)}</span>
      {task.depends_on.length ? <span class="task-deps" title={task.depends_on.join(', ')}>⟵ {task.depends_on.length}</span> : null}
    </footer>
  </article>
);

export const PlanBoard = ({ view }: { view: RunView }): JSX.Element => {
  const plan = boardPlan(view);
  const threshold = view.started?.policy.humanReviewBelow ?? 0.7;
  const milestoneIds = new Set(plan.milestones.map((milestone) => milestone.id));
  const facts = plan.facts;
  const today = view.started?.today ?? '';
  return (
    <div class="board-wrap">
      <div class="facts">
        {facts ? (
          <>
            <div class="fact">
              <span class="fact-label">Client</span>
              <span class="fact-value">{facts.client}</span>
            </div>
            <div class="fact">
              <span class="fact-label">Launch</span>
              <span class="fact-value">
                {prettyDate(facts.launch_date)} <span class="muted">· in {daysBetween(today, facts.launch_date)} days</span>
              </span>
            </div>
            <div class="fact">
              <span class="fact-label">Markets</span>
              <span class="fact-value">{facts.markets.join(', ')}</span>
            </div>
            <div class="fact">
              <span class="fact-label">Milestones</span>
              <span class="fact-value">{plan.milestones.length}</span>
            </div>
            <div class="fact">
              <span class="fact-label">Questions parked</span>
              <span class="fact-value">{plan.flags.length}</span>
            </div>
            <div class="fact">
              <span class="fact-label">Tasks</span>
              <span class="fact-value">
                {plan.tasks.length} <span class="muted">{plan.merged ? 'merged' : 'so far'}</span>
              </span>
            </div>
          </>
        ) : (
          <Empty>The orchestrator is reading the brief and the playbooks.</Empty>
        )}
      </div>
      {plan.milestones.length ? (
        <div class="milestones" aria-label="Milestones">
          {plan.milestones.map((milestone) => (
            <span key={milestone.id} class="milestone" style={`--team: ${TEAM_COLOUR[milestone.team]}`} title={`${milestone.title}. For ${milestone.for_teams.join(', ')}.`}>
              <b>{milestone.id}</b> {prettyDate(milestone.due_by)}
            </span>
          ))}
        </div>
      ) : null}
      {plan.untrusted.length ? (
        <div class="alert alert-warn">
          <b>Blocked instruction.</b> {plan.untrusted.map((flag) => `${flag.brief_ref}: "${flag.quote}"`).join(' ')} The agents flagged it and did not act on it.
        </div>
      ) : null}
      <div class="board">
        {TEAMS.map((team) => {
          const tasks = plan.tasks.filter((task) => task.team === team).sort((a, b) => a.due_date.localeCompare(b.due_date));
          const step = specialistOf(view, team);
          return (
            <section key={team} class="column" style={`--team: ${TEAM_COLOUR[team]}`}>
              <header class="column-head">
                <StatusDot status={step?.status ?? 'pending'} />
                <h3>{team}</h3>
                <span class="column-count">{tasks.length}</span>
              </header>
              <div class="column-body">
                {tasks.length ? (
                  tasks.map((task) => <TaskCard key={task.id} task={task} threshold={threshold} milestone={milestoneIds.has(task.id)} />)
                ) : (
                  <Empty>{step ? 'Planning…' : 'Waiting for the orchestrator'}</Empty>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
};
