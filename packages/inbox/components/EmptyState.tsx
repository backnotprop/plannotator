import { useState } from 'react';
import { hostMcpSnippet, OTHER_HARNESSES, type ConnectContext } from '../harnesses';
import { HostMark, Icon } from '../icons';
import { CodeBox, ConnectPicker } from './ConnectPicker';

const HOSTS = [
  { host: 'claude-code', piece: 'The Plannotator mod', name: 'Claude Code', who: 'Comes with Plannotator for Claude Code.' },
  { host: 'pi', piece: 'The Pi extension', name: 'Pi', who: "Plannotator's extension for Pi." },
  { host: 'opencode', piece: 'The OpenCode plugin', name: 'OpenCode', who: "Plannotator's plugin for OpenCode." },
] as const;

function HostCard({ host, context }: { host: (typeof HOSTS)[number]; context: ConnectContext }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ib-hcard" data-host={host.host}>
      <div className="ib-hh">
        <HostMark host={host.host} big />
        <div>
          <div className="ib-hn">{host.piece}</div>
          <div className="ib-hw">{host.name}</div>
        </div>
      </div>
      <p>{host.who} It writes here on its own and wakes the agent when you Send, so no MCP is needed.</p>
      <button type="button" className="ib-hfold" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name={open ? 'chevD' : 'chevR'} size={13} />
        Prefer the MCP? Add it anyway
      </button>
      {open && <CodeBox text={hostMcpSnippet(host.host, context)} wrap />}
    </div>
  );
}

/** First run (record 1.3 to 1.5): the three Plannotator connections, then any other agent's harness. */
export function EmptyState({ context }: { context: ConnectContext | null }) {
  return (
    <section className="ib-listcol" aria-label="Inbox">
      <div className="ib-lhead">
        <h1>Inbox</h1>
      </div>
      <div className="ib-lbody">
        <div className="ib-empty" data-inbox-empty="">
          <h2>No agent has written yet.</h2>
          {context && (
            <>
              <div className="ib-csub">
                <Icon name="check" size={15} />
                Claude Code, Pi and OpenCode need nothing more
              </div>
              <div className="ib-hcards">
                {HOSTS.map((host) => (
                  <HostCard key={host.host} host={host} context={context} />
                ))}
              </div>
              <div className="ib-csub">
                <Icon name="code" size={15} />
                Any other agent: add the Inbox as an MCP server
              </div>
              <ConnectPicker harnesses={OTHER_HARNESSES} initial="codex" context={context} icons />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
