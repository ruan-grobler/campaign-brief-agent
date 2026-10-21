export const TEAMS = ['Media', 'PR', 'Creative', 'Organic', 'Data'] as const;
export type Team = (typeof TEAMS)[number];

export const TEAM_PREFIX: Record<Team, string> = {
  Media: 'MED',
  PR: 'PR',
  Creative: 'CRE',
  Organic: 'ORG',
  Data: 'DAT',
};

export const TASK_ID = /^(MED|PR|CRE|ORG|DAT)-\d{1,2}$/;

export const teamOfId = (id: string): Team | undefined => TEAMS.find((team) => id.startsWith(`${TEAM_PREFIX[team]}-`));

// Which agent a tool server is serving: the orchestrator, one team specialist, or the reviser of the merged plan.
export type Scope = 'orchestrator' | 'team' | 'revise';

export const TIMINGS = ['before_launch', 'launch_day', 'after_launch'] as const;
export type Timing = (typeof TIMINGS)[number];

export interface PlanTask {
  id: string;
  title: string;
  team: Team;
  due_date: string;
  timing: Timing;
  acceptance_criteria: string[];
  depends_on: string[];
  brief_refs: string[];
  confidence: number; // 0 to 1
  assumption?: string;
}

// A cross-team handoff the orchestrator promises up front, so specialists working in parallel can depend on each other.
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

// Text in the brief that tried to instruct the agent. Recorded, never acted on.
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

// What one agent builds through its tools. Each agent has its own state file in the run folder.
export interface PlanState {
  run_id: string;
  today: string;
  brief_line_count: number;
  scope: Scope;
  team?: Team;
  max_steps: number;
  steps_used: number;
  finished: boolean;
  finish_note: string;
  facts?: CampaignFacts;
  milestones: Milestone[];
  assignments: TeamAssignment[];
  tasks: PlanTask[];
  flags: HumanFlag[];
  untrusted: UntrustedFlag[];
  removed: { id: string; reason: string }[];
  slack?: SlackSummary;
  next_flag: number;
}
