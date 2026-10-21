import type { Team } from './types.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const TEAM_COLOUR: Record<Team, string> = {
  Media: '#60a5fa',
  PR: '#fbbf24',
  Creative: '#f472b6',
  Organic: '#34d399',
  Data: '#22d3ee',
};

export const prettyDate = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return `${WEEKDAYS[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]}`;
};

export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const duration = (ms: number | undefined): string => {
  if (ms === undefined || Number.isNaN(ms)) return '';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

export const usd = (amount: number | undefined): string => (amount === undefined ? 'n/a' : `$${amount.toFixed(2)}`);

export const timingLabel = (timing: string): string => timing.replace('_', ' ');

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const inline = (text: string): string =>
  text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?;:])/g, '$1<i>$2</i>')
    .replace(/~([^~\n]+)~/g, '<s>$1</s>');

// Slack mrkdwn to HTML for the preview. Input is escaped first, so only these tags can appear.
export const mrkdwn = (text: string): string => {
  let html = '';
  let inList = false;
  for (const line of escapeHtml(text).split('\n')) {
    const bullet = line.match(/^\s*(?:•|-)\s+(.*)$/);
    if (bullet) {
      if (!inList) html += '<ul>';
      inList = true;
      html += `<li>${inline(bullet[1] ?? '')}</li>`;
      continue;
    }
    if (inList) html += '</ul>';
    inList = false;
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return inList ? `${html}</ul>` : html;
};

// Minimal JSON highlighter for the payload views. Escapes first, then wraps tokens.
export const highlightJson = (value: unknown): string =>
  escapeHtml(JSON.stringify(value, null, 2)).replace(
    /(&quot;(?:\\.|[^&\\]|&(?!quot;))*&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (match, str: string | undefined, colon: string | undefined, literal: string | undefined) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (literal) return `<span class="j-lit">${literal}</span>`;
      return `<span class="j-num">${match}</span>`;
    },
  );
