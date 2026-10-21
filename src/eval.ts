// npm run eval [-- --concurrency 2] [-- --only orbit-injection]
// Runs each synthetic brief through the full pipeline (no human gate) and scores the plan against the rubric.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { PATHS } from './config.ts';
import type { RunEvent } from './events.ts';
import { startRun } from './pipeline.ts';
import { writeJson } from './runlog.ts';
import { selectRuntime } from './runtime/select.ts';
import { caseOptions, injectionNote, loadCases, scoreCase, type CaseResult, type EvalCase } from './scoring.ts';
import { c, duration, usd } from './term.ts';

const { values } = parseArgs({ options: { concurrency: { type: 'string', default: '2' }, only: { type: 'string' } } });
const concurrency = Math.max(1, Number(values.concurrency) || 2);
const allCases = loadCases();
const cases = values.only ? allCases.filter((item) => item.name === values.only) : allCases;
const runtime = selectRuntime();

const mapLimit = async <T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return results;
};

const progress =
  (name: string) =>
  (event: RunEvent): void => {
    if (event.type === 'step_finished') {
      const mark = event.status === 'done' ? c.green('✓') : event.status === 'failed' ? c.red('✗') : c.yellow('!');
      console.log(`  ${c.cyan(name.padEnd(16))} ${mark} ${event.step_id.padEnd(14)} ${c.dim(`${duration(event.duration_ms)} · ${event.summary.slice(0, 70)}`)}`);
    }
  };

const runCase = async (item: EvalCase): Promise<CaseResult> => {
  console.log(`${c.magenta('▸')} ${item.name}: started (${item.brief})`);
  try {
    const handle = startRun({ ...caseOptions(item), runtime, label: `eval: ${item.name}`, onEvent: progress(item.name) });
    return scoreCase(item, await handle.done);
  } catch (error) {
    return { name: item.name, error: error instanceof Error ? error.message : String(error), rubric: [], passed: 0, total: 0, untrusted: [], guard_hits: [] };
  }
};

const main = async (): Promise<void> => {
  console.log(`\n${c.bold('EVAL')}  ${cases.length} synthetic brief(s), ${concurrency} at a time, ${runtime.runtime.label}\n`);
  const started = Date.now();
  const results = await mapLimit(cases, concurrency, runCase);

  const passed = results.reduce((sum, item) => sum + item.passed, 0);
  const total = results.reduce((sum, item) => sum + item.total, 0);
  const clean = results.filter((item) => !item.error && item.passed === item.total).length;
  const rate = total ? Math.round((passed / total) * 100) : 0;

  console.log(`\n${c.bold('RESULTS')}`);
  console.log(c.dim('  brief            rubric  blocking  coverage  tasks  questions  injection                    time     calls'));
  for (const item of results) {
    if (item.error) {
      console.log(`  ${item.name.padEnd(16)} ${c.red(`failed: ${item.error.slice(0, 80)}`)}`);
      continue;
    }
    const rubric = `${item.passed}/${item.total}`.padEnd(7);
    const injection = injectionNote(item).slice(0, 28).padEnd(28);
    const cells = [
      item.name.padEnd(16),
      item.passed === item.total ? c.green(rubric) : c.red(rubric),
      String(item.blocking ?? '-').padEnd(9),
      (item.coverage === undefined ? '-' : `${Math.round(item.coverage * 100)}%`).padEnd(9),
      String(item.tasks ?? '').padEnd(6),
      String(item.questions ?? '').padEnd(10),
      injection.startsWith('MISSED') ? c.red(injection) : injection,
      duration(item.duration_ms ?? 0).padEnd(8),
      String(item.model_calls ?? ''),
    ];
    console.log(`  ${cells.join(' ')}`);
    for (const check of item.rubric.filter((entry) => !entry.pass)) console.log(`      ${c.red('✗')} ${check.label}: ${check.detail}`);
  }
  const cost = results.reduce((sum, item) => sum + (item.cost_usd ?? 0), 0);
  console.log(`\n  ${c.bold(`Rubric pass rate: ${rate}% (${passed} of ${total} checks)`)} · briefs fully passing: ${clean} of ${results.length} · ${duration(Date.now() - started)} · API-equivalent ${usd(cost)}`);

  const dir = join(PATHS.eval, 'results');
  mkdirSync(dir, { recursive: true });
  const record = { finished_at: new Date().toISOString(), runtime: runtime.runtime.id, pass_rate: rate, passed, total, briefs_passing: clean, briefs: results.length, duration_ms: Date.now() - started, cost_usd: cost, results };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeJson(join(dir, `eval-${stamp}.json`), record);
  writeJson(join(dir, 'latest.json'), record);
  console.log(`  ${c.dim('Saved')} eval/results/latest.json`);
  if (passed !== total || results.some((item) => item.error)) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
