import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { highlightJson, mrkdwn, prettyDate } from '../format.ts';
import type { RunView } from '../store.ts';
import type { AsanaRequest, SlackRequest } from '../types.ts';
import { Empty, Pill } from './common.tsx';

const SlackPreview = ({ request }: { request: SlackRequest }): JSX.Element => (
  <div class="slack">
    <div class="slack-channel">
      <span class="slack-hash">#</span>
      {request.body.channel.replace(/^#/, '')}
    </div>
    <div class="slack-message">
      <div class="slack-avatar">CB</div>
      <div class="slack-content">
        <div class="slack-meta">
          <b>Campaign Brief Agent</b>
          <span class="slack-app">APP</span>
          <span class="slack-time">now</span>
        </div>
        {request.body.blocks.map((block, index) => {
          if (block.type === 'header') return <p key={index} class="slack-header">{block.text?.text}</p>;
          if (block.type === 'section') return <div key={index} class="slack-section" dangerouslySetInnerHTML={{ __html: mrkdwn(block.text?.text ?? '') }} />;
          if (block.type === 'divider') return <hr key={index} class="slack-divider" />;
          if (block.type === 'context') return <p key={index} class="slack-context">{block.elements?.map((element) => element.text).join(' ')}</p>;
          return null;
        })}
      </div>
    </div>
  </div>
);

const AsanaList = ({ requests }: { requests: AsanaRequest[] }): JSX.Element => {
  const [open, setOpen] = useState<string | undefined>(requests[0]?.local_id);
  return (
    <div class="asana">
      {requests.map((request) => (
        <div key={request.local_id} class={`asana-row ${open === request.local_id ? 'asana-open' : ''}`}>
          <button type="button" class="asana-head" onClick={() => setOpen(open === request.local_id ? undefined : request.local_id)}>
            <span class="mono method">POST</span>
            <span class="mono muted">/tasks</span>
            <span class="asana-name">{request.body.data.name}</span>
            <span class="muted">{prettyDate(request.body.data.due_on)}</span>
            {request.add_dependencies.length ? <span class="muted small">+ {request.add_dependencies.length} dependencies</span> : null}
          </button>
          {open === request.local_id ? <pre class="mono json" dangerouslySetInnerHTML={{ __html: highlightJson(request.body) }} /> : null}
        </div>
      ))}
    </div>
  );
};

type Tab = 'slack' | 'slack-json' | 'asana' | 'summary';

export const OutboxPanel = ({ view }: { view: RunView }): JSX.Element => {
  const [tab, setTab] = useState<Tab>('slack');
  const outbox = view.outbox;
  if (!outbox) {
    const status = view.decision && !view.decision.approved ? 'The plan was not approved, so nothing was written.' : 'The outbox fills after you approve. Nothing is ever sent from here.';
    return <Empty>{status}</Empty>;
  }
  const { payloads } = outbox;
  const tabs: [Tab, string][] = [
    ['slack', 'Slack preview'],
    ['slack-json', 'Slack Block Kit JSON'],
    ['asana', `Asana requests (${payloads.asana.length})`],
    ['summary', 'summary.md'],
  ];
  return (
    <div class="outbox">
      <div class="dry-run">
        <Pill tone="warn">DRY RUN</Pill>
        <span>
          These are the exact request bodies for <span class="mono">POST {payloads.slack.url}</span> and <span class="mono">POST {payloads.asana[0]?.url ?? 'https://app.asana.com/api/1.0/tasks'}</span>. No credentials were read and nothing was sent.
        </span>
      </div>
      <div class="subtabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} class={`subtab ${tab === id ? 'subtab-on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'slack' ? <SlackPreview request={payloads.slack} /> : null}
      {tab === 'slack-json' ? <pre class="mono json tall" dangerouslySetInnerHTML={{ __html: highlightJson(payloads.slack) }} /> : null}
      {tab === 'asana' ? <AsanaList requests={payloads.asana} /> : null}
      {tab === 'summary' ? <pre class="mono tall">{payloads.markdown}</pre> : null}
      <p class="muted small">Written to {Object.values(outbox.files).join(', ')}</p>
    </div>
  );
};
