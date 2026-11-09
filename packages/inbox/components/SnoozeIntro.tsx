/**
 * The one-time Snooze announcement (approval "inbox-snooze-announce", direction B "The real menu"; when it shows:
 * snoozeIntro.ts). A third user of the one-time dialog shell (`.ib-lo`, after the list options and voice intros).
 *
 * The picture is static and in the person's own mode (no light frame): two of the person's real rows (the thread they
 * just left is the one the menu is aimed at), the real "Snooze until" menu with a pointer on Tomorrow, and the real
 * "Snoozed · <time> · Undo" toast. Its times are today's, from core's inbox-snooze.ts. On a phone it is the ⋯ sheet's
 * times. No motion: the dialog has no entrance of its own (Modal), and the picture never moves, so reduced motion
 * changes nothing.
 *
 * Try it (first focus) opens the real Snooze menu (snoozeIntroTry.ts) and never snoozes anything by itself. Got it,
 * Escape and a click outside close it. Every way out is final: the Inbox stamped it when this page claimed it.
 */
import { useMemo, type ReactNode } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxSnoozeChoices, inboxSnoozeWhen } from '@plannotator/core/inbox-snooze';
import { Icon } from '../icons';
import { ShortcutHint } from '../shortcuts/hint';
import { inboxThreadShortcuts } from '../shortcuts/thread.shortcuts';
import { ListRow } from './InboxList';
import { Modal } from './Updates';

const noop = () => {};

/** The menu's times as the real menu draws them; `lit`: the choice under the pointer (or a phone's first). */
function Times({ now, lit, pointer }: { now: Date; lit: string; pointer: boolean }) {
  const choices = inboxSnoozeChoices(now);
  return (
    <>
      <div className="ib-pmi ib-zb">
        <Icon name="chevL" size={14} />
        Snooze until
      </div>
      {choices.map((choice) => (
        <div key={choice.id} className="ib-pmi ib-zi" data-highlighted={choice.id === lit ? '' : undefined} data-snooze-intro-choice={choice.id}>
          {choice.label}
          <span className="ib-zw">{inboxSnoozeWhen(choice.until, now)}</span>
          {pointer && choice.id === lit && <Pointer />}
        </div>
      ))}
      <div className="ib-pm-sep" />
      <div className="ib-pmi">Pick a time…</div>
    </>
  );
}

/** A mouse pointer, resting on the choice. */
function Pointer() {
  return (
    <svg className="ib-zx-pointer" width="16" height="22" viewBox="0 0 16 22" aria-hidden="true">
      <path d="M1 1 L1 17 L5 13.4 L7.8 20 L10.6 18.8 L7.9 12.4 L13 12.4 Z" fill="#111" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** The real toast's look, at rest under the menu. */
function Toast({ when }: { when: string }) {
  return (
    <div className="ib-toast ib-toast-closable ib-zx-toast">
      <Icon name="clock" size={16} />
      <span className="ib-tsay">
        <span className="ib-tlead">Snoozed</span>
        <span className="ib-tdetail">{when}</span>
      </span>
      <span className="ib-tacts">
        <span className="ib-tundo">
          Undo
          <ShortcutHint scope={inboxThreadShortcuts} action="undo" className="" />
        </span>
        <span className="ib-tclose">
          <Icon name="x" size={14} />
        </span>
      </span>
    </div>
  );
}

function Row({ row, project, menu }: { row: InboxListRow; project: string; menu: boolean }) {
  return (
    <ListRow
      row={row}
      project={project}
      away={false}
      drawn={row.section}
      shape="narrow"
      full={false}
      filtered={false}
      selected={false}
      lit={false}
      onOpen={noop}
      day=""
      menu={menu}
      pinned={false}
      pinColumn={false}
      pill={false}
      compact={false}
    />
  );
}

export interface SnoozeIntroProps {
  /** The rows to draw: the thread just left last (the menu's target), one more above it when there is one. */
  rows: readonly InboxListRow[];
  projectNames?: ReadonlyMap<string, string>;
  phone: boolean;
  /** Open the real Snooze menu (the dialog closes first). */
  onTry: () => void;
  /** Got it, Escape, a click outside. */
  onClose: () => void;
}

export function SnoozeIntro({ rows, projectNames, phone, onTry, onClose }: SnoozeIntroProps) {
  const now = useMemo(() => new Date(), []);
  const choices = useMemo(() => inboxSnoozeChoices(now), [now]);
  const tomorrow = choices.find((choice) => choice.id === 'tomorrow') ?? choices[0]!;
  const hint: ReactNode = phone ? (
    <>
      In a thread, tap ⋯ and pick <b>Snooze</b>.
    </>
  ) : (
    'Right-click a thread, or click the clock at the top of an open thread.'
  );
  return (
    <Modal labelledBy="ib-zx-title" describedBy="ib-zx-desc" testId="snooze-intro" onClose={onClose} ownKeys className={`ib-lo ib-zx${phone ? ' ib-lo-phone' : ''}`}>
      <div className="ib-lo-art ib-zx-art" inert aria-hidden="true" data-snooze-intro-picture="">
        {phone ? (
          <div className="ib-pm-pos ib-zx-pos" data-phone="">
            <div className="ib-pm ib-zx-menu">
              <Times now={now} lit={choices[0]!.id} pointer={false} />
            </div>
          </div>
        ) : (
          <div className="ib-zx-scene">
            <section className="ib-listcol ib-narrow ib-zx-list">
              <div className="ib-lbody">
                <div className="ib-group">
                  {rows.map((row, index) => (
                    <Row key={row.thread_id} row={row} project={projectNames?.get(row.project.id) ?? row.project.name} menu={index === rows.length - 1} />
                  ))}
                </div>
              </div>
            </section>
            <div className="ib-pm ib-zx-menu">
              <Times now={now} lit={tomorrow.id} pointer />
            </div>
            <Toast when={inboxSnoozeWhen(tomorrow.until, now)} />
          </div>
        )}
      </div>
      <div className="ib-lo-text">
        <div className="ib-zx-new">New</div>
        <h2 id="ib-zx-title">Snooze a thread until later</h2>
        <p id="ib-zx-desc">Pick later today, tomorrow, in 3 days, next week, or a time you choose. The thread waits in Snoozed and comes back on its own. Undo puts it back at once.</p>
        <p className="ib-zx-hint">
          <span className="ib-zx-chip" aria-hidden="true">
            <Icon name={phone ? 'dots' : 'clock'} size={phone ? 16 : 14} />
          </span>
          <span>{hint}</span>
        </p>
      </div>
      <div className="ib-lo-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onClose} data-snooze-intro-close="">
          Got it
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri" onClick={onTry} data-snooze-intro-try="">
          Try it
        </button>
      </div>
    </Modal>
  );
}
