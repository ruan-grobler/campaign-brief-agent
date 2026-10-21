import type { JSX } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { sendDecision } from '../api.ts';
import { TEAM_COLOUR, prettyDate } from '../format.ts';
import type { RunView } from '../store.ts';
import { TEAMS, type Decision, type DecisionInput, type PlanTask, type ReviewPacket, type TaskDecision } from '../types.ts';
import { Confidence, Empty, Pill, Section, TeamTag } from './common.tsx';

type Choice = 'approve' | 'reject' | 'edit';

interface Edit {
  title: string;
  due_date: string;
  criteria: string;
}

const risksOf = (packet: ReviewPacket): string[] => [
  ...packet.exceptions.findings.map((finding) => `${finding.id} [${finding.severity}] ${finding.detail}`),
  ...packet.exceptions.rubric_failures.map((check) => `Rubric: ${check.label}. ${check.detail}`),
  ...packet.exceptions.rule_errors.map((message) => `Rule check: ${message}`),
  ...packet.exceptions.missed_by_agents.map((hit) => `Input guard: L${hit.line} ${hit.why}, and no agent flagged it`),
  ...packet.exceptions.guardrails,
];

const Choices = ({ value, onChoose, disabled }: { value?: Choice; onChoose: (choice: Choice) => void; disabled: boolean }): JSX.Element => (
  <span class="choices" role="group">
    {(['approve', 'edit', 'reject'] as Choice[]).map((choice) => (
      <button key={choice} type="button" class={`choice choice-${choice} ${value === choice ? 'choice-on' : ''}`} disabled={disabled} onClick={() => onChoose(choice)}>
        {choice === 'approve' ? '✓ Approve' : choice === 'edit' ? '✎ Edit' : '✕ Reject'}
      </button>
    ))}
  </span>
);

const EditForm = ({ task, edit, onChange, onDone }: { task: PlanTask; edit: Edit; onChange: (edit: Edit) => void; onDone: () => void }): JSX.Element => (
  <div class="edit-form">
    <label>
      Title
      <input value={edit.title} onInput={(event) => onChange({ ...edit, title: event.currentTarget.value })} />
    </label>
    <label>
      Due date
      <input type="date" value={edit.due_date} onInput={(event) => onChange({ ...edit, due_date: event.currentTarget.value })} />
    </label>
    <label class="wide">
      Acceptance criteria, one per line
      <textarea rows={4} value={edit.criteria} onInput={(event) => onChange({ ...edit, criteria: event.currentTarget.value })} />
    </label>
    <p class="muted">Edits go through the same rule checks as the agents' work: working days, timing against launch ({task.timing.replace('_', ' ')}), dependency order.</p>
    <button type="button" class="button" onClick={onDone}>
      Done editing
    </button>
  </div>
);

const DecisionSummary = ({ decision }: { decision: Decision }): JSX.Element => (
  <Section title={decision.approved ? 'Approved' : 'Not approved'} aside={<Pill tone={decision.approved ? 'good' : 'warn'}>{decision.approver}</Pill>}>
    <p class="summary-text">
      {decision.reason} {decision.approved_tasks.length} approved, {decision.rejected_tasks.length} rejected, {decision.edited_tasks.length} edited, at {new Date(decision.decided_at).toLocaleString()}.
    </p>
    {decision.answers.length ? (
      <ul class="plain">
        {decision.answers.map((answer) => (
          <li key={answer.id}>
            <b>{answer.id}</b> {answer.question} <span class="good">→ {answer.answer}</span>
          </li>
        ))}
      </ul>
    ) : null}
    {decision.rejected_tasks.length ? <p class="muted">Rejected: {decision.rejected_tasks.join(', ')}</p> : null}
  </Section>
);

export const ApprovalPanel = ({ view, runId, live }: { view: RunView; runId: string; live: boolean }): JSX.Element => {
  const packet = view.packet;
  const threshold = packet?.policy.human_review_below ?? 0.7;
  const low = useMemo(() => new Set(packet?.exceptions.low_confidence ?? []), [packet]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [editing, setEditing] = useState<string | undefined>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [acceptRisks, setAcceptRisks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  if (!packet) return <Empty>The approval screen opens when the checks are done. Confident tasks will arrive pre-approved.</Empty>;
  const decided = view.decision;
  const readOnly = !live || Boolean(decided) || busy;
  const risks = risksOf(packet);
  const recorded = (task: PlanTask): Choice | undefined => {
    if (!decided) return undefined;
    if (decided.rejected_tasks.includes(task.id)) return 'reject';
    return decided.edited_tasks.includes(task.id) ? 'edit' : 'approve';
  };
  const choiceOf = (task: PlanTask): Choice | undefined => recorded(task) ?? choices[task.id] ?? (low.has(task.id) ? undefined : 'approve');
  const exceptions = packet.tasks.filter((task) => low.has(task.id));
  const confident = packet.tasks.filter((task) => !low.has(task.id));
  const undecided = exceptions.filter((task) => !choices[task.id]);
  const approvedCount = packet.tasks.filter((task) => choiceOf(task) && choiceOf(task) !== 'reject').length;

  const choose = (task: PlanTask, choice: Choice): void => {
    setChoices({ ...choices, [task.id]: choice });
    if (choice === 'edit') {
      setEdits({ ...edits, [task.id]: edits[task.id] ?? { title: task.title, due_date: task.due_date, criteria: task.acceptance_criteria.join('\n') } });
      setEditing(task.id);
    } else if (editing === task.id) setEditing(undefined);
  };

  const submit = async (send: boolean): Promise<void> => {
    setBusy(true);
    setErrors([]);
    const tasks: TaskDecision[] = packet.tasks.map((task) => {
      const choice = choiceOf(task) ?? 'reject';
      const edit = edits[task.id];
      return choice === 'edit' && edit
        ? { id: task.id, action: 'edit', changes: { title: edit.title, due_date: edit.due_date, acceptance_criteria: edit.criteria.split('\n') } }
        : { id: task.id, action: choice === 'edit' ? 'approve' : choice };
    });
    const input: DecisionInput = {
      send,
      tasks,
      answers: Object.entries(answers).map(([id, answer]) => ({ id, answer })),
      accept_risks: acceptRisks,
      reason: send ? undefined : 'Rejected in the control room.',
    };
    try {
      await sendDecision(runId, input);
    } catch (error) {
      const details = (error as { errors?: string[] }).errors ?? [];
      setErrors([(error as Error).message, ...details]);
      setBusy(false);
    }
  };

  const row = (task: PlanTask, exception: boolean): JSX.Element => (
    <div key={task.id} class={`approve-row ${exception ? 'approve-exception' : ''} ${choiceOf(task) === 'reject' ? 'approve-rejected' : ''}`} style={`--team: ${TEAM_COLOUR[task.team]}`}>
      <div class="approve-main">
        <span class="task-id">{task.id}</span>
        <span class="approve-title">{edits[task.id] && choiceOf(task) === 'edit' ? edits[task.id]?.title : task.title}</span>
        <span class="muted">{prettyDate(edits[task.id] && choiceOf(task) === 'edit' ? (edits[task.id]?.due_date ?? task.due_date) : task.due_date)}</span>
        <Confidence value={task.confidence} threshold={threshold} />
        <Choices value={choiceOf(task)} onChoose={(choice) => choose(task, choice)} disabled={readOnly} />
      </div>
      {exception && task.assumption ? <p class="assumption">Assumes: {task.assumption}</p> : null}
      {editing === task.id && edits[task.id] ? (
        <EditForm task={task} edit={edits[task.id] as Edit} onChange={(edit) => setEdits({ ...edits, [task.id]: edit })} onDone={() => setEditing(undefined)} />
      ) : null}
    </div>
  );

  return (
    <div class="approval">
      <header class="approval-head">
        <div>
          <h2>Human approval</h2>
          <p class="muted">
            Human by exception: {confident.length} tasks arrive pre-approved at confidence {threshold} or more. {exceptions.length} need you. Nothing is sent without your click, and even then it is a dry run.
          </p>
        </div>
        {!live && !decided ? <Pill tone="neutral">replay, read only</Pill> : null}
      </header>

      {decided ? <DecisionSummary decision={decided} /> : null}

      <Section title={`Needs you (${exceptions.length + packet.exceptions.questions.length})`}>
        {exceptions.length ? <div class="rows">{exceptions.map((task) => row(task, true))}</div> : <Empty>No low-confidence tasks.</Empty>}
        {packet.exceptions.questions.length ? (
          <div class="questions">
            <h4>Questions the agents parked instead of guessing</h4>
            {packet.exceptions.questions.map((flag) => (
              <label key={flag.id} class="question">
                <span class="question-head">
                  <b>{flag.id}</b> <span class="muted">from {flag.raised_by}</span>
                </span>
                <span class="question-text">{flag.question}</span>
                <span class="muted small">Why it matters: {flag.why}</span>
                <input
                  placeholder="Answer, or leave it open"
                  value={answers[flag.id] ?? decided?.answers.find((answer) => answer.id === flag.id)?.answer ?? ''}
                  disabled={readOnly}
                  onInput={(event) => setAnswers({ ...answers, [flag.id]: event.currentTarget.value })}
                />
              </label>
            ))}
          </div>
        ) : null}
        {packet.exceptions.untrusted.length ? (
          <div class="alert alert-warn">
            <h4>Instructions in the brief the agents refused to follow</h4>
            {packet.exceptions.untrusted.map((flag) => (
              <p key={flag.id}>
                <b>{flag.brief_ref}</b> "{flag.quote}" <span class="muted">({flag.raised_by}: {flag.why})</span>
              </p>
            ))}
          </div>
        ) : null}
        {risks.length ? (
          <div class="risks">
            <h4>Open risks ({risks.length})</h4>
            <ul class="plain">
              {risks.map((risk) => (
                <li key={risk}>{risk}</li>
              ))}
            </ul>
            <label class="check">
              <input type="checkbox" checked={acceptRisks || Boolean(decided?.accepted_risks.length)} disabled={readOnly} onInput={(event) => setAcceptRisks(event.currentTarget.checked)} />
              I accept these open risks for this send
            </label>
          </div>
        ) : null}
      </Section>

      <Section title={`Pre-approved (${confident.length})`} aside={<span class="muted small">Approve is preselected. Edit or reject any of them.</span>}>
        {TEAMS.map((team) => {
          const tasks = confident.filter((task) => task.team === team).sort((a, b) => a.due_date.localeCompare(b.due_date));
          return tasks.length ? (
            <div key={team} class="team-group">
              <TeamTag team={team} />
              <div class="rows">{tasks.map((task) => row(task, false))}</div>
            </div>
          ) : null;
        })}
      </Section>

      {live && !decided ? (
        <footer class="approval-bar">
          <span>
            <b>{approvedCount}</b> to send · {packet.tasks.length - approvedCount} out · {Object.values(choices).filter((choice) => choice === 'edit').length} edited
            {undecided.length ? <span class="warn"> · decide {undecided.length} more</span> : null}
            {risks.length && !acceptRisks ? <span class="warn"> · accept the risks</span> : null}
          </span>
          <span class="bar-actions">
            <button type="button" class="button button-ghost" disabled={busy} onClick={() => void submit(false)}>
              Reject plan
            </button>
            <button type="button" class="button button-primary" disabled={busy || undecided.length > 0 || (risks.length > 0 && !acceptRisks)} onClick={() => void submit(true)}>
              Send to Asana and Slack · dry run
            </button>
          </span>
          {errors.length ? (
            <ul class="errors">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
};
