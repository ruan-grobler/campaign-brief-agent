import type { JSX } from 'preact';
import { TEAM_COLOUR, duration, highlightJson, usd } from '../format.ts';
import type { RunView, StepView } from '../store.ts';
import { TEAMS, TEAM_PREFIX, type Team } from '../types.ts';
import { Pill, StatusDot } from './common.tsx';

interface Slot {
  id: string;
  label: string;
  hint: string;
  optional?: boolean;
}

// The whole pipeline is drawn from the start, so a viewer sees what is coming before it runs.
const BEFORE: Slot[] = [
  { id: 'guard', label: 'Input guard', hint: 'Deterministic scan for text that tries to instruct an AI' },
  { id: 'orchestrator', label: 'Orchestrator', hint: 'Sets facts, milestones and a brief for each specialist' },
];
const AFTER: Slot[] = [
  { id: 'merge', label: 'Merge and rule checks', hint: 'Plain code: working days, dependency order, milestones' },
  { id: 'summary', label: 'Kickoff note', hint: 'One structured model call writes the Slack note' },
  { id: 'check-1', label: 'Adversarial check', hint: 'Separate reviewer, no tools, never sees the agents’ reasoning' },
  { id: 'revise-1', label: 'Revision', hint: 'Fixes the findings, or parks them for a human', optional: true },
  { id: 'check-2', label: 'Re-check', hint: 'Are the findings fixed, and did the fix break anything?', optional: true },
  { id: 'approval', label: 'Human approval', hint: 'Human by exception: only the uncertain items need you' },
  { id: 'send', label: 'Send (dry run)', hint: 'Builds the Asana and Slack API bodies. Sends nothing.', optional: true },
];

const elapsed = (step: StepView, now: number): number => step.duration_ms ?? Math.max(0, now - Date.parse(step.started_at));

const StepRow = ({ slot, step, now, skipped, onSelect, selected }: { slot: Slot; step?: StepView; now: number; skipped: boolean; onSelect: (id: string) => void; selected: boolean }): JSX.Element => {
  const status = step?.status ?? (skipped ? 'skipped' : 'pending');
  return (
    <button type="button" class={`step ${selected ? 'step-selected' : ''} step-${status}`} disabled={!step} onClick={() => step && onSelect(step.id)}>
      <StatusDot status={status} />
      <span class="step-main">
        <span class="step-label">{slot.label}</span>
        <span class="step-hint">{step?.summary ?? (skipped ? 'Not needed this run' : slot.hint)}</span>
      </span>
      <span class="step-meta">
        {step ? duration(elapsed(step, now)) : ''}
        {step && step.model_calls ? <span class="step-calls">{step.model_calls} calls</span> : null}
      </span>
    </button>
  );
};

const Lane = ({ team, step, now, onSelect, selected }: { team: Team; step?: StepView; now: number; onSelect: (id: string) => void; selected: boolean }): JSX.Element => {
  const used = step?.snapshot?.steps_used ?? step?.calls.length ?? 0;
  const budget = step?.budget ?? 12;
  const tasks = step?.snapshot?.tasks.length ?? 0;
  return (
    <button type="button" class={`lane ${selected ? 'step-selected' : ''}`} style={`--team: ${TEAM_COLOUR[team]}`} disabled={!step} onClick={() => step && onSelect(step.id)}>
      <span class="lane-head">
        <StatusDot status={step?.status ?? 'pending'} />
        <span class="lane-name">{team}</span>
        <span class="lane-count">{step ? `${tasks} tasks` : TEAM_PREFIX[team]}</span>
      </span>
      <span class="lane-bar" title={`${used} of ${budget} tool calls`}>
        <span style={`width: ${Math.min(100, (used / budget) * 100)}%`} />
      </span>
      <span class="lane-ticks">
        {(step?.calls ?? []).map((call) => (
          <i key={call.call_id} class={call.result ? (call.result.ok ? 'tick-ok' : 'tick-bad') : 'tick-wait'} title={call.name} />
        ))}
      </span>
      <span class="lane-meta">{step ? `${duration(elapsed(step, now))} · ${used}/${budget}` : 'waiting'}</span>
    </button>
  );
};

export const Timeline = ({ view, now, selected, onSelect }: { view: RunView; now: number; selected?: string; onSelect: (id: string) => void }): JSX.Element => {
  const approvalStarted = view.byId.has('approval') || Boolean(view.finished);
  const evaluated = view.finished?.status === 'evaluated';
  const skippedFor = (slot: Slot): boolean => {
    if (view.byId.has(slot.id)) return false;
    if (slot.id === 'send') return evaluated || Boolean(view.decision && !view.decision.approved);
    if (slot.id === 'approval') return evaluated;
    return Boolean(slot.optional) && approvalStarted;
  };
  const row = (slot: Slot): JSX.Element => (
    <StepRow key={slot.id} slot={slot} step={view.byId.get(slot.id)} now={now} skipped={skippedFor(slot)} onSelect={onSelect} selected={selected === slot.id} />
  );
  const specialistsRunning = view.steps.some((step) => step.group === 'specialists' && step.status === 'running');
  return (
    <aside class="timeline" aria-label="Run timeline">
      <h2 class="panel-title">Run timeline</h2>
      {BEFORE.map(row)}
      <div class={`parallel ${specialistsRunning ? 'parallel-live' : ''}`}>
        <div class="parallel-label">
          <span>Specialists</span>
          <Pill tone="accent">5 in parallel</Pill>
        </div>
        {TEAMS.map((team) => {
          const step = view.steps.find((item) => item.group === 'specialists' && item.team === team);
          return <Lane key={team} team={team} step={step} now={now} onSelect={onSelect} selected={selected === step?.id} />;
        })}
      </div>
      {AFTER.map(row)}
    </aside>
  );
};

const describe = (input: unknown): string => {
  const text = JSON.stringify(input);
  return text.length > 90 ? `${text.slice(0, 89)}…` : text;
};

export const Inspector = ({ step, onClose }: { step: StepView; onClose: () => void }): JSX.Element => (
  <div class="drawer-backdrop" onClick={onClose}>
    <div class="drawer" role="dialog" aria-modal="true" aria-label={`${step.label} details`} onClick={(event) => event.stopPropagation()}>
      <header class="drawer-head">
        <div>
          <p class="eyebrow">{step.kind === 'agent' ? 'Agent step' : 'Step'} · {step.id}</p>
          <h2>{step.label}</h2>
        </div>
        <button type="button" class="icon-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div class="drawer-stats">
        <Pill tone={step.status === 'done' ? 'good' : step.status === 'running' ? 'accent' : step.status === 'failed' ? 'bad' : 'warn'}>{step.status}</Pill>
        <span>{duration(step.duration_ms)}</span>
        <span>{step.model_calls} model calls</span>
        <span>{step.tool_calls} tool calls</span>
        {step.budget ? <span>budget {step.budget}</span> : null}
        {step.cost_usd !== undefined ? <span>{usd(step.cost_usd)} API-equivalent</span> : null}
      </div>
      {step.summary ? <p class="drawer-summary">{step.summary}</p> : null}
      {step.input?.system ? (
        <details class="block">
          <summary>System prompt</summary>
          <pre class="mono">{step.input.system}</pre>
        </details>
      ) : null}
      {step.input?.prompt ? (
        <details class="block">
          <summary>Input this step received</summary>
          <pre class="mono">{step.input.prompt}</pre>
        </details>
      ) : null}
      {step.calls.length ? (
        <div class="block">
          <h4>Tool calls the agent chose ({step.calls.length})</h4>
          <ol class="calls">
            {step.calls.map((call, index) => (
              <li key={call.call_id}>
                <details>
                  <summary>
                    <span class="call-index">{index + 1}</span>
                    <span class="call-name">{call.name}</span>
                    <span class={call.result ? (call.result.ok ? 'call-ok' : 'call-bad') : 'call-wait'}>{call.result ? (call.result.ok ? '✓' : '✗') : '…'}</span>
                    <span class="call-brief">{call.result?.text.split('\n')[0] ?? describe(call.input)}</span>
                  </summary>
                  <p class="label">Input</p>
                  <pre class="mono json" dangerouslySetInnerHTML={{ __html: highlightJson(call.input) }} />
                  {call.result ? (
                    <>
                      <p class="label">Result</p>
                      <pre class="mono">{call.result.text}</pre>
                    </>
                  ) : null}
                </details>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {step.texts.length ? (
        <div class="block">
          <h4>What the agent said</h4>
          {step.texts.map((text, index) => (
            <p key={index} class="quote">
              {text.replace(/\*\*/g, '')}
            </p>
          ))}
        </div>
      ) : null}
      {step.output !== undefined ? (
        <details class="block" open={step.kind !== 'agent'}>
          <summary>Output</summary>
          <pre class="mono json" dangerouslySetInnerHTML={{ __html: highlightJson(step.output) }} />
        </details>
      ) : null}
    </div>
  </div>
);
