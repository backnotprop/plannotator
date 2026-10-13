import { useState } from 'react';
import { HARNESSES, type ConnectContext } from '../harnesses';
import { Icon } from '../icons';
import { ConnectPicker } from './ConnectPicker';
import { SidebarTrigger } from '../shell/sidebar';

/**
 * First run (the approved "inbox-agent-awareness" design, 01): a sentence to
 * try it with, and the harness picker folded behind "Connect another agent by
 * hand". What `plannotator inbox` connected and the note question belong to
 * the one-time agent-note dialog (AgentNoteDialog, "inbox-agent-note-dialog").
 * The three "Nothing to install" cards it replaces were not true for Pi and
 * OpenCode, whose tool is off until turned on.
 */
export function EmptyState({ context }: { context: ConnectContext | null }) {
  const [byHand, setByHand] = useState(false);
  return (
    <section className="ib-listcol" aria-label="Inbox">
      <div className="ib-lhead">
        <SidebarTrigger />
        <h1>Inbox</h1>
      </div>
      <div className="ib-lbody">
        <div className="ib-empty" data-inbox-empty="">
          <h2>No agent has written yet</h2>
          <div className="ib-try">
            <h3>Try it</h3>
            <p>In a new session of any connected agent, ask:</p>
            <div className="ib-try-quote">Send me a test message in my Plannotator Inbox.</div>
          </div>
          {context && (
            <>
              <button type="button" className="ib-byhand" aria-expanded={byHand} aria-controls="ib-byhand" onClick={() => setByHand((open) => !open)}>
                <Icon name="chevR" />
                Connect another agent by hand
              </button>
              {byHand && (
                <div id="ib-byhand">
                  <ConnectPicker harnesses={HARNESSES} initial="codex" context={context} icons />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
