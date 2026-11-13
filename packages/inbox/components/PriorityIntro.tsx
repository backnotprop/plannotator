/**
 * The one-time Priority dialog (reveals.ts `priority`; the owner, 2026-11-13: "a mix of a and b"; when it shows:
 * priorityIntro.ts). Snooze's one-time dialog shell (`.ib-lo.ib-zx`, 520 px; a bottom sheet on a phone).
 *
 * The picture is static, inert and in the person's own mode: the real row menu with the pointer on Add to Priority
 * (on a phone, the long-press sheet's Star and Add to Priority), and beside it (under it, on a phone, its row compact)
 * the same thread where it lands: first, in the Priority group, above the next thread waiting in its own group (alone,
 * on a phone). No motion.
 *
 * Got it and Try it settle it; Try it then opens the real menu (priorityIntro.ts `openPriorityMenu`). Escape and a
 * click outside are the line's Not now. No keyboard shortcut.
 */
import type { InboxListGroupId, InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { ListRow } from './InboxList';
import { Modal } from './Updates';
import type { PriorityIntroPicture } from '../priorityIntro';

export const PRIORITY_INTRO_COPY = {
  title: 'Put a thread first in your list',
  body: 'Pick Add to Priority on any thread. It stays above everything else until you remove it or archive it.',
  howComputer: 'Right-click a thread, or open its ⋯ menu, and pick',
  howPhone: 'Press and hold a thread, then pick',
  item: 'Add to Priority',
  gotIt: 'Got it',
  tryIt: 'Try it',
} as const;

const noop = () => {};

/** A mouse pointer, resting on the item (Snooze's). */
function Pointer() {
  return (
    <svg className="ib-zx-pointer ib-pqi-pointer" width="16" height="22" viewBox="0 0 16 22" aria-hidden="true">
      <path d="M1 1 L1 17 L5 13.4 L7.8 20 L10.6 18.8 L7.9 12.4 L13 12.4 Z" fill="#111" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The row menu's first group as RowMenu.tsx draws it for a thread not in Priority, Add to Priority lit. On a phone only
 * Star and Add to Priority, so the picture stays no taller than Snooze's.
 */
function MenuItems({ phone }: { phone: boolean }) {
  return (
    <>
      <div className="ib-pmi">
        <Icon name="star" size={15} />
        Star thread
      </div>
      <div className="ib-pmi" data-highlighted="" data-priority-intro-item="">
        <Icon name="toTop" size={15} />
        {PRIORITY_INTRO_COPY.item}
        {!phone && <Pointer />}
      </div>
      {!phone && (
        <>
          <div className="ib-pm-sep" />
          <div className="ib-pmi">
            <Icon name="stack" size={15} />
            Copy thread
          </div>
        </>
      )}
    </>
  );
}

/** A group's header as InboxList draws it, open, with its count. */
function Band({ label, count }: { label: string; count: number }) {
  return (
    <div className="ib-band" aria-expanded="true">
      {label} <span className="ib-n">{count}</span>
    </div>
  );
}

function Row({ row, project, drawn, phone }: { row: InboxListRow; project: string; drawn: InboxListGroupId; phone: boolean }) {
  return (
    <ListRow
      row={row}
      project={project}
      away={false}
      drawn={drawn}
      shape={phone ? 'phone' : 'narrow'}
      full={false}
      filtered={false}
      selected={false}
      lit={false}
      onOpen={noop}
      day=""
      menu={false}
      pinned={false}
      pinColumn={false}
      pill={false}
      compact={phone}
    />
  );
}

export interface PriorityIntroProps {
  picture: PriorityIntroPicture;
  projectNames?: ReadonlyMap<string, string>;
  phone: boolean;
  onGotIt: () => void;
  /** Close, then open the real menu on the thread last opened. */
  onTry: () => void;
  /** Escape or a click outside: the line's Not now. */
  onDismiss: () => void;
}

export function PriorityIntro({ picture, projectNames, phone, onGotIt, onTry, onDismiss }: PriorityIntroProps) {
  const name = (row: InboxListRow) => projectNames?.get(row.project.id) ?? row.project.name;
  const { landed, below } = picture;
  return (
    <Modal labelledBy="ib-pqi-title" describedBy="ib-pqi-desc" testId="priority-intro" onClose={onDismiss} ownKeys className={`ib-lo ib-zx ib-pqi${phone ? ' ib-lo-phone' : ''}`}>
      <div className="ib-lo-art ib-pqi-art" inert aria-hidden="true" data-priority-intro-picture="">
        <div className="ib-pqi-scene">
          {phone ? (
            <div className="ib-pm-pos ib-zx-pos ib-pqi-pos" data-phone="">
              <div className="ib-pm ib-pqi-menu">
                <MenuItems phone />
              </div>
            </div>
          ) : (
            <div className="ib-pm ib-pqi-menu">
              <MenuItems phone={false} />
            </div>
          )}
          <section className={`ib-listcol${phone ? '' : ' ib-narrow'} ib-pqi-list`}>
            <div className="ib-lbody">
              <div className="ib-group" data-section-id="priority">
                <Band label="Priority" count={1} />
                <Row row={landed} project={name(landed)} drawn="priority" phone={phone} />
              </div>
              {below && !phone && (
                <div className="ib-group" data-section-id={below.row.section}>
                  <Band label={below.label} count={1} />
                  <Row row={below.row} project={name(below.row)} drawn={below.row.section} phone={phone} />
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <div className="ib-lo-text">
        <div className="ib-zx-new">New</div>
        <h2 id="ib-pqi-title">{PRIORITY_INTRO_COPY.title}</h2>
        <p id="ib-pqi-desc">{PRIORITY_INTRO_COPY.body}</p>
        <p className="ib-zx-hint">
          <span className="ib-zx-chip" aria-hidden="true">
            <Icon name="toTop" size={14} />
          </span>
          <span>
            {phone ? PRIORITY_INTRO_COPY.howPhone : PRIORITY_INTRO_COPY.howComputer} <b>{PRIORITY_INTRO_COPY.item}</b>.
          </span>
        </p>
      </div>
      <div className="ib-lo-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={onGotIt} data-priority-intro-close="">
          {PRIORITY_INTRO_COPY.gotIt}
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri" onClick={onTry} data-priority-intro-try="">
          {PRIORITY_INTRO_COPY.tryIt}
        </button>
      </div>
    </Modal>
  );
}
