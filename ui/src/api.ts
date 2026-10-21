import type { DecisionInput, Meta, RunEvent, RunSummary } from './types.ts';

const json = async <T>(response: Response): Promise<T> => {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; errors?: string[] };
  if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), { errors: body.errors ?? [] });
  return body;
};

export const getMeta = async (): Promise<Meta> => json<Meta>(await fetch('/api/meta'));
export const getRuns = async (): Promise<RunSummary[]> => json<RunSummary[]>(await fetch('/api/runs'));
export const getEvents = async (runId: string): Promise<RunEvent[]> => json<RunEvent[]>(await fetch(`/api/runs/${runId}/events.json`));

export const startRun = async (brief: string, today?: string): Promise<string> => {
  const response = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ brief, today }) });
  return (await json<{ run_id: string }>(response)).run_id;
};

export const sendDecision = async (runId: string, input: DecisionInput): Promise<void> => {
  await json(await fetch(`/api/runs/${runId}/decision`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }));
};

// Live: the server replays everything so far, then streams new events until the run ends.
export const followRun = (runId: string, onEvent: (event: RunEvent) => void, onEnd: () => void): (() => void) => {
  const source = new EventSource(`/api/runs/${runId}/events`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as RunEvent);
  source.addEventListener('end', () => {
    source.close();
    onEnd();
  });
  return () => source.close();
};

// Replay: the recorded events again, at a chosen speed, with long thinking pauses capped.
export const replayRun = (events: RunEvent[], speed: number, onEvent: (event: RunEvent) => void, onEnd: () => void): (() => void) => {
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = (): void => {
    const event = events[index];
    if (!event) {
      onEnd();
      return;
    }
    onEvent(event);
    index += 1;
    const following = events[index];
    const gap = following ? (Date.parse(following.ts) - Date.parse(event.ts)) / speed : 0;
    timer = setTimeout(next, Math.min(1200, Math.max(0, gap)));
  };
  next();
  return () => clearTimeout(timer);
};
