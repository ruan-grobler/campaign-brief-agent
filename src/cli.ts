// Terminal entry point: npm start -- <brief.md> [--today YYYY-MM-DD]
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isIsoDate, localIsoDate } from './dates.ts';
import { startRun } from './pipeline.ts';
import { selectRuntime } from './runtime/select.ts';
import { c, renderEvent, terminalGate } from './term.ts';

const USAGE = 'Usage: npm start -- <brief.md> [--today YYYY-MM-DD]';

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { today: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const [briefArg] = positionals;
  if (!briefArg || positionals.length > 1) throw new Error(USAGE);
  // npm runs scripts from the package root; INIT_CWD is where the user typed the command.
  const briefPath = resolve(process.env.INIT_CWD ?? process.cwd(), briefArg);
  if (!existsSync(briefPath)) throw new Error(`Brief not found: ${briefPath}`);
  if (!readFileSync(briefPath, 'utf8').trim()) throw new Error(`The brief is empty: ${briefPath}`);
  const today = values.today ?? localIsoDate(new Date());
  if (!isIsoDate(today)) throw new Error(`--today must be a real YYYY-MM-DD date, got ${today}`);

  const run = startRun({ briefPath, today, runtime: selectRuntime(), gate: terminalGate, onEvent: renderEvent });
  const result = await run.done;
  console.log(`  ${c.dim('Run log')}  runs/${run.runId}/events.jsonl${result.outboxDir ? `   ${c.dim('Outbox')} outbox/${run.runId}/` : ''}`);
};

main().catch((error: unknown) => {
  console.error(`\n${c.red('✗')} ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
