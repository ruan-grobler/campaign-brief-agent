// Terminal front end: renders a run's events as they happen and runs the approval gate on stdin.
import { createInterface } from 'node:readline';
import { openRisks, type DecisionInput, type ReviewPacket } from './approval.ts';
import { blockingFindings, type Critique } from './critique.ts';
import { prettyDate, weekday } from './dates.ts';
import type { RunEvent } from './events.ts';
import type { Gate } from './pipeline.ts';
import type { RubricCheck } from './rubric.ts';
import { TEAMS, TEAM_PREFIX, type PlanTask, type SlackSummary, type Team } from './types.ts';

const colour = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint =
  (code: string): ((text: string) => string) =>
  (text) =>
    colour ? `\u001b[${code}m${text}\u001b[0m` : text;

export const c = { bold: paint('1'), dim: paint('2'), red: paint('31'), green: paint('32'), yellow: paint('33'), magenta: paint('35'), cyan: paint('36') };

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

export const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

export const usd = (amount: number | undefined): string => (amount === undefined ? 'n/a' : `$${amount.toFixed(2)}`);

const rule = (): string => c.dim('─'.repeat(78));
const section = (title: string, detail = ''): void => {
  console.log('');
  console.log(`${c.bold(c.magenta(`▸ ${title}`))}${detail ? `  ${c.dim(detail)}` : ''}`);
};

const describeInput = (name: string, input: unknown): string => {
  const value = (input ?? {}) as Record<string, unknown>;
  const list = (key: string): unknown[] => (Array.isArray(value[key]) ? (value[key] as unknown[]) : []);
  const ids = (key: string): string => list(key).map((item) => String((item as { id?: unknown; team?: unknown }).id ?? (item as { team?: unknown }).team ?? '?')).join(', ');
  switch (name) {
    case 'get_playbooks':
      return list('keys').join(', ');
    case 'calc_dates':
      return `${list('items').length} date(s)`;
    case 'set_campaign_facts':
      return `launch ${String(value.launch_date ?? '?')}, ${String(value.slack_channel ?? '')}`;
    case 'define_milestones':
      return ids('milestones');
    case 'assign_teams':
      return ids('assignments');
    case 'add_tasks':
      return ids('tasks');
    case 'update_tasks':
      return ids('updates');
    case 'remove_task':
      return String(value.id ?? '?');
    case 'flag_for_human':
      return oneLine(String(value.question ?? ''));
    case 'flag_untrusted_instruction':
      return `${String(value.brief_ref ?? '')} ${oneLine(String(value.quote ?? ''))}`;
    case 'set_slack_summary':
      return `${String(value.channel ?? '')} (${String(value.text ?? '').length} chars)`;
    default:
      return name.startsWith('finish_') ? oneLine(String(value.note ?? '')) : '';
  }
};

const severity = (level: string): string => (level === 'high' ? c.red('high  ') : level === 'medium' ? c.yellow('medium') : c.dim('low   '));

const printRubric = (rubric: RubricCheck[]): void => {
  for (const check of rubric) console.log(`  ${check.pass ? c.green('✓') : c.red('✗')} ${check.label}${c.dim(`  ${truncate(check.detail, 50)}`)}`);
};

const printCritique = (critique: Critique): void => {
  const count = (status: string): number => critique.requirements.filter((item) => item.status === status).length;
  console.log(`  Requirements in the brief: ${critique.requirements.length}   ${c.green(`${count('covered')} covered`)}   ${c.yellow(`${count('partial')} partial`)}   ${c.red(`${count('missing')} missing`)}`);
  for (const finding of critique.findings) {
    const [first = '', second] = wrap(oneLine(finding.detail), 60);
    console.log(`  ${finding.severity === 'low' ? c.dim('·') : c.red('✗')} ${finding.id.padEnd(3)} ${severity(finding.severity)} ${first}`);
    if (second) console.log(`  ${' '.repeat(13)}${truncate(second, 60)}`);
  }
  const blocking = blockingFindings(critique).length;
  console.log(`  Verdict: ${blocking ? c.yellow(`revise (${blocking} blocking)`) : c.green('approve (nothing blocking)')}`);
};

// Live rendering. Specialists run in parallel, so their lines carry a team tag.
const tags = new Map<string, string>();
const counters = new Map<string, number>();
let specialistsShown = false;

export const renderEvent = (event: RunEvent): void => {
  switch (event.type) {
    case 'run_started': {
      console.log('');
      console.log(c.bold(`CAMPAIGN BRIEF AGENT   ${c.dim(event.run_id)}`));
      console.log(rule());
      const rows: [string, string][] = [
        ['Brief', `${event.title} (${event.brief_lines.length} lines)`],
        ['Run date', `${event.today} (${weekday(event.today)})`],
        ['Runtime', event.runtime.label],
        ['Why', event.runtime.why],
        ['Agents', 'orchestrator, then 5 specialists in parallel, adversarial checker, reviser'],
        ['Guardrails', `tool budgets ${event.limits.orchestratorSteps}/${event.limits.specialistSteps} per specialist/${event.limits.reviseSteps}, turn cap, ${(event.limits.agentTimeoutMs ?? 0) / 60_000} min timeout, 1 revision`],
        ['Human', `tasks under ${event.policy.humanReviewBelow} confidence wait for you; the rest arrive pre-approved`],
      ];
      for (const [key, value] of rows) {
        const [first = '', ...rest] = wrap(value, 64);
        console.log(`  ${c.dim(key.padEnd(11))}${first}`);
        for (const line of rest) console.log(`  ${' '.repeat(11)}${line}`);
      }
      return;
    }
    case 'step_started': {
      const { step } = event;
      if (step.group === 'specialists') {
        if (!specialistsShown) section('SPECIALISTS', 'five agents in parallel, each with its own tools, state and budget');
        specialistsShown = true;
        const tag = `[${TEAM_PREFIX[step.team as Team] ?? '?'}]`.padEnd(6);
        tags.set(step.id, tag);
        console.log(`  ${c.cyan(tag)}${c.dim(`started, budget ${step.budget} calls`)}`);
        return;
      }
      const details: Record<string, string> = {
        guard: 'deterministic scan for text that tries to instruct an AI',
        agent: step.budget ? `picks its own tools, budget ${step.budget} calls` : '',
        merge: 'code, not a model',
        summary: 'one structured model call',
        check: step.label === 'Re-check' ? 'are the earlier findings fixed, and did the revision break anything?' : "separate reviewer: own prompt, no tools, never sees the agents' reasoning",
        approval: '',
        send: 'dry run: builds the API bodies, sends nothing',
      };
      if (step.kind !== 'approval') section(step.label.toUpperCase(), details[step.kind] ?? '');
      return;
    }
    case 'tool_call': {
      const count = (counters.get(event.step_id) ?? 0) + 1;
      counters.set(event.step_id, count);
      const tag = tags.get(event.step_id) ?? '';
      console.log(`  ${c.cyan(tag)}${c.dim(String(count).padStart(2))}  ${c.cyan(event.name.padEnd(18))} ${c.dim(truncate(describeInput(event.name, event.input), 50))}`);
      return;
    }
    case 'tool_result': {
      const [first = '', ...rest] = event.text.split('\n');
      const indent = ' '.repeat(6 + (tags.get(event.step_id)?.length ?? 0));
      console.log(`${indent}${event.ok ? c.green('✓') : c.red('✗')} ${truncate(first, 66)}`);
      for (const line of rest.filter((item) => /^(REJECTED|- |✖|\s*→)/.test(item)).slice(0, 3)) console.log(`${indent}  ${c.yellow(truncate(line, 64))}`);
      return;
    }
    case 'agent_text': {
      const tag = tags.get(event.step_id) ?? '';
      console.log(`  ${c.cyan(tag)}    ${c.dim(truncate(`"${oneLine(event.text)}"`, 68))}`);
      return;
    }
    case 'guard_result': {
      if (!event.hits.length) console.log(`  ${c.green('✓')} No line looks like an instruction to an AI.`);
      for (const hit of event.hits) console.log(`  ${c.yellow('!')} L${hit.line} ${hit.why}: ${c.dim(truncate(hit.text, 50))}`);
      return;
    }
    case 'check_result': {
      printRubric(event.rubric);
      if (event.critique) printCritique(event.critique);
      else console.log(`  ${c.red('✗ The checker failed:')} ${event.error ?? ''}`);
      return;
    }
    case 'step_finished': {
      if (event.step_id === 'approval') return;
      const tag = tags.get(event.step_id);
      const status = event.status === 'done' ? c.green('done') : event.status === 'stopped' ? c.yellow('stopped') : c.red('failed');
      const cost = event.cost_usd === undefined ? '' : ` · ${usd(event.cost_usd)}`;
      const calls = event.model_calls ? ` · ${event.model_calls} model calls` : '';
      console.log(`  ${tag ? c.cyan(tag) : ''}${status} ${c.dim(`· ${duration(event.duration_ms)}${calls}${cost} · ${truncate(event.summary, 60)}`)}`);
      return;
    }
    case 'outbox_written': {
      console.log(c.green(c.bold('✓ DRY RUN SENT. Nothing left this machine.')));
      for (const [kind, path] of Object.entries(event.files)) console.log(`  ${c.dim(kind.padEnd(8))}${path}`);
      return;
    }
    case 'run_finished': {
      const { totals } = event;
      console.log(rule());
      console.log(`  ${c.bold(event.status.replace(/_/g, ' '))}   ${duration(totals.duration_ms)} · ${totals.model_calls} model calls · ${totals.tool_calls} tool calls · API-equivalent ${usd(totals.cost_usd)}`);
      return;
    }
    case 'run_failed': {
      console.log(c.red(`✗ Run failed: ${event.error}`));
      return;
    }
    default:
      return;
  }
};

const printTask = (task: PlanTask): void => {
  const score = task.confidence.toFixed(2);
  const scoreText = task.confidence >= 0.8 ? c.green(score) : task.confidence >= 0.7 ? c.yellow(score) : c.red(score);
  console.log(`    ${task.id.padEnd(6)} ${prettyDate(task.due_date).padEnd(10)} ${scoreText}  ${truncate(task.title, 54)}`);
};

const printSlack = (slack: SlackSummary | undefined): void => {
  if (!slack) return;
  console.log(`  ${c.dim(`Slack preview, ${slack.channel}`)}`);
  for (const paragraph of slack.text.split('\n')) for (const line of wrap(paragraph, 70)) console.log(`  ${c.dim('│')} ${line}`);
};

const printLines = (indent: number, text: string, width = 66, maxLines = 3): void => {
  const lines = wrap(oneLine(text), width);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = truncate(`${shown[maxLines - 1] ?? ''} ${lines[maxLines] ?? ''}`, width);
  for (const line of shown) console.log(`${' '.repeat(indent)}${line}`);
};

interface Prompter {
  ask: (question: string) => Promise<string>;
  close: () => void;
}

// Reads answers one line at a time from a terminal or a pipe. End of input or Ctrl+C means "no" from then on.
const createPrompter = (): Prompter => {
  const tty = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  const queued: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  let closed = false;
  const deliver = (line: string): void => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.(line);
  };
  rl.on('line', (line) => {
    if (waiting) deliver(line.trim());
    else queued.push(line.trim());
  });
  rl.on('close', () => {
    closed = true;
    deliver('');
  });
  rl.on('SIGINT', () => rl.close());
  const ask = async (question: string): Promise<string> => {
    if (closed) process.stdout.write(question);
    else {
      rl.setPrompt(question);
      rl.prompt();
    }
    const answer = queued.shift() ?? (closed ? '' : await new Promise<string>((resolve) => (waiting = resolve)));
    if (!tty) process.stdout.write(`${answer}\n`);
    return answer;
  };
  return { ask, close: () => rl.close() };
};

const isYes = (answer: string): boolean => /^(y|yes)$/i.test(answer);

export const terminalGate: Gate = async (packet: ReviewPacket): Promise<DecisionInput> => {
  const { exceptions } = packet;
  const low = new Set(exceptions.low_confidence);
  section('APPROVAL GATE', `${packet.run_id}, human by exception`);
  console.log(`  ${packet.tasks.length} tasks: ${packet.tasks.length - low.size} pre-approved (confidence ${packet.policy.human_review_below} or more), ${low.size} need you`);
  console.log('');
  for (const team of TEAMS) {
    const tasks = packet.tasks.filter((task) => task.team === team).sort((a, b) => a.due_date.localeCompare(b.due_date));
    console.log(`  ${c.bold(team.toUpperCase())}${tasks.length ? '' : c.dim('  no tasks')}`);
    for (const task of tasks) printTask(task);
  }
  console.log('');
  printSlack(packet.slack);
  console.log('');
  console.log(`  ${c.bold('NEEDS YOUR CALL')}`);
  if (low.size) {
    console.log(`  ${c.yellow('Low-confidence tasks')} ${c.dim('(left out unless you approve them)')}`);
    for (const task of packet.tasks.filter((item) => low.has(item.id))) {
      console.log(`    ${task.id.padEnd(6)} ${task.confidence.toFixed(2)}  ${truncate(task.title, 56)}`);
      if (task.assumption) printLines(11, `assumes: ${task.assumption}`, 62);
    }
  }
  if (exceptions.questions.length) {
    console.log(`  ${c.yellow('Questions the agents parked for you')}`);
    for (const flag of exceptions.questions) {
      console.log(`    ${c.bold(flag.id.padEnd(4))} ${c.dim(`(${flag.raised_by})`)} ${truncate(oneLine(flag.question), 56)}`);
      printLines(9, `why: ${flag.why}`, 64);
    }
  }
  if (exceptions.untrusted.length) {
    console.log(`  ${c.yellow('Untrusted instructions the agents blocked')}`);
    for (const flag of exceptions.untrusted) printLines(4, `${flag.brief_ref} "${flag.quote}" (${flag.raised_by}: ${flag.why})`, 70);
  }
  const risks = openRisks(packet);
  if (risks.length) {
    console.log(`  ${c.red('Open risks')}`);
    for (const risk of risks) printLines(4, risk, 70, 2);
  }
  console.log(rule());

  const prompter = createPrompter();
  try {
    const lowIds = [...low];
    const answer = lowIds.length ? await prompter.ask('Approve which low-confidence tasks? Ids, "all", or Enter for none: ') : '';
    const wanted = /^all$/i.test(answer) ? new Set(lowIds) : new Set(answer.split(/[\s,]+/).map((id) => id.toUpperCase()));
    const tasks = packet.tasks.map((task) => ({ id: task.id, action: !low.has(task.id) || wanted.has(task.id) ? ('approve' as const) : ('reject' as const) }));
    const answers: DecisionInput['answers'] = [];
    for (const flag of exceptions.questions) {
      console.log(`  ${c.bold(flag.id)} ${oneLine(flag.question)}`);
      answers.push({ id: flag.id, answer: await prompter.ask('     Answer, or Enter to leave it open: ') });
    }
    const accept = risks.length ? isYes(await prompter.ask(`Accept the ${risks.length} open risk(s) above and go on? [y/N] `)) : true;
    if (!accept) return { send: false, tasks, answers, accept_risks: false, reason: 'The approver did not accept the open risks.' };
    const count = tasks.filter((task) => task.action === 'approve').length;
    const send = isYes(await prompter.ask(`Send ${count} tasks to Asana and post the summary to ${packet.slack?.channel ?? 'Slack'}? DRY RUN, writes files only [y/N] `));
    return { send, tasks, answers, accept_risks: accept };
  } finally {
    prompter.close();
  }
};
