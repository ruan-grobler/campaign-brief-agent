import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// run-YYYYMMDD-HHMMSS-xxxx in local time: sortable, readable, unique enough for one machine.
export const newRunId = (now: Date = new Date()): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `run-${date}-${time}-${randomBytes(2).toString('hex')}`;
};

// One JSON line per event. The orchestrator and the tool server both append to the same file.
export const logEvent = (runDir: string, event: Record<string, unknown>): void => {
  appendFileSync(join(runDir, 'events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
};

export const writeJson = (path: string, value: unknown): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
