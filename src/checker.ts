import { join } from 'node:path';
import { z } from 'zod';
import { EFFORT, LIMITS } from './config.ts';
import { CritiqueSchema, critiqueJsonSchema, type Critique } from './critique.ts';
import type { AgencyData } from './data.ts';
import { CHECKER_SYSTEM, checkerPrompt } from './prompts.ts';
import type { RubricCheck } from './rubric.ts';
import { writeJson } from './runlog.ts';
import type { Runtime } from './runtime/types.ts';
import type { PlanState } from './types.ts';

export interface CheckResult {
  pass: number;
  critique?: Critique;
  error?: string;
  modelCalls: number;
  durationMs: number;
  costUsd?: number;
}

// Adversarial verification: a separate model call with its own prompt and no tools. It gets the brief, the
// merged plan and the rubric results, never any agent's reasoning, so it cannot be talked into agreeing.
// On a re-check it also gets its own earlier findings. A failed review is reported, never treated as a pass.
export const runChecker = async (
  runtime: Runtime,
  runDir: string,
  pass: number,
  numberedBrief: string,
  state: PlanState,
  data: AgencyData,
  rubric: RubricCheck[],
  earlier?: Critique,
): Promise<CheckResult> => {
  const started = Date.now();
  try {
    const result = await runtime.structured({
      system: CHECKER_SYSTEM,
      prompt: checkerPrompt(numberedBrief, state, data, rubric, earlier?.findings),
      schema: critiqueJsonSchema(),
      effort: earlier ? EFFORT.recheck : EFFORT.checker,
      timeoutMs: LIMITS.checkerTimeoutMs,
    });
    const parsed = CritiqueSchema.safeParse(result.data);
    if (!parsed.success) throw new Error(`the review did not match the schema: ${z.prettifyError(parsed.error)}`);
    writeJson(join(runDir, `critique-${pass}.json`), parsed.data);
    return { pass, critique: parsed.data, modelCalls: result.modelCalls, durationMs: Date.now() - started, costUsd: result.costUsd };
  } catch (error) {
    return { pass, error: error instanceof Error ? error.message : String(error), modelCalls: 0, durationMs: Date.now() - started };
  }
};
