import { useState } from 'react';
import { hostMcpSnippet, OTHER_HARNESSES, type ConnectContext } from '../harnesses';
import { HostMark } from '../icons';
import { CodeBox, ConnectPicker } from './ConnectPicker';

type PlannotatorHost = 'claude-code' | 'pi' | 'opencode';

const HOSTS: readonly { host: PlannotatorHost; name: string; line: string }[] = [
  { host: 'claude-code', name: 'Claude Code', line: "Plannotator's mod writes here. Nothing to install." },
  { host: 'pi', name: 'Pi', line: "Plannotator's extension writes here. Nothing to install." },
  { host: 'opencode', name: 'OpenCode', line: "Plannotator's plugin writes here. Nothing to install." },
];

/**
 * First run (record 1.3, the addendum "the empty state, as the owner saw it
 * built"): the three Plannotator connections, then every other agent's
 * harness. "Use MCP instead" opens that host's command below the row, so the
 * cards keep one height.
 */
export function EmptyState({ context }: { context: ConnectContext | null }) {
  const [revealed, setRevealed] = useState<PlannotatorHost | null>(null);
  return (
    <section className="ib-listcol" aria-label="Inbox">
      <div className="ib-lhead">
        <h1>Inbox</h1>
      </div>
      <div className="ib-lbody">
        <div className="ib-empty" data-inbox-empty="">
          <h2>No agent has written yet</h2>
          {context && (
            <>
              <div className="ib-hosts">
                <div className="ib-hcards">
                  {HOSTS.map(({ host, name, line }) => (
                    <div className="ib-hcard" data-host={host} data-open={revealed === host || undefined} key={host}>
                      <div className="ib-hh">
                        <HostMark host={host} big />
                        <h3>{name}</h3>
                      </div>
                      <p>{line}</p>
                      <button
                        type="button"
                        className="ib-hlink"
                        aria-expanded={revealed === host}
                        aria-controls="ib-hreveal"
                        onClick={() => setRevealed((open) => (open === host ? null : host))}
                      >
                        Use MCP instead
                      </button>
                    </div>
                  ))}
                </div>
                {revealed && (
                  <div className="ib-hreveal" id="ib-hreveal" data-reveal={revealed}>
                    <CodeBox text={hostMcpSnippet(revealed, context)} />
                  </div>
                )}
              </div>
              <div className="ib-others">
                <h3>Other agents</h3>
                <p>Add the Inbox as a local MCP server.</p>
              </div>
              <ConnectPicker harnesses={OTHER_HARNESSES} initial="codex" context={context} icons />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
