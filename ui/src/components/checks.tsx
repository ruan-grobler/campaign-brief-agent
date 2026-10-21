import type { JSX } from 'preact';
import type { RunView } from '../store.ts';
import type { Critique, EventOf } from '../types.ts';
import { Empty, Pill, Section } from './common.tsx';

const blocking = (critique?: Critique): number => critique?.findings.filter((finding) => finding.severity !== 'low').length ?? 0;

const Coverage = ({ critique }: { critique: Critique }): JSX.Element => {
  const total = critique.requirements.length || 1;
  const count = (status: string): number => critique.requirements.filter((item) => item.status === status).length;
  return (
    <div class="coverage">
      <div class="coverage-bar" role="img" aria-label={`${count('covered')} covered, ${count('partial')} partial, ${count('missing')} missing`}>
        <span class="cov-covered" style={`width: ${(count('covered') / total) * 100}%`} />
        <span class="cov-partial" style={`width: ${(count('partial') / total) * 100}%`} />
        <span class="cov-missing" style={`width: ${(count('missing') / total) * 100}%`} />
      </div>
      <p class="coverage-legend">
        <b>{critique.requirements.length}</b> requirements traced to brief lines: <span class="good">{count('covered')} covered</span> · <span class="warn">{count('partial')} partial</span> ·{' '}
        <span class="bad">{count('missing')} missing</span>
      </p>
    </div>
  );
};

const CheckCard = ({ check, previous }: { check: EventOf<'check_result'>; previous?: EventOf<'check_result'> }): JSX.Element => {
  const { critique } = check;
  return (
    <Section
      title={check.pass === 1 ? 'Check 1: adversarial review' : `Check ${check.pass}: re-check after revision`}
      aside={critique ? <Pill tone={blocking(critique) ? 'warn' : 'good'}>{blocking(critique) ? `${blocking(critique)} blocking` : 'nothing blocking'}</Pill> : <Pill tone="bad">failed</Pill>}
    >
      {previous && critique ? (
        <p class="delta">
          Blocking findings went from <b>{blocking(previous.critique)}</b> to <b>{blocking(critique)}</b> after one revision.
        </p>
      ) : null}
      <ul class="rubric">
        {check.rubric.map((item) => (
          <li key={item.id} class={item.pass ? 'pass' : 'fail'}>
            <span class="rubric-mark">{item.pass ? '✓' : '✗'}</span>
            <span class="rubric-label">{item.label}</span>
            <span class="rubric-detail">{item.detail}</span>
          </li>
        ))}
      </ul>
      {critique ? (
        <>
          <Coverage critique={critique} />
          <p class="summary-text">{critique.summary}</p>
          {critique.findings.length ? (
            <ol class="findings">
              {critique.findings.map((finding) => (
                <li key={finding.id} class={`finding finding-${finding.severity}`}>
                  <header>
                    <b>{finding.id}</b> <Pill tone={finding.severity === 'high' ? 'bad' : finding.severity === 'medium' ? 'warn' : 'neutral'}>{finding.severity}</Pill>
                    <span class="muted">{finding.category.replace(/_/g, ' ')}</span>
                    <span class="muted refs">{[...finding.task_ids, ...finding.brief_refs].join(' · ')}</span>
                  </header>
                  <p>{finding.detail}</p>
                  <p class="fix">Fix: {finding.fix}</p>
                </li>
              ))}
            </ol>
          ) : (
            <Empty>No findings.</Empty>
          )}
          <details class="block">
            <summary>Requirement trace ({critique.requirements.length})</summary>
            <table class="trace">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Requirement</th>
                  <th>Status</th>
                  <th>Tasks</th>
                </tr>
              </thead>
              <tbody>
                {critique.requirements.map((item) => (
                  <tr key={`${item.ref}-${item.requirement}`}>
                    <td class="mono">{item.ref}</td>
                    <td>{item.requirement}</td>
                    <td class={`status-${item.status}`}>{item.status}</td>
                    <td class="mono">{item.task_ids.join(', ') || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      ) : (
        <div class="alert alert-bad">The checker failed: {check.error}. This is treated as an open risk, never as a pass.</div>
      )}
    </Section>
  );
};

export const ChecksPanel = ({ view }: { view: RunView }): JSX.Element => {
  if (!view.checks.length) {
    const running = view.byId.get('check-1')?.status === 'running';
    return <Empty>{running ? 'The checker is reviewing the plan against every line of the brief…' : 'Checks run after the specialists finish and the plan is merged.'}</Empty>;
  }
  return (
    <div class="checks">
      {[...view.checks].reverse().map((check) => (
        <CheckCard key={check.step_id} check={check} previous={view.checks.find((item) => item.pass === check.pass - 1)} />
      ))}
    </div>
  );
};
