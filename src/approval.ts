// The human approval gate, front-end neutral. Human by exception: confident tasks arrive pre-approved,
// everything else waits for a person, and silence is always a no.
import { userInfo } from 'node:os';
import { POLICY } from './config.ts';
import { blockingFindings, type Critique, type Finding } from './critique.ts';
import type { AgencyData } from './data.ts';
import type { ScanHit } from './injection.ts';
import { contextFor, lintTask } from './lint.ts';
import type { RubricCheck } from './rubric.ts';
import type { CampaignFacts, HumanFlag, Milestone, PlanState, PlanTask, SlackSummary, UntrustedFlag } from './types.ts';

export interface ReviewPacket {
  run_id: string;
  title: string;
  facts?: CampaignFacts;
  tasks: PlanTask[];
  milestones: Milestone[];
  slack?: SlackSummary;
  rubric: RubricCheck[];
  critique?: Critique;
  policy: { human_review_below: number };
  exceptions: {
    low_confidence: string[];
    questions: HumanFlag[];
    untrusted: UntrustedFlag[];
    missed_by_agents: ScanHit[]; // input-guard hits that no agent flagged
    findings: Finding[];
    rubric_failures: RubricCheck[];
    rule_errors: string[];
    guardrails: string[];
  };
}

export interface TaskDecision {
  id: string;
  action: 'approve' | 'reject' | 'edit';
  changes?: { title?: string; due_date?: string; acceptance_criteria?: string[] };
}

export interface DecisionInput {
  send: boolean;
  tasks: TaskDecision[];
  answers: { id: string; answer: string }[];
  accept_risks: boolean;
  reason?: string;
}

export interface Decision {
  approved: boolean;
  approver: string;
  decided_at: string;
  reason: string;
  approved_tasks: string[];
  rejected_tasks: string[];
  edited_tasks: string[];
  answers: { id: string; question: string; answer: string }[];
  open_questions: string[];
  accepted_risks: string[];
}

export const buildPacket = (args: {
  runId: string;
  title: string;
  state: PlanState;
  critique?: Critique;
  rubric: RubricCheck[];
  guardHits: ScanHit[];
  ruleErrors: string[];
  guardrails: string[];
}): ReviewPacket => {
  const { state } = args;
  const flaggedLines = new Set(state.untrusted.map((flag) => flag.brief_ref));
  return {
    run_id: args.runId,
    title: args.title,
    facts: state.facts,
    tasks: state.tasks,
    milestones: state.milestones,
    slack: state.slack,
    rubric: args.rubric,
    critique: args.critique,
    policy: { human_review_below: POLICY.humanReviewBelow },
    exceptions: {
      low_confidence: state.tasks.filter((task) => task.confidence < POLICY.humanReviewBelow).map((task) => task.id),
      questions: state.flags,
      untrusted: state.untrusted,
      missed_by_agents: args.guardHits.filter((hit) => !flaggedLines.has(`L${hit.line}`)),
      findings: args.critique ? blockingFindings(args.critique) : [],
      rubric_failures: args.rubric.filter((check) => !check.pass),
      rule_errors: args.ruleErrors,
      guardrails: args.guardrails,
    },
  };
};

// Everything here needs an explicit yes before anything is sent.
export const openRisks = (packet: ReviewPacket): string[] => [
  ...packet.exceptions.findings.map((finding) => `${finding.id} [${finding.severity}] ${finding.detail}`),
  ...packet.exceptions.rubric_failures.map((check) => `Rubric: ${check.label}. ${check.detail}`),
  ...packet.exceptions.rule_errors.map((message) => `Rule check: ${message}`),
  ...packet.exceptions.missed_by_agents.map((hit) => `Input guard: L${hit.line} ${hit.why}, and no agent flagged it: "${hit.text}"`),
  ...packet.exceptions.guardrails,
];

const editable = (changes: TaskDecision['changes']): Partial<PlanTask> => ({
  ...(changes?.title?.trim() ? { title: changes.title.trim() } : {}),
  ...(changes?.due_date ? { due_date: changes.due_date } : {}),
  ...(changes?.acceptance_criteria ? { acceptance_criteria: changes.acceptance_criteria.map((item) => item.trim()).filter(Boolean) } : {}),
});

// Applies the human's call. A low-confidence task is only sent if the human approved it; edits must pass the rule checks.
export const applyDecision = (
  packet: ReviewPacket,
  state: PlanState,
  input: DecisionInput,
  data: AgencyData,
): { decision: Decision; tasks: PlanTask[]; errors: string[] } => {
  const choices = new Map(input.tasks.map((choice) => [choice.id, choice]));
  const kept: PlanTask[] = [];
  const rejected: string[] = [];
  const edited: string[] = [];
  for (const task of state.tasks) {
    const choice = choices.get(task.id);
    const action = choice?.action ?? (task.confidence < POLICY.humanReviewBelow ? 'reject' : 'approve');
    if (action === 'reject') rejected.push(task.id);
    else if (action === 'edit') {
      kept.push({ ...task, ...editable(choice?.changes) });
      edited.push(task.id);
    } else kept.push(task);
  }

  const known = new Map(kept.map((task) => [task.id, task]));
  const ctx = { ...contextFor(state, data.closedDays, known, true), team: undefined };
  const errors = edited.flatMap((id) => {
    const task = known.get(id);
    return task ? lintTask(task, ctx).filter((issue) => issue.level === 'error' && issue.code !== 'unknown_dependency').map((issue) => issue.message) : [];
  });

  const risks = openRisks(packet);
  const answers = input.answers
    .filter((answer) => answer.answer.trim())
    .map((answer) => ({ id: answer.id, question: state.flags.find((flag) => flag.id === answer.id)?.question ?? '', answer: answer.answer.trim() }));
  let approved = input.send;
  let reason = input.reason ?? (input.send ? 'Approved for a dry-run send.' : 'The approver declined the send.');
  if (input.send && risks.length && !input.accept_risks) {
    approved = false;
    reason = 'The approver did not accept the open risks.';
  }
  if (errors.length) {
    approved = false;
    reason = `Edits failed the rule checks: ${errors.join(' ')}`;
  }
  if (approved && kept.length === 0) {
    approved = false;
    reason = 'Every task was rejected, so there is nothing to send.';
  }

  const decision: Decision = {
    approved,
    approver: userInfo().username,
    decided_at: new Date().toISOString(),
    reason,
    approved_tasks: kept.map((task) => task.id),
    rejected_tasks: rejected,
    edited_tasks: edited,
    answers,
    open_questions: state.flags.filter((flag) => !answers.some((answer) => answer.id === flag.id)).map((flag) => flag.id),
    accepted_risks: input.accept_risks ? risks : [],
  };
  // A kept task that depended on a rejected one keeps its place but loses that dependency.
  const tasks = kept.map((task) => ({ ...task, depends_on: task.depends_on.filter((dep) => known.has(dep)) }));
  return { decision, tasks, errors };
};
