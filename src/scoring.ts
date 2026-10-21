// The eval cases and the per-brief score, shared by npm run eval (live) and npm run demo (replay),
// so both score a run with exactly the same code.
import { join } from 'node:path';
import { PATHS, ROOT } from './config.ts';
import { blockingFindings } from './critique.ts';
import type { RunOptions, RunResult } from './pipeline.ts';
import type { RubricCheck } from './rubric.ts';
import { readJson } from './runlog.ts';
import type { Team } from './types.ts';

export interface EvalCase {
  name: string;
  brief: string;
  today: string;
  required_teams: Team[];
  excluded_teams?: Team[];
  expect_untrusted?: boolean;
  forbidden?: string[];
}

export interface CaseResult {
  name: string;
  run_id?: string;
  error?: string;
  rubric: RubricCheck[];
  passed: number;
  total: number;
  blocking?: number;
  coverage?: number;
  tasks?: number;
  questions?: number;
  untrusted: string[];
  guard_hits: string[];
  model_calls?: number;
  duration_ms?: number;
  cost_usd?: number;
}

export type CaseOptions = Pick<RunOptions, 'briefPath' | 'today' | 'requiredTeams' | 'excludedTeams' | 'expectUntrusted' | 'forbidden'>;

export const loadCases = (): EvalCase[] => readJson<{ cases: EvalCase[] }>(join(PATHS.eval, 'cases.json')).cases;

// What a case pins: its brief, its run date, and what the rubric expects of the plan.
export const caseOptions = (item: EvalCase): CaseOptions => ({
  briefPath: join(ROOT, item.brief),
  today: item.today,
  requiredTeams: item.required_teams,
  excludedTeams: item.excluded_teams,
  expectUntrusted: item.expect_untrusted,
  forbidden: item.forbidden?.map((pattern) => new RegExp(pattern, 'i')),
});

export const scoreCase = (item: EvalCase, result: RunResult): CaseResult => {
  const final = result.checks.at(-1)?.critique;
  const covered = final ? final.requirements.filter((req) => req.status === 'covered').length : 0;
  return {
    name: item.name,
    run_id: result.runId,
    rubric: result.rubric,
    passed: result.rubric.filter((check) => check.pass).length,
    total: result.rubric.length,
    blocking: final ? blockingFindings(final).length : undefined,
    coverage: final && final.requirements.length ? covered / final.requirements.length : undefined,
    tasks: result.state.tasks.length,
    questions: result.state.flags.length,
    untrusted: result.state.untrusted.map((flag) => `${flag.brief_ref} by ${flag.raised_by}`),
    guard_hits: result.guardHits.map((hit) => `L${hit.line}`),
    model_calls: result.totals.model_calls,
    duration_ms: result.totals.duration_ms,
    cost_usd: result.totals.cost_usd,
  };
};

// The injection column of the results table.
export const injectionNote = (item: CaseResult): string =>
  item.untrusted.length ? `flagged ${item.untrusted.join(', ')}` : item.guard_hits.length ? 'MISSED' : 'none in brief';
