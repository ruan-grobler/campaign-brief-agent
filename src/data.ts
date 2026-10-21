import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config.ts';
import type { Team } from './types.ts';

export interface TeamInfo {
  team: Team;
  remit: string;
  lead_role: string;
  asana_project: string;
  asana_project_gid: string;
  slack_channel: string;
  capacity_note: string;
}

export interface Playbook {
  owner_team: Team;
  summary: string;
  lead_time: string;
  steps: string[];
  acceptance_criteria: string[];
  needs: string[];
}

export interface AgencyData {
  teams: TeamInfo[];
  launchChannelRule: string;
  closedDays: Map<string, string>;
  playbooks: Record<string, Playbook>;
}

interface TeamsFile {
  teams: TeamInfo[];
  launch_channel_rule: string;
  agency_closed_days: { date: string; name: string }[];
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(PATHS.data, file), 'utf8')) as T;

export const loadAgencyData = (): AgencyData => {
  const teams = readJson<TeamsFile>('teams.json');
  const { playbooks } = readJson<{ playbooks: Record<string, Playbook> }>('playbooks.json');
  return {
    teams: teams.teams,
    launchChannelRule: teams.launch_channel_rule,
    closedDays: new Map(teams.agency_closed_days.map((day) => [day.date, day.name])),
    playbooks,
  };
};
