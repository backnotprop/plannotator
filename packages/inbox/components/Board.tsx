/**
 * The Board (approval "inbox-board", `.product/approved/inbox-board/`, step 2):
 * the page and the open card.
 *
 *  - Five lanes, Asked · Designing · Your look · Building · Your review
 *    (COLUMNS.md, set d). Shipped and the Icebox are links in the header, not
 *    lanes; dropped cards are listed on the Icebox page under "Dropped".
 *  - Each card is variant C, "Lean": its title, then "You: …" in the person's
 *    lanes and the agent's last word otherwise, and how long ago anyone last
 *    wrote to it ("2d ago"). No amber (the owner dropped it).
 *  - An agent's drop the person has not looked at shows above the lanes,
 *    "N dropped by an agent", with each reason and a one-click Restore, until
 *    they look (Got it, or opening Dropped).
 *  - The open card shows its threads and PRs and lets the person act: move
 *    it, pause it (the Icebox, theirs only), drop it, restore it, or ask its
 *    agent where it is. Work on a card happens in its threads.
 *
 * No keyboard shortcut of its own (the owner's standing rule). On a phone the
 * lanes are one stacked list in the same order, Shipped and the Icebox folded
 * at its end.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { INBOX_CARD_COLUMN_LABELS, INBOX_SECTIONS, isInboxCardLiveColumn, type InboxCardColumn, type InboxCardWire, type InboxListRow } from '@plannotator/core/inbox-types';
import type { CardsModel } from '../api';
import {
  ageShort,
  ageWords,
  authorName,
  boardOf,
  CARD_MOVE_COLUMNS,
  cardAgentName,
  cardLine,
  type BoardLane,
  type BoardModel,
  type BoardView,
} from '../board';
import { formatCount, shortTime } from '../format';
import { HostMark, Icon } from '../icons';
import { SidebarTrigger } from '../shell/sidebar';
import { Tip } from './Tip';
import { Modal } from './Updates';

export interface BoardActions {
  onOpenCard: (card: InboxCardWire, opener: HTMLElement) => void;
  /** Resolves once the card is back (or the move failed): the button stays busy until then. */
  onRestore: (card: InboxCardWire) => Promise<unknown>;
  /** The person looked at the agents' drops the notice showed (these ids): they leave the notice. */
  onDropsSeen: (cardIds: string[]) => void;
  onView: (view: BoardView) => void;
}

/** The card's mark: its agent's, or a person's for a card the person made. */
function CardMark({ card }: { card: Pick<InboxCardWire, 'agent'> }) {
  if (!card.agent) return <span className="ib-mk ib-bcard-you" aria-hidden="true"><Icon name="compose" size={14} /></span>;
  return <HostMark host={card.agent.kind === 'agent' ? card.agent.host : null} />;
}

/** The section a linked thread sits in, as the list names it. */
function sectionLabel(row: InboxListRow): string {
  if (row.resolved_at) return 'Archived';
  return INBOX_SECTIONS.find((s) => s.id === row.section)?.label ?? '';
}

/** One card on a lane: two lines and its age; the whole card opens it. */
function BoardCard({ card, now, onOpen }: { card: InboxCardWire; now: number; onOpen: (card: InboxCardWire, opener: HTMLElement) => void }) {
  const line = cardLine(card);
  const age = ageShort(card.heard_at, now);
  const name = `${card.title}. ${line ? `${line.you ? 'You: ' : ''}${line.text}. ` : ''}Last heard ${ageWords(card.heard_at, now)}.`;
  return (
    <li className="ib-bcard-li">
      <button type="button" className="ib-bcard" data-card-id={card.id} data-column={card.column} aria-label={name} onClick={(event) => onOpen(card, event.currentTarget)}>
        <span className="ib-bcard-mk" aria-hidden="true">
          <CardMark card={card} />
        </span>
        <Tip content={card.title} cut>
          <span className="ib-bcard-t" dir="auto" aria-hidden="true">
            {card.title}
          </span>
        </Tip>
        <Tip content={line ? `${line.you ? 'You: ' : ''}${line.text}` : ''} cut>
          <span className="ib-bcard-l" dir="auto" aria-hidden="true" data-you={line?.you ? '' : undefined}>
            {line ? (
              <>
                {line.you && <b>You: </b>}
                {line.text}
              </>
            ) : (
              <span className="ib-bcard-none">No word yet</span>
            )}
          </span>
        </Tip>
        <Tip content={`Last heard ${shortTime(card.heard_at)}`}>
          <span className="ib-bcard-age" aria-hidden="true" data-card-age="">
            {age}
          </span>
        </Tip>
      </button>
    </li>
  );
}

/**
 * Restore (or Take out) in one click, busy until the answer: a double click
 * never sends the move twice.
 */
function RestoreButton({ card, label, onRestore }: { card: InboxCardWire; label: string; onRestore: BoardActions['onRestore'] }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  return (
    <button
      type="button"
      className="ib-btn ib-sm"
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={() => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        void onRestore(card).finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
      }}
      data-restore={card.id}
      aria-label={`${label} ${card.title}`}
    >
      {label}
    </button>
  );
}

/** "N dropped by an agent": each card, its agent's reason, and Restore, until the person has looked. */
export function DropNotice({ cards, now, onRestore, onSeen, onOpen, onDropped }: {
  cards: readonly InboxCardWire[];
  now: number;
  onRestore: BoardActions['onRestore'];
  onSeen: (cardIds: string[]) => void;
  onOpen: (card: InboxCardWire, opener: HTMLElement) => void;
  onDropped: () => void;
}) {
  const id = useId();
  if (cards.length === 0) return null;
  return (
    <section className="ib-dropnote" aria-labelledby={id} data-drop-notice={cards.length}>
      <div className="ib-dropnote-h">
        <Icon name="minus" size={16} />
        <h2 id={id}>{cards.length === 1 ? '1 card dropped by an agent' : `${cards.length} cards dropped by an agent`}</h2>
        <span className="ib-dropnote-sub">Restore puts a card back where it was.</span>
        <span className="ib-dropnote-acts">
          <button type="button" className="ib-btn ib-sm ib-ghost" onClick={onDropped} data-drop-notice-see="">
            See Dropped
          </button>
          <button type="button" className="ib-btn ib-sm" onClick={() => onSeen(cards.map((card) => card.id))} data-drop-notice-ok="">
            Got it
          </button>
        </span>
      </div>
      <ul className="ib-dropnote-list">
        {cards.map((card) => (
          <li key={card.id} className="ib-dropnote-row" data-drop-card={card.id}>
            <span className="ib-bcard-mk" aria-hidden="true">
              <CardMark card={card} />
            </span>
            <span className="ib-dropnote-text">
              <button type="button" className="ib-dropnote-t" dir="auto" onClick={(event) => onOpen(card, event.currentTarget)}>
                {card.title}
              </button>
              <span className="ib-dropnote-why" dir="auto">
                {card.dropped ? authorName(card.dropped.by) : 'An agent'}
                {card.dropped?.reason ? `: ${card.dropped.reason}` : ''}
              </span>
            </span>
            <span className="ib-bcard-age">{card.dropped ? ageShort(card.dropped.at, now) : ''}</span>
            <RestoreButton card={card} label="Restore" onRestore={onRestore} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One lane: its head (and "on you" for the person's) and its cards. On a phone the head folds the lane. */
function Lane({ lane, now, phone, onOpen }: { lane: BoardLane; now: number; phone: boolean; onOpen: BoardActions['onOpenCard'] }) {
  const id = useId();
  const [folded, setFolded] = useState(false);
  const head = (
    <>
      <span className="ib-lane-dot" data-column={lane.column} aria-hidden="true" />
      <span className="ib-lane-l">{lane.label}</span>
      <span className="ib-n">{formatCount(lane.cards.length)}</span>
      {lane.onYou && <span className="ib-onyou">on you</span>}
    </>
  );
  return (
    <section className="ib-lane" aria-labelledby={id} data-lane={lane.column} data-folded={folded ? '' : undefined}>
      <h2 className="ib-lane-h" id={id}>
        {phone ? (
          <button type="button" className="ib-lane-fold" aria-expanded={!folded} onClick={() => setFolded((v) => !v)}>
            {head}
            <Icon name={folded ? 'chevR' : 'chevD'} size={16} />
          </button>
        ) : (
          head
        )}
      </h2>
      {!folded && (
        <ul className="ib-lane-cards">
          {lane.cards.map((card) => (
            <BoardCard key={card.id} card={card} now={now} onOpen={onOpen} />
          ))}
          {lane.cards.length === 0 && <li className="ib-lane-empty">Nothing here</li>}
        </ul>
      )}
    </section>
  );
}

/** The header's links: Shipped and the Icebox, each with its count. */
function BoardLinks({ board, onView, phone }: { board: BoardModel; onView: (view: BoardView) => void; phone: boolean }) {
  const iceboxCount = board.icebox.length + board.dropped.length;
  return (
    <nav className={phone ? 'ib-blinks ib-blinks-foot' : 'ib-blinks'} aria-label="Shipped and paused cards">
      <button type="button" className="ib-blink" onClick={() => onView('shipped')} data-board-link="shipped">
        Shipped <span className="ib-n">{formatCount(board.shipped.length)}</span>
        {phone && <Icon name="chevR" size={16} />}
      </button>
      {!phone && <span className="ib-blinks-dot" aria-hidden="true">·</span>}
      <button type="button" className="ib-blink" onClick={() => onView('icebox')} data-board-link="icebox">
        Icebox <span className="ib-n">{formatCount(iceboxCount)}</span>
        {phone && <Icon name="chevR" size={16} />}
      </button>
    </nav>
  );
}

/** The Board's live page: the summary, the agents' drops, the five lanes. */
export function BoardPage({
  model,
  error,
  now,
  phone,
  actions,
}: {
  model: CardsModel | null;
  error: string | null;
  now: number;
  phone: boolean;
  actions: BoardActions;
}) {
  const board = boardOf(model?.cards ?? []);
  return (
    <section className="ib-board" aria-label="Board" data-board-page="live">
      <div className="ib-bhead">
        <SidebarTrigger />
        <h1 tabIndex={-1}>Board</h1>
        {model && (
          <span className="ib-bsum" data-board-sum="">
            {board.inFlight} in flight · <b>{board.onYou} on you</b>
          </span>
        )}
        {model && !phone && <BoardLinks board={board} onView={actions.onView} phone={false} />}
      </div>
      {error && <div className="ib-error ib-board-err">{error}</div>}
      {model && (
        <DropNotice
          cards={board.droppedByAgent}
          now={now}
          onRestore={actions.onRestore}
          onSeen={actions.onDropsSeen}
          onOpen={actions.onOpenCard}
          onDropped={() => actions.onView('icebox')}
        />
      )}
      {model && model.cards.length === 0 ? (
        <div className="ib-board-empty" data-board-empty="">
          <b>No cards yet.</b> When an agent takes on work that outlasts its reply (a lane started, a PR opened, something it promised to send), it puts a card here and keeps it current as the work moves.
        </div>
      ) : (
        model && (
          <div className="ib-lanes">
            {board.lanes.map((lane) => (
              <Lane key={lane.column} lane={lane} now={now} phone={phone} onOpen={actions.onOpenCard} />
            ))}
          </div>
        )
      )}
      {model && phone && model.cards.length > 0 && <BoardLinks board={board} onView={actions.onView} phone />}
    </section>
  );
}

/** A card as a row on the Shipped and Icebox pages: its two lines, a fact, and the action that page offers. */
function BoardRow({ card, now, fact, action, onOpen }: { card: InboxCardWire; now: number; fact: ReactNode; action?: ReactNode; onOpen: BoardActions['onOpenCard'] }) {
  const line = card.column === 'dropped' ? null : cardLine(card);
  return (
    <li className="ib-brow" data-card-id={card.id} data-column={card.column}>
      <span className="ib-bcard-mk" aria-hidden="true">
        <CardMark card={card} />
      </span>
      <span className="ib-brow-text">
        <button type="button" className="ib-brow-t" dir="auto" onClick={(event) => onOpen(card, event.currentTarget)}>
          {card.title}
        </button>
        {line && (
          <span className="ib-brow-l" dir="auto">
            {line.you && <b>You: </b>}
            {line.text}
          </span>
        )}
        <span className="ib-brow-fact" dir="auto">
          {fact}
        </span>
      </span>
      <span className="ib-bcard-age">{ageShort(card.column === 'dropped' ? (card.dropped?.at ?? card.moved_at) : card.moved_at, now)}</span>
      {action}
    </li>
  );
}

/** Shipped, or the Icebox with Dropped under it: the Board's header links. */
export function BoardListPage({
  view,
  model,
  error,
  now,
  phone,
  actions,
  onBack,
}: {
  view: 'shipped' | 'icebox';
  model: CardsModel | null;
  error: string | null;
  now: number;
  phone: boolean;
  actions: BoardActions;
  onBack: () => void;
}) {
  const board = boardOf(model?.cards ?? []);
  const shipped = view === 'shipped';
  return (
    <section className="ib-board ib-bpage" aria-label={shipped ? 'Shipped' : 'Icebox'} data-board-page={view}>
      <div className="ib-bhead">
        <SidebarTrigger />
        <button type="button" className="ib-pback" onClick={onBack} data-board-back="">
          <Icon name="chevL" size={16} />
          Board
        </button>
        <h1 tabIndex={-1}>{shipped ? 'Shipped' : 'Icebox'}</h1>
      </div>
      <p className="ib-dsub ib-bpage-sub">
        {shipped
          ? 'Merged or live, staging included. A re-report of something broken goes back to Asked.'
          : 'Cards you paused, and cards dropped. Only you pause a card or take one out; restoring puts a card back where it was.'}
      </p>
      {error && <div className="ib-error ib-board-err">{error}</div>}
      {shipped ? (
        <BoardGroup title="Shipped" count={board.shipped.length} empty="Nothing shipped yet." data="shipped">
          {board.shipped.map((card) => (
            <BoardRow key={card.id} card={card} now={now} onOpen={actions.onOpenCard} fact={`${cardAgentName(card)} · shipped ${shortTime(card.moved_at)}`} />
          ))}
        </BoardGroup>
      ) : (
        <>
          <BoardGroup title="Icebox" count={board.icebox.length} empty="Nothing paused." data="icebox">
            {board.icebox.map((card) => (
              <BoardRow
                key={card.id}
                card={card}
                now={now}
                onOpen={actions.onOpenCard}
                fact={`Paused ${shortTime(card.moved_at)}${card.aside_from ? ` from ${INBOX_CARD_COLUMN_LABELS[card.aside_from]}` : ''}`}
                action={<RestoreButton card={card} label="Take out" onRestore={actions.onRestore} />}
              />
            ))}
          </BoardGroup>
          <BoardGroup title="Dropped" count={board.dropped.length} empty="Nothing dropped." data="dropped">
            {board.dropped.map((card) => (
              <BoardRow
                key={card.id}
                card={card}
                now={now}
                onOpen={actions.onOpenCard}
                fact={
                  <>
                    Dropped by {card.dropped ? authorName(card.dropped.by) : 'someone'} · {card.dropped ? shortTime(card.dropped.at) : ''}
                    {card.dropped?.reason ? <span className="ib-brow-why">: {card.dropped.reason}</span> : null}
                  </>
                }
                action={<RestoreButton card={card} label="Restore" onRestore={actions.onRestore} />}
              />
            ))}
          </BoardGroup>
        </>
      )}
      {phone && <div className="ib-bpage-pad" />}
    </section>
  );
}

function BoardGroup({ title, count, empty, data, children }: { title: string; count: number; empty: string; data: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="ib-bgroup" aria-labelledby={id} data-board-group={data}>
      <h2 id={id} className="ib-bgroup-h">
        {title} <span className="ib-n">{formatCount(count)}</span>
      </h2>
      {count === 0 ? <p className="ib-bgroup-empty">{empty}</p> : <ul className="ib-brows">{children}</ul>}
    </section>
  );
}

export interface CardDialogProps {
  card: InboxCardWire;
  model: CardsModel | null;
  now: number;
  /** Whether a live session can take "Ask where this is" (the card's agent, or one in its project). */
  canAsk: boolean;
  busy: boolean;
  /** What the person's last move here did ("Paused: it is in the Icebox."), or why it failed (`error`), shown in the card. */
  note?: { text: string; error?: boolean } | null;
  /** The card's own agent has ended: who "Ask where this is" asks instead (null: its own agent, or nobody). */
  askOther?: { host: string; project: string | null } | null;
  onClose: () => void;
  onMove: (column: InboxCardColumn) => void;
  onIcebox: () => void;
  onDrop: (reason: string) => void;
  onRestore: () => void;
  onOpenThread: (threadId: string) => void;
  onAsk: () => void;
}

/** The open card: what it is, where it stands, its threads and PRs, and the person's moves. */
export function CardDialog({ card, model, now, canAsk, busy, note, askOther, onClose, onMove, onIcebox, onDrop, onRestore, onOpenThread, onAsk }: CardDialogProps) {
  const titleId = useId();
  const reasonId = useId();
  // The drop form is open for the card as it stood when Drop was pressed (its last move, `moved_at`): any move
  // since (the drop went through, a Restore, a move from elsewhere) closes it in the same render, with no effect
  // to wait for, and a card that comes back to the same column does not reopen it.
  const [dropFor, setDropFor] = useState<string | null>(null);
  const dropping = dropFor === `${card.column}@${card.moved_at}`;
  const setDropping = (open: boolean) => setDropFor(open ? `${card.column}@${card.moved_at}` : null);
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Focus starts on the card's title (read first), never on a control whose tooltip would open by itself.
  // (After the dialog opens: showModal, in Modal's own effect, focuses the first control.)
  useEffect(() => {
    const frame = requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (dropping) reasonRef.current?.focus();
  }, [dropping]);
  const dropButtonRef = useRef<HTMLButtonElement>(null);
  // The reason starts empty each time the form opens.
  useEffect(() => {
    if (!dropping) setReason('');
  }, [dropping]);
  /** Escape in the reason field steps back to the card (the form closes, the card stays), focus on Drop. */
  const leaveDropForm = () => {
    setDropping(false);
    requestAnimationFrame(() => dropButtonRef.current?.focus());
  };
  /** When the card closes and what opened it is gone (it moved lanes, or left the Board): the card on the page, else the Board's heading. */
  const fallbackFocus = () =>
    document.querySelector<HTMLElement>(`.ib-bcard[data-card-id="${CSS.escape(card.id)}"], .ib-brow[data-card-id="${CSS.escape(card.id)}"] .ib-brow-t`) ??
    document.querySelector<HTMLElement>('.ib-board .ib-bhead h1');
  const line = cardLine(card);
  const project = model?.projects?.[card.project_id] ?? null;
  const live = isInboxCardLiveColumn(card.column);
  const aside = card.column === 'icebox' || card.column === 'dropped';
  const threads = card.threads.map((id) => ({ id, row: model?.threads?.[id] ?? null }));
  const agent = cardAgentName(card);
  return (
    <Modal labelledBy={titleId} onClose={onClose} testId="card" ownKeys className="ib-cardlg" fallbackFocus={fallbackFocus}>
      <div className="ib-cd" data-open-card={card.id} data-column={card.column}>
        <div className="ib-cd-head">
          <span className="ib-cd-mk" aria-hidden="true">
            {card.agent ? <HostMark host={card.agent.kind === 'agent' ? card.agent.host : null} big /> : <span className="ib-mk ib-big"><Icon name="compose" size={17} /></span>}
          </span>
          <div className="ib-cd-titles">
            <h2 id={titleId} dir="auto" ref={headingRef} tabIndex={-1}>
              {card.title}
            </h2>
            <p className="ib-cd-meta">
              <span className="ib-cd-col" data-column={card.column}>
                <span className="ib-lane-dot" data-column={card.column} aria-hidden="true" />
                {INBOX_CARD_COLUMN_LABELS[card.column]}
              </span>
              {project && (
                <>
                  {' · '}
                  <bdi>{project.name}</bdi>
                </>
              )}
              {' · '}
              {agent}
              {' · '}
              <span data-card-age="">
                heard {ageShort(card.heard_at, now)}
                {card.heard_by.kind === 'person' ? ' from you' : ''}
              </span>
            </p>
          </div>
          <Tip content="Close">
            <button type="button" className="ib-btn ib-icon ib-ghost ib-cd-x" aria-label="Close" onClick={onClose} data-card-close="">
              <Icon name="x" />
            </button>
          </Tip>
        </div>

        {/* What the last move here did, or why it failed: said here, since a toast under the modal could not be reached. */}
        {/* Always rendered (empty until the first note), so a screen reader hears the first one too. */}
        <p className="ib-cd-done" role="status" data-card-note="" data-error={note?.error ? '' : undefined} data-empty={note ? undefined : ''}>
          {note && <Icon name={note.error ? 'warn' : 'check'} size={15} />}
          {note?.text}
        </p>

        {line && (
          <p className={`ib-cd-line${line.you ? ' ib-cd-you' : ''}`} dir="auto" data-card-line="">
            {line.you ? <b>You: </b> : <span className="ib-cd-said">{agent === 'You' ? 'Last word: ' : `${agent}: `}</span>}
            {line.text}
          </p>
        )}

        {card.column === 'dropped' && card.dropped && (
          <div className="ib-cd-state" data-card-state="dropped">
            <span>
              Dropped by {authorName(card.dropped.by)} {ageShort(card.dropped.at, now)}
              {card.dropped.reason ? (
                <>
                  : <q dir="auto">{card.dropped.reason}</q>
                </>
              ) : (
                '.'
              )}
            </span>
            <button type="button" className="ib-btn ib-sm ib-pri" onClick={onRestore} disabled={busy} data-card-restore="">
              Restore
            </button>
          </div>
        )}
        {card.column === 'icebox' && (
          <div className="ib-cd-state" data-card-state="icebox">
            <span>You paused it {ageShort(card.moved_at, now)}{card.aside_from ? `, from ${INBOX_CARD_COLUMN_LABELS[card.aside_from]}` : ''}. Its agent leaves the work alone until you take it out.</span>
            <button type="button" className="ib-btn ib-sm ib-pri" onClick={onRestore} disabled={busy} data-card-restore="">
              Take out
            </button>
          </div>
        )}

        <h3>Threads</h3>
        {threads.length === 0 ? (
          <p className="ib-cd-empty">No thread linked yet. Work on a card happens in its threads: ask its agent where it is to start one.</p>
        ) : (
          <ul className="ib-cd-threads">
            {threads.map(({ id, row }) => (
              <li key={id}>
                <button type="button" className="ib-cd-thread" onClick={() => onOpenThread(id)} data-card-thread={id}>
                  <Icon name="inbox" size={15} />
                  <span className="ib-cd-thread-s" dir="auto">
                    {row?.subject ?? '(no subject)'}
                  </span>
                  {row && <span className="ib-cd-thread-sec">{sectionLabel(row)}</span>}
                  {row && <span className="ib-bcard-age">{ageShort(row.last_at, now)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3>Pull requests</h3>
        {card.prs.length === 0 ? (
          <p className="ib-cd-empty">None linked.</p>
        ) : (
          <ul className="ib-cd-prs">
            {card.prs.map((pr) => (
              <li key={pr.ref}>
                <a href={pr.url} target="_blank" rel="noopener noreferrer" className="ib-cd-pr" data-card-pr={pr.ref}>
                  <Icon name="pr" size={15} />
                  <span dir="ltr">{pr.ref}</span>
                  <Icon name="external" size={13} />
                </a>
              </li>
            ))}
          </ul>
        )}

        {!aside && (
          <>
            <h3 id={`${titleId}-move`}>Move to</h3>
            <div className="ib-cd-move" role="group" aria-labelledby={`${titleId}-move`}>
              {CARD_MOVE_COLUMNS.map((column) => {
                const on = card.column === column;
                return (
                  <button
                    key={column}
                    type="button"
                    className={`ib-cd-mv${on ? ' ib-on' : ''}`}
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => !on && onMove(column)}
                    data-card-move={column}
                  >
                    <span className="ib-lane-dot" data-column={column} aria-hidden="true" />
                    {INBOX_CARD_COLUMN_LABELS[column]}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {dropping ? (
          <form
            className="ib-cd-drop"
            data-card-drop-form=""
            onSubmit={(event) => {
              event.preventDefault();
              onDrop(reason.trim());
            }}
          >
            <label htmlFor={reasonId}>Why drop it? (optional)</label>
            <input
              id={reasonId}
              ref={reasonRef}
              type="text"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                leaveDropForm();
              }}
              placeholder="Not needed any more"
            />
            <div className="ib-cd-acts">
              <button type="button" className="ib-btn" onClick={leaveDropForm}>
                Cancel
              </button>
              <button type="submit" className="ib-btn ib-danger" disabled={busy} data-card-drop-confirm="">
                Drop card
              </button>
            </div>
          </form>
        ) : (
          <div className="ib-cd-acts">
            {live || card.column === 'shipped' ? (
              <>
                <button type="button" className="ib-btn" onClick={onAsk} disabled={!canAsk} data-card-ask="">
                  <Icon name="comment" size={15} />
                  Ask where this is
                </button>
                <span className="ib-cd-gap" />
                {live && (
                  <button type="button" className="ib-btn" onClick={onIcebox} disabled={busy} data-card-icebox="">
                    <Icon name="pause" size={15} />
                    Pause
                  </button>
                )}
                <button type="button" className="ib-btn" ref={dropButtonRef} onClick={() => setDropping(true)} disabled={busy} data-card-drop="">
                  <Icon name="trash" size={15} />
                  Drop
                </button>
              </>
            ) : null}
          </div>
        )}
        {(live || card.column === 'shipped') && canAsk && askOther && !dropping && (
          <p className="ib-cd-note" data-card-ask-other="">
            Its agent's session ended; this asks another {askOther.host} session in {askOther.project ? <bdi>{askOther.project}</bdi> : 'its project'}.
          </p>
        )}
        {(live || card.column === 'shipped') && !canAsk && !dropping && (
          <p className="ib-cd-note" data-card-ask-note="">No agent is running in {project ? <bdi>{project.name}</bdi> : 'this project'} now, so there is no one to ask.</p>
        )}
        <p className="ib-cd-foot">
          Made {shortTime(card.created_at)} by {card.created_by.kind === 'person' ? 'you' : authorName(card.created_by)}
        </p>
      </div>
    </Modal>
  );
}
