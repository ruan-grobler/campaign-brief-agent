// npm run demo: replays the recorded 19 Oct 2026 eval offline, with no API key and no network.
// Each synthetic brief runs through the real pipeline on its pinned run date: input guard, tool validation,
// merge, rubric, the revision loop and the re-check. The recorded model output drives it, every replayed
// event is checked against the recording, and the demo exits non-zero if anything differs.
import { join, relative } from 'node:path';
import { ROOT } from './config.ts';
import { replayCase, type ReplayOutcome } from './replay-check.ts';
import { readJson } from './runlog.ts';
import { injectionNote, loadCases, type CaseResult } from './scoring.ts';
import { c, duration, usd } from './term.ts';

const RECORDED = join(ROOT, 'examples', 'recorded-eval');
const RESULTS = join(RECORDED, 'results-2026-10-19.json');

interface RecordedEval {
  finished_at: string;
  runtime: string;
  duration_ms: number;
  cost_usd: number;
  results: CaseResult[];
}

const rule = (): string => c.dim('-'.repeat(100));
const percent = (value: number | undefined): string => (value === undefined ? '-' : `${Math.round(value * 100)}%`);
const sum = (values: (number | undefined)[]): number => values.reduce<number>((total, value) => total + (value ?? 0), 0);

const header = (recorded: RecordedEval, briefs: number): void => {
  const rows: [string, string][] = [
    ['Briefs', `${briefs} synthetic briefs from eval/cases.json, each on its pinned run date`],
    ['Recording', `examples/recorded-eval/, the eval that finished ${recorded.finished_at.slice(0, 10)} (runtime: ${recorded.runtime})`],
    ['Replay', "the agents' recorded tool calls run through the real tool code; the recorded kickoff note,"],
    ['', 'checker and re-check answers stand in for the model'],
    ['Offline', 'no API key, no Claude CLI, no network, nothing sent to Asana or Slack'],
  ];
  console.log('');
  console.log(c.bold('CAMPAIGN BRIEF AGENT   demo: offline replay of the recorded eval'));
  console.log(rule());
  for (const [key, value] of rows) console.log(`  ${c.dim(key.padEnd(11))}${value}`);
  console.log('');
};

const progressLine = (outcome: ReplayOutcome): string => {
  const name = outcome.name.padEnd(16);
  if (outcome.error) return `  ${c.red('✗')} ${name} ${c.red(`failed: ${outcome.error}`)}`;
  const score = outcome.replayed;
  const rubric = score ? `rubric ${score.passed}/${score.total}` : '';
  const where = outcome.runDir ? c.dim(relative(ROOT, outcome.runDir)) : '';
  if (outcome.divergences.length) return `  ${c.red('✗')} ${name} ${c.red(`differs from the recording in ${outcome.divergences.length} place(s)`)}  ${rubric}  ${where}`;
  return `  ${c.green('✓')} ${name} ${`${outcome.events} of ${outcome.events} recorded events reproduced`.padEnd(40)} ${rubric.padEnd(11)} ${where}`;
};

// Column widths of the results table: brief, rubric, blocking, coverage, tasks, questions, injection, time, calls.
const WIDTHS = [16, 6, 8, 8, 5, 9, 27, 7, 5];
const row = (cells: string[], paint: (cell: string, index: number) => string = (cell) => cell): string => {
  const fitted = cells.map((cell, index) => {
    const width = WIDTHS[index];
    return width === undefined ? cell : cell.slice(0, width).padEnd(width);
  });
  return `  ${fitted.map(paint).join(' ')}`;
};

const resultsTable = (outcomes: ReplayOutcome[]): void => {
  console.log('');
  console.log(c.bold('RESULTS'));
  console.log(c.dim(row(['brief', 'rubric', 'blocking', 'coverage', 'tasks', 'questions', 'injection', 'time', 'calls', 'cost'])));
  for (const outcome of outcomes) {
    const score = outcome.replayed;
    if (!score) {
      console.log(`  ${outcome.name.padEnd(16)} ${c.red('not replayed')}`);
      continue;
    }
    const cells = [
      outcome.name,
      `${score.passed}/${score.total}`,
      `${outcome.firstBlocking ?? '-'} -> ${score.blocking ?? '-'}`,
      percent(score.coverage),
      String(score.tasks ?? ''),
      String(score.questions ?? ''),
      injectionNote(score),
      duration(outcome.recorded.duration_ms ?? 0),
      String(score.model_calls ?? ''),
      usd(score.cost_usd),
    ];
    const clean = score.passed === score.total;
    console.log(row(cells, (cell, index) => (index === 1 ? (clean ? c.green(cell) : c.red(cell)) : cell)));
    for (const check of score.rubric.filter((entry) => !entry.pass)) console.log(`      ${c.red('✗')} ${check.label}: ${check.detail}`);
  }
  console.log(c.dim('  rubric: scored in code during this replay. blocking: high or medium checker findings at the first'));
  console.log(c.dim('  check -> after the one revision. coverage: brief requirements the final check marked covered.'));
  console.log(c.dim('  time, calls, cost: the recorded 19 Oct 2026 run (cost is API-equivalent, as reported by Claude Code).'));
};

const totals = (recorded: RecordedEval, outcomes: ReplayOutcome[], replayMs: number): void => {
  const scores = outcomes.flatMap((outcome) => (outcome.replayed ? [outcome.replayed] : []));
  const passed = sum(scores.map((score) => score.passed));
  const total = sum(scores.map((score) => score.total));
  const clean = scores.filter((score) => score.passed === score.total).length;
  const rate = total ? Math.round((passed / total) * 100) : 0;
  const injected = scores.filter((score) => score.rubric.some((check) => check.id === 'injection_flagged'));
  const caught = injected.filter((score) => score.rubric.filter((check) => check.id.startsWith('injection_')).every((check) => check.pass));
  console.log('');
  console.log(`  ${c.bold(`Rubric pass rate: ${rate}% (${passed} of ${total} checks). Briefs fully passing: ${clean} of ${outcomes.length}.`)}`);
  console.log(`  Blocking checker findings: ${sum(outcomes.map((outcome) => outcome.firstBlocking))} at the first check, ${sum(scores.map((score) => score.blocking))} after one revision.`);
  console.log(`  Prompt injection: flagged, and not acted on, in ${caught.length} of ${injected.length} brief(s) that carry one.`);
  console.log(
    `  Recorded: ${outcomes.length} briefs in ${duration(recorded.duration_ms)} of wall clock, ${sum(scores.map((score) => score.model_calls))} model calls, API-equivalent ${usd(recorded.cost_usd)}.`,
  );
  const toolCalls = sum(outcomes.map((outcome) => outcome.toolCalls));
  const pushedBack = sum(outcomes.map((outcome) => outcome.pushedBack));
  console.log(`  This replay: ${(replayMs / 1000).toFixed(1)}s on this machine, no model calls, no network.`);
  console.log(`  ${toolCalls} recorded tool calls ran through the real tools; the tools rejected ${pushedBack} of them in full or in part.`);
};

const replayCheck = (outcomes: ReplayOutcome[]): boolean => {
  const matching = outcomes.filter((outcome) => !outcome.error && outcome.divergences.length === 0);
  const events = sum(matching.map((outcome) => outcome.events));
  console.log('');
  console.log(c.bold('REPLAY CHECK'));
  if (matching.length === outcomes.length) {
    console.log(`  ${c.green('✓')} ${matching.length} of ${outcomes.length} briefs match the recording: ${events} of ${events} events, every run summary and every eval score.`);
  } else {
    console.log(`  ${c.red('✗')} ${matching.length} of ${outcomes.length} briefs match the recording.`);
    for (const outcome of outcomes.filter((item) => !matching.includes(item))) {
      console.log(`    ${c.red(outcome.name)}: ${outcome.error ?? `${outcome.divergences.length} difference(s)`}`);
      for (const divergence of outcome.divergences.slice(0, 8)) console.log(`      ${divergence}`);
    }
  }
  console.log('    Compared: every tool result, state snapshot, rubric check, step summary, run total, and every prompt the log records.');
  console.log('    Not compared: timestamps, durations, run ids, run labels and the runtime. Cost totals to 9 decimals.');
  console.log(`    Replay logs: runs/<run-id>/ for each brief (gitignored), same format as a live run.`);
  return matching.length === outcomes.length;
};

const main = async (): Promise<void> => {
  const recorded = readJson<RecordedEval>(RESULTS);
  const cases = loadCases();
  header(recorded, cases.length);
  const started = Date.now();
  const outcomes: ReplayOutcome[] = [];
  for (const item of cases) {
    const entry = recorded.results.find((result) => result.name === item.name);
    const outcome: ReplayOutcome = entry?.run_id
      ? await replayCase(item, entry, join(RECORDED, entry.run_id))
      : {
          name: item.name,
          recorded: { name: item.name, rubric: [], passed: 0, total: 0, untrusted: [], guard_hits: [] },
          events: 0,
          toolCalls: 0,
          pushedBack: 0,
          divergences: [],
          error: 'no recorded run for this case',
        };
    outcomes.push(outcome);
    console.log(progressLine(outcome));
  }
  const replayMs = Date.now() - started;
  resultsTable(outcomes);
  totals(recorded, outcomes, replayMs);
  if (!replayCheck(outcomes)) process.exitCode = 1;
  console.log('');
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
