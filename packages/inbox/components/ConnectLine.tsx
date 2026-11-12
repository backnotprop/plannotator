import { Fragment } from 'react';
import type { InboxConnectReport, InboxNoteAutoAdd } from '@plannotator/core/inbox-types';
import { bandLines, notesAddedParts } from '../agents';
import { Icon } from '../icons';
import { Tip } from './Tip';

/**
 * One quiet line above the list (the band of the old agent-note dialog, moved
 * here when the note became automatic: approval "inbox-agent-note-auto"): what
 * the last run connected, who needs connecting by hand, what failed, whose
 * entry is someone else's, and the notes Plannotator wrote by itself ("Added
 * the Inbox note to Claude Code's instructions.", the file in each name's
 * tooltip). No popup, nothing to confirm: Got it hides it, and so does the
 * way to Settings → Agents. App.tsx tells the Inbox it was said
 * (`POST /api/inbox/agents/seen`) when it shows, so the next load is clear.
 */
export function ConnectLine({
  report,
  notes,
  onDismiss,
  onSettings,
}: {
  report: InboxConnectReport | null;
  notes: readonly InboxNoteAutoAdd[];
  onDismiss: () => void;
  /** Settings → Agents (the line hides too). */
  onSettings: () => void;
}) {
  const band = report ? bandLines(report) : null;
  const added = notes.length > 0 ? notesAddedParts(notes) : null;
  const toSettings = (
    <button type="button" className="ib-lnk" onClick={onSettings}>
      Settings → Agents
    </button>
  );
  return (
    <div className="ib-askline ib-askquiet ib-cline" role="region" aria-label="Your agents" data-connect-line="">
      <div className="ib-cline-in">
        <div className="ib-cline-lines" role="status">
          {band?.connected && (
            <p className="ib-cline-ok">
              <Icon name="checkCircle" />
              <span dir="auto">{band.connected}</span>
            </p>
          )}
          {added && (
            <p className="ib-cline-ok" data-connect-notes="">
              <Icon name="checkCircle" />
              <span>
                {added.before}
                {added.names.map((name, index) => (
                  <Fragment key={name.agent}>
                    {index > 0 && (index === added.names.length - 1 ? ' and ' : ', ')}
                    <Tip content={<code dir="ltr">{name.path}</code>}>
                      <span className="ib-cline-agent" data-note-agent={name.agent} data-note-path={name.path}>
                        {name.label}
                      </span>
                    </Tip>
                  </Fragment>
                ))}
                {added.after}
                <span className="ib-sr"> ({added.files})</span>.
              </span>
            </p>
          )}
          {band?.trusted && (
            <p className="ib-cline-ok" data-connect-trusted="">
              <Icon name="checkCircle" />
              <span dir="auto">{band.trusted}</span>
            </p>
          )}
          {band?.granted.map((line) => (
            <p className="ib-cline-ok" key={`g-${line.agent}`} data-connect-granted="">
              <Icon name="checkCircle" />
              <span dir="auto">{line.text}</span>
            </p>
          ))}
          {band &&
            [...band.failed, ...band.trustFailed.map((line) => ({ ...line, agent: `t-${line.agent}` }))].map((line) => (
              <p className="ib-cline-warn" key={`f-${line.agent}`}>
                <Icon name="warn" />
                <span>
                  {line.text} {toSettings}
                </span>
              </p>
            ))}
          {band?.byHand && (
            <p className="ib-cline-quiet">
              <Icon name="info" />
              <span>
                {band.byHand} {toSettings}
              </span>
            </p>
          )}
          {band?.elsewhere.map((line) => (
            <p className="ib-cline-quiet" key={`m-${line.agent}`} data-connect-elsewhere="">
              <Icon name="info" />
              <span>
                {line.text} {toSettings}
              </span>
            </p>
          ))}
          {band?.foreign.map((line) => (
            <p className="ib-cline-quiet" key={`x-${line.agent}`}>
              <Icon name="info" />
              <span>{line.text}</span>
            </p>
          ))}
        </div>
        <div className="ib-ask-acts">
          <button type="button" className="ib-btn ib-ghost ib-sm" onClick={onDismiss}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
