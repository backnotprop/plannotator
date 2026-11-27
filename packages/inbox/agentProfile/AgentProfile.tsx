/**
 * An agent's profile in the reading pane (approval "inbox-agent-profile-card", B1, B2, E2): its face, name and
 * "Claude Code · harbor · Laptop", Message (a new message to it, as its sidebar row's); Activity, what it does now and
 * since when (agent lines, line.ts); Threads, its threads newest first ("Waiting on you" in amber, a dot when new; a
 * click opens the thread in its place); Details, as its sidebar hover card says them. A linked computer's agent reads
 * the same, from the same merged list.
 *
 * Closes like a thread: ✕, Escape, a phone's or a narrow window's way back (the browser's Back where it came from
 * there). Focus goes back to the card or the agent's row that opened it.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';
import { shortTime } from '../format';
import { AgentMark } from '../agents/AgentMark';
import { agentHostName } from '../agents/model';
import { useInboxAgents } from '../agentsList';
import { useRelativeClock } from '../relativeTime';
import type { MachinesModel } from '../machines';
import { inOverlay, isComposingKey, isEditableTarget, keyTarget, modalOpen } from '../shortcuts/guards';
import { agentLineOf, lineFactsOf } from './line';
import { AgentLine } from './AgentLine';
import { agentPicks, agentSubWords, agentTakesMessages, profileAgentOf, profileDetails, profileThreads } from './model';

export interface AgentProfileProps {
  id: string;
  machines: MachinesModel;
  rows: readonly InboxListRow[];
  phone: boolean;
  stacked: boolean;
  backLabel: string;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
  onMessage: (session: string, opener: HTMLElement) => void;
}

/** The card or the agent's row that opens this agent's profile: where focus goes back on close. */
export const openerSelector = (id: string) => `[data-agent-profile-opener="${CSS.escape(id)}"]`;

export function AgentProfile({ id, machines, rows, phone, stacked, backLabel, onClose, onOpenThread, onMessage }: AgentProfileProps) {
  const groups = useInboxAgents();
  const who = useMemo(() => profileAgentOf(id, groups, machines), [id, groups, machines]);
  const threads = useMemo(() => profileThreads(id, groups, machines, rows), [id, groups, machines, rows]);
  const line = who ? agentLineOf(lineFactsOf(who.agent)) : null;
  const headingId = useId();
  const paneRef = useRef<HTMLElement>(null);
  const covers = phone || stacked;

  // Escape closes it, as it closes a thread, unless something on the page used it (a menu, a dialog, a field).
  const closeNow = useRef(onClose);
  closeNow.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event) || modalOpen()) return;
      const from = keyTarget(event);
      if (from && (isEditableTarget(from) || inOverlay(from) || from.closest('[role="menu"], [role="listbox"], [data-fan-open]'))) return;
      closeNow.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Over the list (a phone, a narrow window), focus comes into the profile; back, it goes to what opened it.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (covers) pane?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (active && active !== document.body && !pane?.contains(active)) return;
      requestAnimationFrame(() => document.querySelector<HTMLElement>(openerSelector(id))?.focus({ preventScroll: true }));
    };
  }, [covers, id]);

  // Its times read again each minute while it is open ("Just now" goes stale): the rows' shared minute clock.
  const minute = useRelativeClock(true);
  const details = who ? profileDetails(who, machines, new Date(Math.max(minute, Date.now()))) : [];
  const name = who?.name ?? agentHostName(null);
  return (
    <section ref={paneRef} className="ib-pane ib-apf" aria-labelledby={headingId} data-agent-profile={id}>
      <div className="ib-phead ib-apf-head">
        {covers && (
          <button type="button" className="ib-pback" onClick={onClose} aria-label={`Back to ${backLabel}`} data-agent-profile-back="">
            <Icon name="chevL" size={phone ? 18 : 16} />
            <span className="ib-pback-l">{backLabel}</span>
          </button>
        )}
        <span className="ib-apf-grow" />
        {!covers && (
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close the profile" data-agent-profile-close="">
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </div>
      <div className="ib-pbody ib-apf-body">
        <div className="ib-apf-in">
          <div className="ib-apf-hero">
            {who && <AgentMark id={who.agent.id} host={who.agent.host} name={name} agent={who.agent} picks={agentPicks(who.machine, machines)} size={44} />}
            <div className="ib-apf-id">
              <h2 id={headingId} className="ib-apf-name" tabIndex={-1} dir="auto">
                {name}
              </h2>
              {who && (
                <p className="ib-apf-sub" dir="auto">
                  {agentSubWords(who, machines, true)}
                </p>
              )}
            </div>
            {who && agentTakesMessages(who.agent) && (
              <button type="button" className="ib-apf-msg" onClick={(event) => onMessage(who.agent.session, event.currentTarget)} data-agent-profile-message="">
                <Icon name="compose" size={16} />
                <span className="ib-apf-msg-l">Message</span>
              </button>
            )}
          </div>
          {line && (
            <section className="ib-apf-sec" aria-label="Activity" data-agent-profile-activity="">
              <h3 className="ib-apf-lbl">Activity</h3>
              <ul className="ib-apf-acts">
                <li className="ib-apf-now">
                  <AgentLine line={line} big />
                </li>
              </ul>
            </section>
          )}
          {threads.length > 0 && (
            <section className="ib-apf-sec" aria-label="Threads" data-agent-profile-threads="">
              <h3 className="ib-apf-lbl">Threads</h3>
              <ul className="ib-apf-ths">
                {threads.map((t) => (
                  <li key={`${t.row.machine ?? ''}:${t.row.thread_id}`}>
                    <button type="button" className="ib-apf-th" data-unread={t.unread ? '' : undefined} onClick={() => onOpenThread(t.row.thread_id)} data-agent-profile-thread={t.row.thread_id}>
                      <span className="ib-apf-th-t" dir="auto">
                        {t.title}
                      </span>
                      {t.unread && (
                        <>
                          <span className="ib-apf-th-u" aria-hidden="true" />
                          <span className="ib-sr">, new</span>
                        </>
                      )}
                      <span className="ib-apf-sp" />
                      {t.waits && <span className="ib-apf-th-w">Waiting on you</span>}
                      <span className="ib-apf-th-at">{shortTime(t.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {details.length > 0 && (
            <section className="ib-apf-sec" aria-label="Details" data-agent-profile-details="">
              <h3 className="ib-apf-lbl">Details</h3>
              <dl className="ib-apf-dl">
                {details.map(([term, value]) => (
                  <div key={term}>
                    <dt>{term}</dt>
                    <dd dir="auto">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
