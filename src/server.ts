// Web front end: the agent control room at http://localhost:4410. Local only: it binds to 127.0.0.1,
// reads no credentials, and the only "send" is the dry-run outbox.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import type { DecisionInput, ReviewPacket } from './approval.ts';
import { MODEL, PATHS, ROOT } from './config.ts';
import { isIsoDate, localIsoDate } from './dates.ts';
import type { RunEvent } from './events.ts';
import { startRun, type Gate, type RunHandle } from './pipeline.ts';
import { briefTitle } from './prompts.ts';
import { readJson } from './runlog.ts';
import { selectRuntime } from './runtime/select.ts';

const PORT = Number(process.env.PORT) || 4410;
const HOST = '127.0.0.1';
const runtime = selectRuntime();

interface Pending {
  packet: ReviewPacket;
  validate: (input: DecisionInput) => string[];
  resolve: (input: DecisionInput) => void;
}

interface ActiveRun {
  handle: RunHandle;
  pending?: Pending;
}

const active = new Map<string, ActiveRun>();

const webGate: Gate = (packet, validate) =>
  new Promise((resolveDecision) => {
    const run = active.get(packet.run_id);
    if (run) run.pending = { packet, validate, resolve: resolveDecision };
  });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const VENDOR: Record<string, string> = {
  'preact.mjs': join(ROOT, 'node_modules/preact/dist/preact.mjs'),
  'hooks.mjs': join(ROOT, 'node_modules/preact/hooks/dist/hooks.mjs'),
  'jsx-runtime.mjs': join(ROOT, 'node_modules/preact/jsx-runtime/dist/jsxRuntime.mjs'),
};

const BRIEF_DIRS = [join(ROOT, 'examples'), join(PATHS.eval, 'briefs')];

const send = (res: http.ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8'): void => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const serveFile = (res: http.ServerResponse, file: string): void => {
  if (!existsSync(file)) return send(res, 404, { error: 'not found' });
  send(res, 200, readFileSync(file), MIME[extname(file)] ?? 'application/octet-stream');
};

// Only files under a known folder, so a crafted path cannot reach anything else.
const inside = (base: string, path: string): string | undefined => {
  const full = resolve(base, path);
  return full === base || full.startsWith(`${base}${sep}`) ? full : undefined;
};

const readBody = (req: http.IncomingMessage): Promise<unknown> =>
  new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) reject(new Error('body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });

const listBriefs = (): { path: string; title: string; lines: number; group: string }[] =>
  BRIEF_DIRS.flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => name.endsWith('.md'))
          .sort()
          .map((name) => {
            const text = readFileSync(join(dir, name), 'utf8');
            return { path: relative(ROOT, join(dir, name)), title: briefTitle(text), lines: text.trimEnd().split('\n').length, group: dir.includes('eval') ? 'eval' : 'example' };
          })
      : [],
  );

// The first line of events.jsonl is run_started. Reading 256 KB is enough without loading big logs.
const firstEvent = (file: string): RunEvent | undefined => {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytes).toString('utf8').split('\n')[0] ?? '';
    return JSON.parse(line) as RunEvent;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
};

const readEvents = (runId: string): RunEvent[] => {
  const file = inside(PATHS.runs, join(runId, 'events.jsonl'));
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RunEvent];
      } catch {
        return [];
      }
    });
};

const runStatus = (runId: string): string => {
  const live = active.get(runId);
  if (live) {
    const last = live.handle.bus.events.at(-1);
    if (live.pending) return 'awaiting_approval';
    if (last?.type === 'run_finished') return last.status;
    if (last?.type === 'run_failed') return 'failed';
    return 'running';
  }
  const summary = join(PATHS.runs, runId, 'run.json');
  return existsSync(summary) ? readJson<{ status: string }>(summary).status : 'incomplete';
};

const listRuns = (): Record<string, unknown>[] => {
  if (!existsSync(PATHS.runs)) return [];
  return readdirSync(PATHS.runs)
    .filter((id) => id.startsWith('run-') && existsSync(join(PATHS.runs, id, 'events.jsonl')))
    .flatMap((id) => {
      const first = firstEvent(join(PATHS.runs, id, 'events.jsonl'));
      if (first?.type !== 'run_started' || !Array.isArray(first.brief_lines)) return []; // older runs used another log format
      const summaryFile = join(PATHS.runs, id, 'run.json');
      const summary = existsSync(summaryFile) ? readJson<{ tasks?: number; totals?: { model_calls: number; duration_ms: number; cost_usd: number } }>(summaryFile) : undefined;
      return [{ run_id: id, title: first.title, label: first.label, started_at: first.ts, status: runStatus(id), tasks: summary?.tasks, totals: summary?.totals }];
    })
    .sort((a, b) => String(b.run_id).localeCompare(String(a.run_id)));
};

const streamEvents = (req: http.IncomingMessage, res: http.ServerResponse, runId: string): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const write = (event: RunEvent): void => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const end = (): void => {
    res.write('event: end\ndata: {}\n\n');
    res.end();
  };
  const live = active.get(runId);
  if (!live) {
    readEvents(runId).forEach(write);
    end();
    return;
  }
  live.handle.bus.events.forEach(write);
  const last = live.handle.bus.events.at(-1);
  if (last?.type === 'run_finished' || last?.type === 'run_failed') {
    end();
    return;
  }
  const unsubscribe = live.handle.bus.subscribe((event) => {
    write(event);
    if (event.type === 'run_finished' || event.type === 'run_failed') {
      unsubscribe();
      end();
    }
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
};

const startWebRun = (body: { brief?: unknown; today?: unknown }): { run_id: string } => {
  const candidate = inside(ROOT, String(body.brief ?? ''));
  const briefPath = candidate && BRIEF_DIRS.some((dir) => candidate.startsWith(`${dir}${sep}`)) ? candidate : undefined;
  if (!briefPath || !briefPath.endsWith('.md') || !existsSync(briefPath)) throw new Error('Pick one of the listed briefs.');
  const today = typeof body.today === 'string' && body.today ? body.today : localIsoDate(new Date());
  if (!isIsoDate(today)) throw new Error('today must be YYYY-MM-DD.');
  const handle = startRun({ briefPath, today, runtime, gate: webGate, label: 'control room' });
  active.set(handle.runId, { handle });
  handle.done
    .catch(() => undefined)
    .finally(() => {
      // Keep it briefly for late subscribers; afterwards the log on disk serves it.
      setTimeout(() => active.delete(handle.runId), 5 * 60_000);
    });
  return { run_id: handle.runId };
};

const decide = (runId: string, body: unknown): { status: number; body: unknown } => {
  const run = active.get(runId);
  if (!run?.pending) return { status: 409, body: { error: 'This run is not waiting for approval.' } };
  const input = body as DecisionInput;
  if (typeof input?.send !== 'boolean' || !Array.isArray(input.tasks) || !Array.isArray(input.answers)) {
    return { status: 400, body: { error: 'Expected { send, tasks, answers, accept_risks }.' } };
  }
  const errors = run.pending.validate({ ...input, accept_risks: Boolean(input.accept_risks) });
  if (input.send && errors.length) return { status: 400, body: { error: 'Fix these before sending.', errors } };
  run.pending.resolve({ ...input, accept_risks: Boolean(input.accept_risks) });
  run.pending = undefined;
  return { status: 200, body: { ok: true } };
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname;
  const handle = async (): Promise<void> => {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return serveFile(res, join(PATHS.ui, 'index.html'));
    if (req.method === 'GET' && path === '/styles.css') return serveFile(res, join(PATHS.ui, 'styles.css'));
    if (req.method === 'GET' && path.startsWith('/app/')) {
      const file = inside(join(PATHS.ui, 'dist'), path.slice('/app/'.length));
      return file ? serveFile(res, file) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && path.startsWith('/vendor/')) {
      const file = VENDOR[path.slice('/vendor/'.length)];
      return file ? serveFile(res, file) : send(res, 404, { error: 'not found' });
    }
    if (req.method === 'GET' && path === '/api/meta') {
      return send(res, 200, { runtime: { id: runtime.runtime.id, label: runtime.runtime.label, why: runtime.why }, model: MODEL, today: localIsoDate(new Date()), briefs: listBriefs() });
    }
    if (req.method === 'GET' && path === '/api/runs') return send(res, 200, listRuns());
    if (req.method === 'POST' && path === '/api/runs') return send(res, 201, startWebRun((await readBody(req)) as { brief?: unknown; today?: unknown }));
    const match = path.match(/^\/api\/runs\/(run-[\w-]+)\/(events|events\.json|decision)$/);
    if (match) {
      const [, runId = '', action] = match;
      if (req.method === 'GET' && action === 'events') return streamEvents(req, res, runId);
      if (req.method === 'GET' && action === 'events.json') {
        const events = active.get(runId)?.handle.bus.events ?? readEvents(runId);
        return events.length ? send(res, 200, events) : send(res, 404, { error: 'No such run.' });
      }
      if (req.method === 'POST' && action === 'decision') {
        const result = decide(runId, await readBody(req));
        return send(res, result.status, result.body);
      }
    }
    send(res, 404, { error: 'not found' });
  };
  handle().catch((error: unknown) => send(res, 400, { error: error instanceof Error ? error.message : String(error) }));
});

if (!existsSync(join(PATHS.ui, 'dist', 'main.js'))) console.warn('ui/dist is missing. Run npm run ui, which builds the front end first.');
server.listen(PORT, HOST, () => {
  console.log(`\n  Agent control room: http://localhost:${PORT}\n  Runtime: ${runtime.runtime.label}\n  ${runtime.why}\n  Dry run: no credentials are read and nothing is sent.\n`);
});
