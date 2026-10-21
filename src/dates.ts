// Working-day maths on the agency calendar. Models are unreliable at calendar arithmetic, so the agent calls this.
const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toDate = (iso: string): Date => new Date(`${iso}T00:00:00Z`);
const toIso = (date: Date): string => date.toISOString().slice(0, 10);
const addDays = (iso: string, days: number): string => toIso(new Date(toDate(iso).getTime() + days * DAY_MS));

export const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = toDate(value);
  return !Number.isNaN(date.getTime()) && toIso(date) === value;
};

export const localIsoDate = (date: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export const weekday = (iso: string): string => WEEKDAYS[toDate(iso).getUTCDay()] ?? '';

export const prettyDate = (iso: string): string =>
  `${weekday(iso)} ${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''}`;

// Why a date is not a working day, or undefined when it is one.
export const closedReason = (iso: string, closed: Map<string, string>): string | undefined => {
  const day = toDate(iso).getUTCDay();
  if (day === 0 || day === 6) return 'weekend';
  return closed.get(iso);
};

export const nextWorkingDay = (iso: string, closed: Map<string, string>): string => {
  let cursor = iso;
  while (closedReason(cursor, closed) !== undefined) cursor = addDays(cursor, 1);
  return cursor;
};

// Moves a date by whole working days. Negative counts back. Lists the named closed days it stepped over.
export const shiftWorkingDays = (
  from: string,
  workingDays: number,
  closed: Map<string, string>,
): { date: string; skipped: string[] } => {
  if (workingDays === 0) return { date: nextWorkingDay(from, closed), skipped: [] };
  const step = workingDays < 0 ? -1 : 1;
  let remaining = Math.abs(workingDays);
  let cursor = from;
  const skipped: string[] = [];
  while (remaining > 0) {
    cursor = addDays(cursor, step);
    const reason = closedReason(cursor, closed);
    if (reason === undefined) remaining -= 1;
    else if (reason !== 'weekend') skipped.push(`${cursor} (${reason})`);
  }
  return { date: cursor, skipped };
};
