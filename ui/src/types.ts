// The JSON the control room receives. Mirrors the server's event and domain types at the API boundary.
export type Team = 'Media' | 'PR' | 'Creative' | 'Organic' | 'Data';
export const TEAMS: Team[] = ['Media', 'PR', 'Creative', 'Organic', 'Data'];
export const TEAM_PREFIX: Record<Team, string> = { Media: 'MED', PR: 'PR', Creative: 'CRE', Organic: 'ORG', Data: 'DAT' };

export type Timing = 'before_launch' | 'launch_day' | 'after_launch';

export interface PlanTask {
  id: string;
  title: string;
  team: Team;
  due_date: string;
  timing: Timing;
  acceptance_criteria: string[];
  depends_on: string[];
  brief_refs: string[];
  confidence: number;
  assumption?: string;
}

export interface Milestone {
  id: string;
  team: Team;
  title: string;
  due_by: string;
  for_teams: Team[];
}

export interface TeamAssignment {
  team: Team;
  needed: boolean;
  scope: string;
  brief_refs: string[];
  depends_on_milestones: string[];
}

export interface CampaignFacts {
  client: string;
  campaign: string;
  launch_date: string;
  kickoff_date?: string;
  markets: string[];
  slack_channel: string;
}

export interface HumanFlag {
  id: string;
  question: string;
  why: string;
  task_ids: string[];
  raised_by: string;
}

export interface UntrustedFlag {
  id: string;
  quote: string;
  brief_ref: string;
  why: string;
  raised_by: string;
}

export interface SlackSummary {
  channel: string;
  text: string;
}

export interface StateView {
  scope: 'orchestrator' | 'team' | 'revise';
  team?: Team;
  facts?: CampaignFacts;
  milestones: Milestone[];
  assignments: TeamAssignment[];
  tasks: PlanTask[];
  flags: HumanFlag[];
  untrusted: UntrustedFlag[];
  slack?: SlackSummary;
  steps_used: number;
  max_steps: number;
  finished: boolean;
}

export interface ScanHit {
  line: number;
  text: string;
  why: string;
}

export interface RubricCheck {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface Finding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  category: string;
  detail: string;
  task_ids: string[];
  brief_refs: string[];
  fix: string;
}

export interface Critique {
  verdict: 'approve' | 'revise';
  summary: string;
  requirements: { ref: string; requirement: string; status: 'covered' | 'partial' | 'missing'; task_ids: string[] }[];
  findings: Finding[];
}

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
    missed_by_agents: ScanHit[];
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

export interface AsanaRequest {
  local_id: string;
  method: 'POST';
  url: string;
  body: { data: { name: string; notes: string; due_on: string; projects: string[] } };
  add_dependencies: string[];
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: { type: string; text: string }[];
}

export interface SlackRequest {
  method: 'POST';
  url: string;
  body: { channel: string; text: string; blocks: SlackBlock[] };
}

export interface OutboxPayloads {
  dry_run: true;
  asana: AsanaRequest[];
  slack: SlackRequest;
  markdown: string;
}

export type StepKind = 'guard' | 'agent' | 'merge' | 'summary' | 'check' | 'approval' | 'send';
export type StepStatus = 'done' | 'stopped' | 'failed';

export interface StepInfo {
  id: string;
  kind: StepKind;
  label: string;
  group?: string;
  scope?: string;
  team?: Team;
  budget?: number;
  input?: { system?: string; prompt?: string; [key: string]: unknown };
}

export interface Totals {
  duration_ms: number;
  model_calls: number;
  tool_calls: number;
  cost_usd: number;
  steps: number;
}

type EventBody =
  | {
      type: 'run_started';
      run_id: string;
      title: string;
      brief_path: string;
      brief_lines: string[];
      today: string;
      runtime: { id: string; label: string; why: string };
      model: string;
      limits: Record<string, number>;
      policy: Record<string, number>;
      label?: string;
    }
  | { type: 'step_started'; step: StepInfo }
  | { type: 'step_finished'; step_id: string; status: StepStatus; duration_ms: number; model_calls: number; tool_calls: number; cost_usd?: number; summary: string; output?: unknown }
  | { type: 'tool_call'; step_id: string; call_id: string; name: string; input: unknown }
  | { type: 'tool_result'; step_id: string; call_id: string; name: string; ok: boolean; text: string }
  | { type: 'agent_text'; step_id: string; text: string }
  | { type: 'state_snapshot'; step_id: string; state: StateView }
  | { type: 'guard_result'; step_id: string; hits: ScanHit[] }
  | { type: 'check_result'; step_id: string; pass: number; rubric: RubricCheck[]; critique?: Critique; error?: string }
  | { type: 'awaiting_approval'; packet: ReviewPacket }
  | { type: 'decision'; decision: Decision }
  | { type: 'outbox_written'; dir: string; files: Record<string, string>; payloads: OutboxPayloads }
  | { type: 'run_finished'; status: string; totals: Totals }
  | { type: 'run_failed'; error: string; totals: Totals };

export type RunEvent = EventBody & { ts: string; seq: number };
export type EventOf<T extends RunEvent['type']> = Extract<RunEvent, { type: T }>;

export interface RunSummary {
  run_id: string;
  title: string;
  label?: string;
  started_at: string;
  status: string;
  tasks?: number;
  totals?: { model_calls: number; duration_ms: number; cost_usd: number };
}

export interface BriefOption {
  path: string;
  title: string;
  lines: number;
  group: string;
}

export interface Meta {
  runtime: { id: string; label: string; why: string };
  model: string;
  today: string;
  briefs: BriefOption[];
}
