// The dry-run "send": builds the exact Asana and Slack request bodies and writes them to disk instead of
// calling either API. No credentials are read and nothing leaves the machine.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Decision } from './approval.ts';
import { PATHS } from './config.ts';
import type { Critique } from './critique.ts';
import type { AgencyData } from './data.ts';
import { prettyDate } from './dates.ts';
import type { RubricCheck } from './rubric.ts';
import { writeJson } from './runlog.ts';
import { TEAMS, type PlanState, type PlanTask } from './types.ts';

export interface AsanaRequest {
  local_id: string;
  method: 'POST';
  url: 'https://app.asana.com/api/1.0/tasks';
  body: { data: { name: string; notes: string; due_on: string; projects: string[] } };
  add_dependencies: string[];
}

export interface SlackRequest {
  method: 'POST';
  url: 'https://slack.com/api/chat.postMessage';
  body: { channel: string; text: string; blocks: Record<string, unknown>[] };
}

export interface OutboxPayloads {
  dry_run: true;
  asana: AsanaRequest[];
  slack: SlackRequest;
  markdown: string;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export const buildPayloads = (args: {
  runId: string;
  title: string;
  state: PlanState;
  tasks: PlanTask[];
  decision: Decision;
  data: AgencyData;
  critique?: Critique;
  rubric: RubricCheck[];
  runtimeLabel: string;
}): OutboxPayloads => {
  const { runId, title, state, tasks, decision, data, critique, rubric } = args;
  const sentIds = new Set(tasks.map((task) => task.id));
  const teams = new Map(data.teams.map((team) => [team.team, team]));
  const flags = new Map(state.flags.map((flag) => [flag.id, flag]));
  const answersFor = (task: PlanTask): Decision['answers'] => decision.answers.filter((answer) => flags.get(answer.id)?.task_ids.includes(task.id));

  const notes = (task: PlanTask): string =>
    [
      'Acceptance criteria:',
      ...task.acceptance_criteria.map((criterion) => `[ ] ${criterion}`),
      '',
      `Timing: ${task.timing.replace('_', ' ')}. Brief lines: ${task.brief_refs.join(', ')}.`,
      `Confidence: ${task.confidence.toFixed(2)}${task.assumption ? `. Assumption: ${task.assumption}` : ''}`,
      ...answersFor(task).map((answer) => `Approver decision (${answer.id}): ${answer.answer}`),
      decision.edited_tasks.includes(task.id) ? 'Edited by the approver before sending.' : '',
      '',
      `Drafted by campaign-brief-agent ${runId}, approved by ${decision.approver}.`,
    ]
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n');

  const asana: AsanaRequest[] = tasks.map((task) => ({
    local_id: task.id,
    method: 'POST',
    url: 'https://app.asana.com/api/1.0/tasks',
    body: { data: { name: `${task.id} ${task.title}`, notes: notes(task), due_on: task.due_date, projects: [teams.get(task.team)?.asana_project_gid ?? 'DRYRUN-PRJ'] } },
    add_dependencies: task.depends_on.filter((dep) => sentIds.has(dep)),
  }));

  const decisions = decision.answers.map((answer) => `• *${answer.id}* ${answer.question}\n   → ${answer.answer}`).join('\n');
  const open = decision.open_questions
    .map((id) => flags.get(id))
    .filter((flag) => flag !== undefined)
    .map((flag) => `• *${flag.id}* ${flag.question}`)
    .join('\n');
  const slack: SlackRequest = {
    method: 'POST',
    url: 'https://slack.com/api/chat.postMessage',
    body: {
      channel: state.slack?.channel ?? state.facts?.slack_channel ?? '#launch',
      text: `${title}: launch plan approved (${tasks.length} tasks)`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
        { type: 'section', text: { type: 'mrkdwn', text: state.slack?.text ?? '' } },
        ...(decisions ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Decisions from the approver*\n${decisions}` } }] : []),
        ...(open ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Still open*\n${open}` } }] : []),
        { type: 'divider' },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `${tasks.length} Asana tasks drafted by campaign-brief-agent · ${runId} · approved by ${decision.approver}` }],
        },
      ],
    },
  };

  const md: string[] = [
    `# ${title}: approved plan (dry run)`,
    '',
    `Run \`${runId}\`, approved by ${decision.approver} at ${decision.decided_at}. Runtime: ${args.runtimeLabel}.`,
    'Nothing was sent. The Asana and Slack request bodies are in this folder.',
    '',
    `## Tasks (${tasks.length})`,
  ];
  for (const team of TEAMS) {
    const teamTasks = tasks.filter((task) => task.team === team).sort((a, b) => a.due_date.localeCompare(b.due_date));
    if (!teamTasks.length) continue;
    md.push('', `### ${team}`, '', '| ID | Due | Task | Confidence | Depends on | Brief |', '|---|---|---|---|---|---|');
    for (const task of teamTasks) {
      md.push(`| ${task.id} | ${prettyDate(task.due_date)} | ${cell(task.title)} | ${task.confidence.toFixed(2)} | ${task.depends_on.join(', ') || '-'} | ${task.brief_refs.join(', ')} |`);
    }
    for (const task of teamTasks) {
      md.push('', `**${task.id}** ${cell(task.title)}`, ...task.acceptance_criteria.map((criterion) => `- [ ] ${criterion}`));
      if (task.assumption) md.push(`- Assumption: ${task.assumption}`);
    }
  }
  md.push('', '## Decisions and open questions', '');
  for (const flag of state.flags) {
    const answer = decision.answers.find((item) => item.id === flag.id);
    md.push(`- **${flag.id}** (${flag.raised_by}) ${flag.question} ${answer ? `Answer: ${answer.answer}` : '(still open)'}`);
  }
  if (!state.flags.length) md.push('- None.');
  if (state.untrusted.length) md.push('', '## Untrusted instructions blocked', '', ...state.untrusted.map((flag) => `- ${flag.brief_ref}: "${flag.quote}" (${flag.why})`));
  if (decision.rejected_tasks.length) md.push('', '## Rejected at approval', '', ...decision.rejected_tasks.map((id) => `- ${id}`));
  if (decision.accepted_risks.length) md.push('', '## Risks the approver accepted', '', ...decision.accepted_risks.map((risk) => `- ${risk}`));
  md.push('', '## Rubric', '', ...rubric.map((check) => `- ${check.pass ? 'PASS' : 'FAIL'} ${check.label}: ${check.detail}`));
  if (critique) {
    md.push('', '## Checker coverage (final pass)', '', critique.summary, '', '| Line | Requirement | Status | Tasks |', '|---|---|---|---|');
    for (const req of critique.requirements) md.push(`| ${req.ref} | ${cell(req.requirement)} | ${req.status} | ${req.task_ids.join(', ') || '-'} |`);
  }
  md.push('', '## Slack message', '', `Channel: ${slack.body.channel}`, '', '```', state.slack?.text ?? '', '```', '');

  return { dry_run: true, asana, slack, markdown: md.join('\n') };
};

export const writeOutbox = (runId: string, payloads: OutboxPayloads): { dir: string; files: { asana: string; slack: string; summary: string } } => {
  const dir = join(PATHS.outbox, runId);
  mkdirSync(dir, { recursive: true });
  const files = { asana: join(dir, 'asana-tasks.json'), slack: join(dir, 'slack-message.json'), summary: join(dir, 'summary.md') };
  writeJson(files.asana, { dry_run: true, note: 'Nothing was sent. Each body is ready for POST /tasks; dependencies follow via POST /tasks/{task_gid}/addDependencies.', requests: payloads.asana });
  writeJson(files.slack, { dry_run: true, note: 'Nothing was sent. Body for POST chat.postMessage.', request: payloads.slack });
  writeFileSync(files.summary, payloads.markdown);
  return { dir, files };
};
