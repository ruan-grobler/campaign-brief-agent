import { render, type JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { followRun, getEvents, getMeta, getRuns, replayRun, startRun } from './api.ts';
import { ApprovalPanel } from './components/approval.tsx';
import { ChecksPanel } from './components/checks.tsx';
import { Empty, Pill, StatusDot } from './components/common.tsx';
import { OutboxPanel } from './components/outbox.tsx';
import { PlanBoard } from './components/board.tsx';
import { Inspector, Timeline } from './components/timeline.tsx';
import { duration, usd } from './format.ts';
import { applyEvent, boardPlan, counters, currentStage, emptyView, stageLabel, type RunView, type Stage } from './store.ts';
import type { Meta, RunSummary } from './types.ts';

type Route = { name: 'home' } | { name: 'run'; runId: string; mode: 'live' | 'replay'; speed: number };

const parseHash = (): Route => {
  const [path = '/', query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  const live = path.match(/^\/run\/(run-[\w-]+)$/);
  if (live?.[1]) return { name: 'run', runId: live[1], mode: 'live', speed: 1 };
  const replay = path.match(/^\/replay\/(run-[\w-]+)$/);
  if (replay?.[1]) return { name: 'run', runId: replay[1], mode: 'replay', speed: Number(new URLSearchParams(query).get('speed')) || 8 };
  return { name: 'home' };
};

const STATUS_TONE: Record<string, string> = { approved_dry_run: 'good', evaluated: 'accent', running: 'accent', awaiting_approval: 'warn', not_approved: 'neutral', failed: 'bad', incomplete: 'neutral' };

const Home = (): JSX.Element => {
  const [meta, setMeta] = useState<Meta>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [brief, setBrief] = useState('examples/brief.md');
  const [today, setToday] = useState('');
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    getMeta().then(setMeta).catch((failure: Error) => setError(failure.message));
    getRuns().then(setRuns).catch(() => undefined);
  }, []);
  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      location.hash = `#/run/${await startRun(brief, today || undefined)}`;
    } catch (failure) {
      setError((failure as Error).message);
      setStarting(false);
    }
  };
  return (
    <div class="home">
      <header class="home-bar">
        <span class="brand">
          <span class="brand-mark" /> Agent Control Room
        </span>
        <Pill tone="warn">DRY RUN · no credentials · no real writes</Pill>
      </header>
      <section class="hero">
        <p class="eyebrow">Campaign brief agent</p>
        <h1>A brief goes in. A team of agents plans the launch, a checker attacks the plan, and you approve by exception.</h1>
        <ol class="flow">
          <li>Input guard</li>
          <li>Orchestrator</li>
          <li>5 specialists in parallel</li>
          <li>Merge and rule checks</li>
          <li>Adversarial check</li>
          <li>One revision and a re-check</li>
          <li>Human approval</li>
          <li>Dry-run send to Asana and Slack</li>
        </ol>
        <div class="start">
          <label>
            Brief
            <select value={brief} onInput={(event) => setBrief(event.currentTarget.value)}>
              {(meta?.briefs ?? []).map((option) => (
                <option key={option.path} value={option.path}>
                  {option.group === 'eval' ? 'Eval: ' : ''}
                  {option.title} ({option.lines} lines)
                </option>
              ))}
            </select>
          </label>
          <label>
            Run date
            <input type="date" value={today || meta?.today || ''} onInput={(event) => setToday(event.currentTarget.value)} />
          </label>
          <button type="button" class="button button-primary" disabled={starting || !meta} onClick={() => void start()}>
            {starting ? 'Starting…' : 'Start live run'}
          </button>
        </div>
        {meta ? (
          <p class="muted small">
            {meta.runtime.label}. {meta.runtime.why}
          </p>
        ) : null}
        {error ? <p class="bad">{error}</p> : null}
      </section>
      <section class="runs">
        <h2>Recorded runs</h2>
        {runs.length ? (
          <table class="runs-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Brief</th>
                <th>Status</th>
                <th>Tasks</th>
                <th>Model calls</th>
                <th>Duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id}>
                  <td class="mono">{run.run_id}</td>
                  <td>
                    {run.title}
                    {run.label ? <span class="muted small"> · {run.label}</span> : null}
                  </td>
                  <td>
                    <Pill tone={STATUS_TONE[run.status] ?? 'neutral'}>{run.status.replace(/_/g, ' ')}</Pill>
                  </td>
                  <td>{run.tasks ?? ''}</td>
                  <td>{run.totals?.model_calls ?? ''}</td>
                  <td>{duration(run.totals?.duration_ms)}</td>
                  <td class="actions">
                    <a href={`#/run/${run.run_id}`}>Open</a>
                    <a href={`#/replay/${run.run_id}?speed=8`}>Replay 8x</a>
                    <a href={`#/replay/${run.run_id}?speed=20`}>20x</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No runs yet. Start one above.</Empty>
        )}
      </section>
    </div>
  );
};

const Meter = ({ label, value }: { label: string; value: string | number }): JSX.Element => (
  <div class="meter">
    <span class="meter-value">{value}</span>
    <span class="meter-label">{label}</span>
  </div>
);

const BriefView = ({ view }: { view: RunView }): JSX.Element => {
  const plan = boardPlan(view);
  const flagged = new Set(plan.untrusted.map((flag) => Number(flag.brief_ref.slice(1))));
  const guarded = new Set(view.guardHits.map((hit) => hit.line));
  return (
    <div class="brief">
      <p class="muted small">
        Every line is numbered so tasks, findings and requirements can cite it. The brief is treated as data, never as instructions.
      </p>
      <ol class="brief-lines">
        {(view.started?.brief_lines ?? []).map((line, index) => (
          <li key={index} class={flagged.has(index + 1) ? 'line-blocked' : guarded.has(index + 1) ? 'line-guarded' : ''}>
            <span class="line-no">L{index + 1}</span>
            <span class="line-text">{line || ' '}</span>
            {flagged.has(index + 1) ? <Pill tone="bad">blocked instruction</Pill> : guarded.has(index + 1) ? <Pill tone="warn">input guard</Pill> : null}
          </li>
        ))}
      </ol>
    </div>
  );
};

type Tab = Stage | 'brief';

const ControlRoom = ({ runId, mode, speed }: { runId: string; mode: 'live' | 'replay'; speed: number }): JSX.Element => {
  const viewRef = useRef<RunView>(emptyView());
  const [, setVersion] = useState(0);
  const [wallClock, setWallClock] = useState(Date.now());
  const [selected, setSelected] = useState<string>();
  const [tab, setTab] = useState<Tab>();

  useEffect(() => {
    viewRef.current = emptyView();
    setVersion((version) => version + 1);
    const onEvent = (event: Parameters<typeof applyEvent>[1]): void => {
      if (applyEvent(viewRef.current, event)) setVersion((version) => version + 1);
    };
    if (mode === 'live') return followRun(runId, onEvent, () => undefined);
    let stop = (): void => undefined;
    let cancelled = false;
    getEvents(runId)
      .then((events) => {
        if (!cancelled) stop = replayRun(events, speed, onEvent, () => undefined);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      stop();
    };
  }, [runId, mode, speed]);

  useEffect(() => {
    const timer = setInterval(() => setWallClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const view = viewRef.current;
  const stage = currentStage(view);
  useEffect(() => setTab(undefined), [stage]);
  const active: Tab = tab ?? stage;
  // A replay runs on the recorded clock, a live run on the wall clock.
  const now = mode === 'replay' || view.finished ? Date.parse(view.lastTs ?? new Date().toISOString()) : wallClock;
  const meters = counters(view);
  const elapsed = view.finished ? view.finished.totals.duration_ms : view.started ? now - Date.parse(view.started.ts) : 0;
  const plan = boardPlan(view);
  const blocking = view.checks.at(-1)?.critique?.findings.filter((finding) => finding.severity !== 'low').length;
  const needsYou = view.packet ? view.packet.exceptions.low_confidence.length + view.packet.exceptions.questions.length : undefined;
  const tabs: [Tab, string, string | number | undefined][] = [
    ['brief', 'Brief', view.started?.brief_lines.length],
    ['plan', 'Plan board', plan.tasks.length || undefined],
    ['checks', 'Checks', blocking === undefined ? undefined : `${blocking} blocking`],
    ['approval', 'Approval', needsYou],
    ['outbox', 'Outbox', view.outbox ? 'dry run' : undefined],
  ];
  const step = selected ? view.byId.get(selected) : undefined;

  return (
    <div class="room">
      <header class="topbar">
        <a href="#/" class="brand">
          <span class="brand-mark" /> Agent Control Room
        </a>
        <div class="run-title">
          <span class="run-name">{view.started?.title ?? 'Connecting…'}</span>
          <span class="mono muted small">
            {runId} · {view.started?.runtime.label ?? ''}
          </span>
        </div>
        <div class="stage">
          <StatusDot status={view.failed ? 'failed' : view.finished ? 'done' : view.packet && !view.decision ? 'waiting' : 'running'} />
          {stageLabel(view)}
        </div>
        <div class="meters">
          <Meter label="elapsed" value={duration(elapsed)} />
          <Meter label="model calls" value={meters.modelCalls} />
          <Meter label="tool calls" value={meters.toolCalls} />
          <Meter label="API-equivalent" value={usd(meters.costUsd)} />
        </div>
        <div class="badges">
          {mode === 'replay' ? <Pill tone="accent">Replay {speed}x</Pill> : <Pill tone="accent">Live</Pill>}
          <Pill tone="warn">DRY RUN</Pill>
        </div>
      </header>
      {view.failed ? <div class="alert alert-bad banner">Run failed: {view.failed}</div> : null}
      <div class="room-body">
        <Timeline view={view} now={now} selected={selected} onSelect={setSelected} />
        <main class="main">
          <nav class="tabs" role="tablist">
            {tabs.map(([id, label, badge]) => (
              <button key={id} type="button" role="tab" aria-selected={active === id} class={`tab ${active === id ? 'tab-on' : ''}`} onClick={() => setTab(id)}>
                {label}
                {badge !== undefined ? <span class="tab-badge">{badge}</span> : null}
              </button>
            ))}
          </nav>
          <div class="tab-body">
            {active === 'brief' ? <BriefView view={view} /> : null}
            {active === 'plan' ? <PlanBoard view={view} /> : null}
            {active === 'checks' ? <ChecksPanel view={view} /> : null}
            {active === 'approval' ? <ApprovalPanel view={view} runId={runId} live={mode === 'live' && !view.finished} /> : null}
            {active === 'outbox' ? <OutboxPanel view={view} /> : null}
          </div>
        </main>
      </div>
      {step ? <Inspector step={step} onClose={() => setSelected(undefined)} /> : null}
    </div>
  );
};

const App = (): JSX.Element => {
  const [route, setRoute] = useState<Route>(parseHash());
  useEffect(() => {
    const onChange = (): void => setRoute(parseHash());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route.name === 'home' ? <Home /> : <ControlRoom key={`${route.runId}-${route.mode}-${route.speed}`} runId={route.runId} mode={route.mode} speed={route.speed} />;
};

const root = document.getElementById('app');
if (root) render(<App />, root);
