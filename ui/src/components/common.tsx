import type { ComponentChildren, JSX } from 'preact';
import { TEAM_COLOUR } from '../format.ts';
import type { Team } from '../types.ts';

export const StatusDot = ({ status }: { status: string }): JSX.Element => <span class={`dot dot-${status}`} aria-label={status} />;

export const TeamTag = ({ team }: { team: Team }): JSX.Element => (
  <span class="team-tag" style={`--team: ${TEAM_COLOUR[team]}`}>
    {team}
  </span>
);

export const Pill = ({ tone = 'neutral', children }: { tone?: string; children: ComponentChildren }): JSX.Element => <span class={`pill pill-${tone}`}>{children}</span>;

export const Confidence = ({ value, threshold }: { value: number; threshold: number }): JSX.Element => {
  const tone = value < threshold ? 'bad' : value < 0.8 ? 'warn' : 'good';
  return (
    <span class={`confidence confidence-${tone}`} title={`Confidence ${value.toFixed(2)}. Under ${threshold} waits for a human.`}>
      <span class="confidence-bar">
        <span style={`width: ${Math.round(value * 100)}%`} />
      </span>
      {value.toFixed(2)}
    </span>
  );
};

export const Section = ({ title, aside, children }: { title: string; aside?: ComponentChildren; children: ComponentChildren }): JSX.Element => (
  <section class="section">
    <header class="section-head">
      <h3>{title}</h3>
      {aside}
    </header>
    {children}
  </section>
);

export const Empty = ({ children }: { children: ComponentChildren }): JSX.Element => <p class="empty">{children}</p>;
