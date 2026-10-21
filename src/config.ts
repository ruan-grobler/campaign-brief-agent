import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Claude Opus 5.5 with adaptive thinking. Its default effort is medium, so every call sets effort explicitly.
export const MODEL = 'claude-opus-5-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Role = 'orchestrator' | 'specialist' | 'summary' | 'checker' | 'recheck' | 'reviser';

export const EFFORT: Record<Role, Effort> = {
  orchestrator: 'medium',
  specialist: 'medium',
  summary: 'low',
  checker: 'high',
  recheck: 'medium', // a re-check verifies fixes, a narrower job than the first review
  reviser: 'medium',
};

// Guardrails. Each one stops a run on its own; none of them relies on the model behaving.
export const LIMITS = {
  orchestratorSteps: 16, // tool calls, counted by the tool server
  specialistSteps: 12, // per specialist
  reviseSteps: 14,
  maxRevisions: 1, // how many times the checker can send the plan back
  turnCapSlack: 4, // harness turn cap = step budget + this
  agentTimeoutMs: 8 * 60_000,
  checkerTimeoutMs: 5 * 60_000,
};

// Human by exception: tasks under this confidence wait for a person, everything else is pre-approved.
export const POLICY = {
  humanReviewBelow: 0.7,
  assumptionBelow: 0.8, // below this a task must say what it assumed
  minCriteria: 2,
  // Volume caps keep the plan at Asana granularity and the human queue short.
  maxTasksPerTeam: 10,
  maxMilestones: 10,
  maxQuestionsOrchestrator: 5,
  maxQuestionsSpecialist: 2,
  maxQuestionsReviser: 3,
};

export const PATHS = {
  data: join(ROOT, 'data'),
  runs: join(ROOT, 'runs'),
  outbox: join(ROOT, 'outbox'),
  agentCwd: join(ROOT, '.agent-cwd'),
  mcpServer: join(ROOT, 'src', 'mcp-server.ts'),
  ui: join(ROOT, 'ui'),
  eval: join(ROOT, 'eval'),
};
