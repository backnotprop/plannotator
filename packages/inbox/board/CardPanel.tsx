import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_LIVE_COLUMNS,
  INBOX_CARD_NOTES_MAX,
  INBOX_CARD_REASON_MAX,
  INBOX_SECTIONS,
  inboxAgentName,
  inboxCardLinkLabel,
  inboxCardRefIsLinkOnly,
  inboxCardRefsOf,
  type InboxCardColumn,
  type InboxCardHistoryEntry,
  type InboxCardRef,
  type InboxCardWire,
  type InboxInitiative,
  type InboxListRow,
} from '@plannotator/core/inbox-types';
import type { InboxProjectRepo } from '@plannotator/core/inbox-types';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { checksText, useRefHoverCards } from '@plannotator/ui/components/RefHoverCard';
import { fullTime, whenTime } from '../format';
import { AuthorMark, Icon } from '../icons';
import { Tip } from '../components/Tip';
import { inboxUrl } from '../inboxUrl';
import { useInboxTextSize } from '../textSize';
import { clearCardTop, fitCardTop } from './cardTopFit';
import { OnceButton } from './OnceButton';
import { RefMarkIcon } from './RefMark';
import { CardInitiativeMenu } from './BoardFilter';
import { cardAge, cardFoot, cardYou, columnChoices, historyWords, refState, sentTo, youThread } from './model';

export interface CardPanelProps {
  card: InboxCardWire;
  history: InboxCardHistoryEntry[] | null;
  /** The card's links resolved (null while they are read; a failure keeps the reference quiet). */
  refs: { ref: InboxCardRef; result: ForgeRefCardResult }[] | null;
  projectName: string;
  /** The card's own project's repo: bare `#123` in its text links there (null: unknown, or not read yet). */
  repo?: InboxProjectRepo | null;
  /** The agent's session now: working, idle, ended (not live), or unknown (null: no agent, or not read yet). */
  state: 'working' | 'idle' | 'ended' | null;
  /** Whether "Ask for an update" and "Create thread" have a live session to go to (the card's agent, else one in its project). */
  canAsk: boolean;
  /** Said with "Ask for an update" when it goes to another session (the card's own agent ended). */
  askNote?: string | null;
  rowOf: (threadId: string) => InboxListRow | null;
  phone: boolean;
  now: number;
  onClose: () => void;
  onColumn: (column: InboxCardColumn) => void;
  onShip: () => void;
  onRestore: () => unknown;
  /** `fromMenu`: the reason field was opened by Drop… on the card's right-click menu (and not closed since). */
  onDrop: (reason: string | null, fromMenu: boolean) => void;
  /**
   * Drop… from the card's right-click menu, a new number each time (0: never): the reason field opens and
   * takes focus (over the title, when the card opens for it).
   */
  dropAsk?: number;
  onSend: () => void;
  /** Start: tell the card's agent (or a live session in its project) to begin; an error to say, or null. */
  onStart: () => Promise<string | null>;
  onAsk: () => Promise<string | null>;
  onNotes: (notes: string | null) => Promise<boolean>;
  onLink: (ref: string) => Promise<string | null>;
  onOpenThread: (threadId: string) => void;
  /** Create thread (a card with no thread): compose to the card's agent (or a live session in its project); the Send links the thread. */
  onCreateThread: (opener: HTMLElement) => void;
  /**
   * The Board's initiatives, deleted ones too (approval "board-initiatives"): the history names them, and
   * the who line's menu offers the live ones. Absent or none live: no menu (unless the card is in one).
   */
  initiatives?: readonly InboxInitiative[];
  onInitiative?: (initiative: string | null) => void;
}

/**
 * The opened card (approval "inbox-board", step 2, as mocked; amended
 * 2026-10-27): a panel beside the Board (a full screen with "‹ Board" on a
 * phone). Its top: the column as its Move menu, then **Open thread** (the
 * thread where the person makes the call, `youThread`; primary while they owe
 * something) or, with no thread linked, **Create thread** (owner: "create,
 * create, create is the idea"). Then the agent, the project and whether the
 * agent is working; the "You: …" band; notes; threads (a click opens the
 * thread in the Inbox, with a way back); links (PRs, issues), their live
 * state read when the card opens and never acted on; history, with a quiet
 * "Ask for an update"; and at the foot Mark done · Cancel… (with a reason),
 * Send to an agent for a Backlog or Todo card nobody was asked about,
 * Restore on a Cancelled card.
 */
export function CardPanel(props: CardPanelProps) {
  const { card, phone } = props;
  const headingId = useId();
  const [dropping, setDropping] = useState(!!props.dropAsk);
  /** The reason field open now came from the right-click menu's Drop…. */
  const dropFromMenu = useRef(!!props.dropAsk);
  const [reason, setReason] = useState('');
  const [said, setSaid] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const reasonField = useRef<HTMLInputElement>(null);
  // Focus goes into the panel when a card opens (another card: the new one's title), unless it opened for Drop….
  useEffect(() => {
    if (!dropFromMenu.current) heading.current?.focus();
  }, [card.id]);
  // Drop… from the right-click menu on the card already open: its reason field opens (or is already) and takes focus.
  useEffect(() => {
    if (!props.dropAsk) return;
    dropFromMenu.current = true;
    setDropping(true);
    reasonField.current?.focus();
  }, [props.dropAsk]);
  const stopDropping = () => {
    dropFromMenu.current = false;
    setDropping(false);
  };
  // The card's words (You, notes, what was said) render as a thread message's
  // do: refs and URLs link, with hover cards on issue and PR links.
  const body = useRef<HTMLDivElement>(null);
  const refCard = useRefHoverCards(body);
  const text = (words: string) => <CardText text={words} repo={props.repo ?? null} />;
  const foot = cardFoot(card);
  const sent = sentTo(card);
  const refs = inboxCardRefsOf(card);
  const agent = card.agent?.kind === 'agent' ? card.agent : null;
  const liveInitiatives = (props.initiatives ?? []).filter((i) => i.deleted_at === null);
  const notSent = card.column === 'backlog' && !agent && !card.sent;
  // What the person owes, and the thread where they make that call (the lane card's "You: …" goes there too).
  const you = cardYou(card);
  const threadAt = youThread(card, props.rowOf);
  const live = card.column !== 'dropped' && card.column !== 'done';
  const askable = (agent !== null || props.canAsk) && live;
  // Create thread: a card that links no thread, unless it is dropped (nothing is said about a dropped card).
  const creatable = threadAt === null && card.column !== 'dropped' && (agent !== null || props.canAsk);
  // A phone's top bar gives way so it stays on one line (cardTopFit.ts): the thread action's icon alone, then the way back's chevron alone.
  const topRef = useRef<HTMLDivElement>(null);
  const textSize = useInboxTextSize();
  const topSig = [phone, card.column, sent !== null, threadAt, creatable, you !== null, textSize].join('|');
  const topFittedFor = useRef('');
  const fitTopRef = useRef<(force?: boolean) => void>(() => {});
  fitTopRef.current = (force = false) => {
    const top = topRef.current;
    if (!top) return;
    const key = `${top.getBoundingClientRect().width}|${topSig}`;
    if (!force && key === topFittedFor.current) return;
    topFittedFor.current = key;
    if (phone) fitCardTop(top);
    else clearCardTop(top);
  };
  useLayoutEffect(() => fitTopRef.current());
  useEffect(() => {
    const top = topRef.current;
    if (!top || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitTopRef.current());
    observer.observe(top);
    // Words measured in a fallback font fit differently once the real one loads.
    void document.fonts?.ready.then(() => fitTopRef.current(true));
    return () => observer.disconnect();
  }, []);
  return (
    <aside
      className={`ib-crdp${phone ? ' ib-crdp-phone' : ''}`}
      aria-labelledby={headingId}
      data-card-panel={card.id}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !dropping) {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="ib-crdp-top" ref={topRef}>
        {phone && (
          <button type="button" className="ib-bback" onClick={props.onClose} data-card-back="">
            <Icon name="chevL" size={16} />
            <span className="ib-bback-l">Board</span>
          </button>
        )}
        <ColumnMenu card={card} sent={sent !== null} onColumn={props.onColumn} onRestore={props.onRestore} />
        {threadAt ? (
          <Tip content={props.rowOf(threadAt)?.subject ?? 'The card’s thread'}>
            <button
              type="button"
              className={`ib-btn ib-sm ib-crdp-open${you ? ' ib-pri' : ''}`}
              data-card-open-thread={threadAt}
              // Named by its words, "Open thread" (WCAG 2.5.3); what the person owes describes it.
              aria-describedby={you ? `${headingId}-you` : undefined}
              onClick={() => props.onOpenThread(threadAt)}
            >
              <span className="ib-crdp-open-l">Open thread</span>
              <Icon name="arrowUpRight" size={14} />
            </button>
          </Tip>
        ) : creatable ? (
          <CreateThreadButton primary={you !== null} disabled={!props.canAsk} onCreate={props.onCreateThread} />
        ) : null}
        {!phone && (
          <Tip content="Close">
            <button type="button" className="ib-crdp-x" aria-label="Close the card" onClick={props.onClose} data-card-close="">
              <Icon name="x" size={16} />
            </button>
          </Tip>
        )}
      </div>
      {refCard}
      <div className="ib-crdp-body" ref={body}>
        <h2 id={headingId} ref={heading} tabIndex={-1} dir="auto" className="ib-crdp-h">
          {card.title}
        </h2>
        <div className="ib-crdp-who">
          {agent ? (
            <>
              <AuthorMark author={agent} />
              <b>{inboxAgentName(agent)}</b>
              <span className="ib-tdot" aria-hidden="true" />
              <span dir="auto">{props.projectName}</span>
              {props.state && (
                <>
                  <span className="ib-tdot" aria-hidden="true" />
                  <span className="ib-crdp-state" data-agent-state={props.state}>
                    <span className="ib-crdp-sdot" aria-hidden="true" />
                    {props.state}
                  </span>
                </>
              )}
            </>
          ) : (
            <>
              <Icon name="folder" size={15} />
              <span dir="auto">{props.projectName}</span>
              {notSent && (
                <>
                  <span className="ib-tdot" aria-hidden="true" />
                  <span>Not sent</span>
                </>
              )}
            </>
          )}
          {props.onInitiative && card.column !== 'dropped' && (liveInitiatives.length > 0 || card.initiative) && (
            <>
              <span className="ib-tdot" aria-hidden="true" />
              <CardInitiativeMenu initiatives={liveInitiatives} value={card.initiative ?? null} onPick={props.onInitiative} />
            </>
          )}
        </div>
        {you && (
          <p className="ib-crdp-you" data-card-you="" id={`${headingId}-you`}>
            <b>You:</b> {text(you)}
          </p>
        )}
        {card.column === 'dropped' && card.dropped && (
          <p className="ib-crdp-dropped">
            Cancelled {whenTime(card.dropped.at)} by {card.dropped.by.kind === 'person' ? 'you' : inboxAgentName(card.dropped.by)}
            {card.dropped.reason ? `: ${card.dropped.reason}` : ''}
          </p>
        )}
        <Notes card={card} onSave={props.onNotes} text={text} />
        {card.threads.length > 0 && (
          <section className="ib-crdp-sec" aria-label="Threads">
            <h3>
              Threads <span className="ib-lane-n">{card.threads.length}</span>
            </h3>
            <ul className="ib-crdp-threads">
              {card.threads.map((threadId) => (
                <ThreadRow key={threadId} threadId={threadId} row={props.rowOf(threadId)} sent={card.sent?.thread_id === threadId} now={props.now} onOpen={() => props.onOpenThread(threadId)} />
              ))}
            </ul>
          </section>
        )}
        <section className="ib-crdp-sec" aria-label="Links">
          <h3>
            Links {refs.length > 0 && <span className="ib-lane-n">{refs.length}</span>}
          </h3>
          {refs.length > 0 && (
            <ul className="ib-crdp-refs">
              {refs.map((ref) => (
                <RefRow key={ref.url} cardId={card.id} refItem={ref} resolved={props.refs?.find((r) => r.ref.url === ref.url)?.result ?? null} loading={props.refs === null} />
              ))}
            </ul>
          )}
          <LinkField onLink={props.onLink} phone={props.phone} />
        </section>
        <section className="ib-crdp-sec" aria-label="History">
          <h3 className="ib-crdp-hhead">
            History
            {askable && (
              <AskButton
                disabled={!props.canAsk}
                note={props.canAsk ? (props.askNote ?? null) : null}
                agentName={agent ? inboxAgentName(agent) : 'an agent'}
                onAsk={async () => {
                  const failed = await props.onAsk();
                  setSaid(failed ?? `Asked ${agent ? inboxAgentName(agent) : 'an agent'} for an update on “${card.title}”.`);
                }}
              />
            )}
          </h3>
          {props.history === null ? (
            <p className="ib-lane-empty">Reading…</p>
          ) : (
            <ol className="ib-crdp-hist">
              {props.history.map((entry, index) => {
                const words = historyWords(entry, (id) => props.initiatives?.find((i) => i.id === id)?.name ?? null);
                return (
                  <li key={`${entry.at}-${index}`}>
                    <span className="ib-crdp-hdot" aria-hidden="true" />
                    <span className="ib-crdp-ht">
                      {words.before}
                      {words.bold && <b dir="auto">{words.bold}</b>}
                      {words.after}
                      {words.quote && (
                        <span className="ib-crdp-hq" dir="auto">
                          {text(words.quote)}
                        </span>
                      )}
                    </span>
                    <Tip content={fullTime(entry.at)}>
                      <span className="ib-crdp-hat">{cardAge(entry.at, props.now).short.replace(' ago', '')}</span>
                    </Tip>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
      {dropping ? (
        <form
          className="ib-crdp-foot ib-crdp-drop"
          onSubmit={(event) => {
            event.preventDefault();
            const fromMenu = dropFromMenu.current;
            stopDropping();
            props.onDrop(reason.replace(/\s+/g, ' ').trim() || null, fromMenu);
          }}
        >
          <label htmlFor={`${headingId}-reason`} dir="auto">
            Cancel “{card.title}”
          </label>
          <input
            id={`${headingId}-reason`}
            type="text"
            placeholder="Why (optional)"
            value={reason}
            maxLength={INBOX_CARD_REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
            ref={reasonField}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                stopDropping();
              }
            }}
            data-drop-reason=""
          />
          <div className="ib-crdp-dropacts">
            <button type="button" className="ib-btn ib-ghost" onClick={stopDropping}>
              Keep
            </button>
            <button type="submit" className="ib-btn ib-danger" data-drop-confirm="">
              <Icon name="xCircle" size={15} />
              Cancel card
            </button>
          </div>
        </form>
      ) : (
        <div className="ib-crdp-foot">
          {foot.primary === 'send' && (
            <button type="button" className="ib-btn ib-pri" onClick={props.onSend} data-card-send="">
              <Icon name="send" size={15} />
              Send to an agent
            </button>
          )}
          {foot.primary === 'start' && (
            <StartButton
              disabled={!props.canAsk}
              onStart={async () => {
                const failed = await props.onStart();
                setSaid(failed ?? `Asked ${agent ? inboxAgentName(agent) : 'an agent'} to start “${card.title}”.`);
              }}
            />
          )}
          {foot.primary === 'ship' && (
            <button type="button" className="ib-btn ib-soft" onClick={props.onShip} data-card-ship="">
              <Icon name="checkCircle" size={15} />
              Mark done
            </button>
          )}
          {foot.primary === 'restore' && (
            <OnceButton className="ib-btn ib-soft" onClick={props.onRestore} data-card-restore={card.id}>
              <Icon name="replay" size={15} />
              Restore to {INBOX_CARD_COLUMN_LABELS[card.aside_from ?? 'backlog']}
            </OnceButton>
          )}
          <span className="ib-bsp" />
          {foot.drop && (
            <button type="button" className="ib-btn ib-ghost" onClick={() => {
                // The foot's own Drop…: a move from the opened card, never the menu's (no toast).
                dropFromMenu.current = false;
                setDropping(true);
              }}
              data-card-drop=""
            >
              <Icon name="xCircle" size={15} />
              Cancel…
            </button>
          )}
        </div>
      )}
      <div className="ib-sr" aria-live="polite">
        {said}
      </div>
    </aside>
  );
}

/** The card's column, as a Move menu: the live lanes (its own checked), then Done; Restore when it is Cancelled. */
function ColumnMenu({ card, sent, onColumn, onRestore }: { card: InboxCardWire; sent: boolean; onColumn: (column: InboxCardColumn) => void; onRestore: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const choices = columnChoices(card);
  const aside = card.column === 'dropped';
  const lanes = INBOX_CARD_LIVE_COLUMNS.length;
  return (
    <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
      <Menu.Trigger ref={trigger} className="ib-crdp-col" aria-label={`Column: ${INBOX_CARD_COLUMN_LABELS[card.column]}${sent ? ', sent' : ''}. Move`} data-card-column={card.column}>
        <span className="ib-lane-dot" data-col={card.column} aria-hidden="true" />
        <b className="ib-crdp-col-l">{INBOX_CARD_COLUMN_LABELS[card.column]}</b>
        {sent && <span className="ib-crdp-colsent">· sent</span>}
        <Icon name="chevD" size={14} />
      </Menu.Trigger>
      <Menu.Portal container={portal ?? undefined}>
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4}>
          <Menu.Popup className="ib-pm" aria-label="Move the card" data-card-menu={card.id}>
            {aside && (
              <>
                <Menu.Item className="ib-pmi" label="Restore" onClick={onRestore} data-card-action="restore">
                  <Icon name="replay" size={15} />
                  Restore to {INBOX_CARD_COLUMN_LABELS[card.aside_from ?? 'backlog']}
                </Menu.Item>
                <Menu.Separator className="ib-pm-sep" />
              </>
            )}
            {/* One choice, so radio items: a screen reader hears the card's column as checked. */}
            <Menu.RadioGroup value={card.column} onValueChange={(value: InboxCardColumn) => value !== card.column && onColumn(value)} aria-label="Column">
              {choices.slice(0, lanes).map((choice) => (
                <Menu.RadioItem key={choice.column} value={choice.column} closeOnClick className="ib-pmi" label={choice.label} data-card-move-to={choice.column}>
                  <span className="ib-lane-dot" data-col={choice.column} aria-hidden="true" />
                  {choice.label}
                  {choice.current && <Icon name="check" size={15} className="ib-pmi-check" />}
                </Menu.RadioItem>
              ))}
              <Menu.Separator className="ib-pm-sep" />
              {choices.slice(lanes).map((choice) => (
                <Menu.RadioItem key={choice.column} value={choice.column} closeOnClick className="ib-pmi" label={choice.label} data-card-move-to={choice.column}>
                  <Icon name="checkCircle" size={15} />
                  {choice.label}
                  {choice.current && <Icon name="check" size={15} className="ib-pmi-check" />}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function StartButton({ disabled, onStart }: { disabled: boolean; onStart: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const button = (
    <button
      type="button"
      className="ib-btn ib-pri"
      disabled={disabled || busy}
      data-card-start=""
      onClick={async () => {
        setBusy(true);
        await onStart();
        setBusy(false);
      }}
    >
      <Icon name="play" size={15} />
      Start
    </button>
  );
  return disabled ? <Tip content="No agent is running in this project.">{button}</Tip> : button;
}

/**
 * "Ask for an update" (approved 2026-10-27, mock opened-B; was "Ask where
 * this is"): a quiet link by History, where the answer shows. Its tooltip
 * says who it asks (another session when the card's own agent ended).
 */
function AskButton({ disabled, note, agentName, onAsk }: { disabled: boolean; note: string | null; agentName: string; onAsk: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Tip content={disabled ? 'No agent is running in this project.' : (note ?? `Asks ${agentName} to move the card or say where it stands`)}>
      <button
        type="button"
        className="ib-crdp-ask"
        disabled={disabled || busy}
        data-card-ask=""
        data-card-ask-other={note ? '' : undefined}
        onClick={async () => {
          setBusy(true);
          await onAsk();
          setBusy(false);
        }}
      >
        Ask for an update
      </button>
    </Tip>
  );
}

/** Create thread: a card that links no thread starts one, in compose, to its agent; the Send links it to the card. */
function CreateThreadButton({ primary, disabled, onCreate }: { primary: boolean; disabled: boolean; onCreate: (opener: HTMLElement) => void }) {
  return (
    <Tip content={disabled ? 'No agent is running in this project.' : 'A new thread to the card’s agent, linked to this card'}>
      <button
        type="button"
        className={`ib-btn ib-sm ib-crdp-open${primary ? ' ib-pri' : ''}`}
        disabled={disabled}
        data-card-create-thread=""
        onClick={(event) => onCreate(event.currentTarget)}
      >
        <Icon name="plus" size={14} />
        <span className="ib-crdp-open-l">Create thread</span>
      </button>
    </Tip>
  );
}

/** The person's notes: shown, and edited in place (Save keeps them; empty clears them). */
function Notes({ card, onSave, text: render }: { card: InboxCardWire; onSave: (notes: string | null) => Promise<boolean>; text: (words: string) => ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(card.notes ?? '');
  const [failed, setFailed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!editing) setText(card.notes ?? '');
  }, [card.notes, editing]);
  useEffect(() => {
    if (editing) area.current?.focus();
  }, [editing]);
  if (editing) {
    return (
      <form
        className="ib-crdp-notesform"
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await onSave(text.trim() || null);
          setFailed(!ok);
          if (ok) {
            setEditing(false);
            requestAnimationFrame(() => edit.current?.focus());
          }
        }}
      >
        <label className="ib-sr" htmlFor={`ib-notes-${card.id}`}>
          Notes
        </label>
        <textarea
          id={`ib-notes-${card.id}`}
          ref={area}
          value={text}
          rows={5}
          maxLength={INBOX_CARD_NOTES_MAX}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            }
          }}
          data-card-notes-field=""
        />
        {failed && (
          <p className="ib-error" role="alert">
            The notes were not saved. Try again.
          </p>
        )}
        <div className="ib-crdp-notesacts">
          <button type="button" className="ib-btn ib-ghost ib-sm" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <button type="submit" className="ib-btn ib-pri ib-sm" data-card-notes-save="">
            Save
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="ib-crdp-notes" data-card-notes="">
      {card.notes ? (
        card.notes.split(/\n{2,}/).map((para, index) => (
          <p key={index} dir="auto">
            {render(para)}
          </p>
        ))
      ) : (
        <p className="ib-crdp-nonotes">No notes.</p>
      )}
      <button ref={edit} type="button" className="ib-lnk" onClick={() => setEditing(true)} data-card-notes-edit="">
        {card.notes ? 'Edit notes' : 'Add notes'}
      </button>
    </div>
  );
}

function ThreadRow({ threadId, row, sent, now, onOpen }: { threadId: string; row: InboxListRow | null; sent: boolean; now: number; onOpen: () => void }) {
  const subject = row?.subject ?? 'A thread';
  const section = row ? (INBOX_SECTIONS.find((s) => s.id === row.section)?.label ?? null) : null;
  const waiting = row ? row.section === 'stopped' || row.section === 'holding' || row.section === 'waiting' : false;
  return (
    <li>
      <button type="button" className="ib-crdp-thread" onClick={onOpen} data-card-thread={threadId} aria-label={`Open the thread “${subject}”${section ? `, ${section}` : ''}`}>
        <span className="ib-crdp-tt" dir="auto">
          {subject}
        </span>
        <span className="ib-crdp-tm">
          {row?.thread_name && <span className="ib-key">{row.thread_name}</span>}
          {sent && !waiting ? <span>Sent</span> : section && <span className={waiting ? 'ib-crdp-wait' : undefined}>{section === 'Quiet' ? 'Read' : section}</span>}
          {row && <span>· {row.message_count === 1 ? '1 message' : `${row.message_count} messages`}</span>}
        </span>
        {row && <span className="ib-crdp-tat">{cardAge(row.last_at, now).short.replace(' ago', '')}</span>}
      </button>
    </li>
  );
}

/** What a link-only source's key is called, for its link's accessible name. */
const LINK_ONLY_KIND: Record<string, string> = { jira: 'Jira issue', youtrack: 'YouTrack issue', web: 'Link' };

/** One link: its number and, once read, its title and live state (open, draft, checks, merged or closed, with dates). */
function RefRow({ cardId, refItem, resolved, loading }: { cardId: string; refItem: InboxCardRef; resolved: ForgeRefCardResult | null; loading: boolean }) {
  const data = resolved?.ok ? resolved.data : null;
  const state = data ? refState(data) : null;
  // A link-only source (a Jira or YouTrack issue, any web link): the key or label links, beside the source's mark; no state is read.
  const linkOnly = inboxCardRefIsLinkOnly(refItem);
  const web = refItem.source === 'web';
  const kind = LINK_ONLY_KIND[refItem.source] ?? (refItem.kind === 'pr' ? 'Pull request' : refItem.kind === 'issue' ? 'Issue' : refItem.kind);
  // A web link reads as its short label (host and path, cut in the middle), drawn from the URL.
  const number = web ? inboxCardLinkLabel(refItem.url) : refItem.ref.replace(/^.*?(?=[#!]\d+$)/, '');
  const link = (
    <a
      href={refItem.url}
      target="_blank"
      rel="noreferrer noopener"
      className={web ? 'ib-crdp-rn ib-crdp-rweb' : 'ib-crdp-rn'}
      dir={web ? 'ltr' : undefined}
      aria-label={web ? `${kind} ${number}` : `${kind} ${refItem.ref}${data ? `: ${data.title}` : ''}`}
    >
      {number}
    </a>
  );
  return (
    <li className="ib-crdp-ref" data-card-ref={refItem.ref} data-ref-source={refItem.source} data-ref-state={state?.tone ?? (linkOnly ? 'quiet' : loading ? 'loading' : 'quiet')}>
      {linkOnly ? (
        refItem.source === 'jira' ? <JiraMark /> : refItem.source === 'youtrack' ? <YouTrackMark /> : <LinkFavicon src={cardLinkFaviconUrl(cardId, refItem)} />
      ) : (
        <RefMarkIcon kind={refItem.kind === 'issue' ? 'issue' : 'pr'} state={data ? data.state : 'unknown'} size={15} />
      )}
      {/* A link-only ref has no hover card: its tooltip says where the key goes. */}
      {linkOnly ? <Tip content={<UrlTip url={refItem.url} />}>{link}</Tip> : link}
      {/* A web link's label already names its site; a tracker's key is followed by its site. */}
      {!web && (
        <span className="ib-crdp-rt" dir="auto">
          {data ? data.title : <span className="ib-crdp-rref">{linkOnly ? siteOf(refItem.url) : refItem.ref}</span>}
        </span>
      )}
      {state && (
        <span className="ib-crdp-rs" data-tone={state.tone}>
          {state.label}
          {data?.pull?.checks && state.tone === 'open' && <> · {checksText(data.pull.checks, data.platform)}</>}
        </span>
      )}
    </li>
  );
}

/**
 * The Jira mark (Simple Icons `jira`, CC0-1.0), one colour in currentColor as
 * the forge marks beside it are. Drawn in a 15 px box like them, with a
 * little room around it: the mark fills its square, an Octicon does not.
 */
const JIRA_MARK =
  'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z';

function JiraMark() {
  return (
    <svg className="ib-refmark ib-crdp-rjira" data-ref-mark="jira" width={15} height={15} viewBox="-1.5 -1.5 27 27" aria-hidden="true" focusable="false">
      <path fill="currentColor" d={JIRA_MARK} />
    </svg>
  );
}

/**
 * The YouTrack mark, one colour in currentColor like Jira's: the black square
 * of JetBrains' own YouTrack product icon with its "YT" and bar cut out, the
 * gradient behind it dropped. Source: JetBrains' YouTrack_icon.svg
 * (resources.jetbrains.com/storage/products/company/brand/logos/). YouTrack
 * and its icon are JetBrains trademarks, used here only to name the product;
 * not CC0 (Simple Icons has no `youtrack` icon: simple-icons#14456 waits on
 * JetBrains' permission). The square fills its box, so it gets the same room
 * around it as Jira's mark.
 */
const YOUTRACK_MARK =
  'M12 12h40v40H12ZM21.4666 26.3709l-5.4881-9.3787h3.1513l3.3981 5.9919.3969.8575.3968-.8682 3.3119-5.9812h3.0975l-5.4025 9.3575v5.6487h-2.8619v-5.6275ZM33 43.9984H17v3h16v-3ZM42.3248 16.9922H30.2879l-.0006 2.6369h4.5662v12.3693h2.9263V19.6291h4.545v-2.6369Z';

function YouTrackMark() {
  return (
    <svg className="ib-refmark ib-crdp-rjira" data-ref-mark="youtrack" width={15} height={15} viewBox="9.5 9.5 45 45" aria-hidden="true" focusable="false">
      <path fill="currentColor" fillRule="evenodd" d={YOUTRACK_MARK} />
    </svg>
  );
}

/**
 * Where a web link's favicon is read (the owner's answer, 2026-11-02): the
 * Inbox's own route, which fetches `https://<host>/favicon.ico` for a link
 * the person added and serves it from this origin. Null (the link icon
 * alone, nothing asked) for an agent's link, an http link, and a host that
 * is an IP address, `localhost` or one label: the server refuses those, so
 * the window does not ask.
 */
export function cardLinkFaviconUrl(cardId: string, ref: InboxCardRef): string | null {
  if (ref.source !== 'web' || ref.by !== 'person') return null;
  let host: string;
  try {
    const url = new URL(ref.url);
    if (url.protocol !== 'https:') return null;
    host = url.hostname;
  } catch {
    return null;
  }
  if (!host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host) || host === 'localhost' || host.endsWith('.localhost')) return null;
  return inboxUrl(`/cards/${encodeURIComponent(cardId)}/favicon`, `url=${encodeURIComponent(ref.url)}`);
}

/** Favicon addresses that failed or drew nothing in this window, so a row drawn again never asks twice. */
const failedFavicons = new Set<string>();

/**
 * A web link's mark: the generic link icon, drawn at once and kept while a
 * favicon (`src`) loads; the favicon takes its place only once it has loaded
 * with a real size (more than 1 px each way), so a failed, empty or 1×1
 * image never shows, and nothing moves: both sit in the same 15 px box.
 * `src` is the Inbox's own route (`cardLinkFaviconUrl`): the window's CSP
 * (`img-src 'self' data: blob:`) never loads a remote site's icon itself.
 * Null draws the link icon alone.
 */
export function LinkFavicon({ src }: { src: string | null }) {
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(() => (src ? failedFavicons.has(src) : false));
  useEffect(() => {
    setShown(false);
    setFailed(src ? failedFavicons.has(src) : false);
  }, [src]);
  const fail = () => {
    if (src) failedFavicons.add(src);
    setFailed(true);
  };
  const tryImage = src !== null && !failed;
  return (
    <span className="ib-refmark ib-crdp-rfav" data-ref-mark="web" data-favicon={tryImage ? (shown ? 'shown' : 'loading') : 'none'} aria-hidden="true">
      {!shown && <Icon name="link" size={15} className="ib-crdp-rlink" />}
      {tryImage && (
        <img
          src={src}
          alt=""
          width={15}
          height={15}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          draggable={false}
          data-shown={shown ? '' : undefined}
          onLoad={(event) => {
            const img = event.currentTarget;
            if (img.naturalWidth > 1 && img.naturalHeight > 1) setShown(true);
            else fail();
          }}
          onError={fail}
        />
      )}
    </span>
  );
}

/** A URL in a tooltip: it may wrap after a `/`, never inside a segment (the key). */
function UrlTip({ url }: { url: string }) {
  const parts = url.split('/').map((part, i, all) => (i < all.length - 1 ? `${part}/` : part));
  return (
    <span className="ib-tip-url">
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </span>
  );
}

/** A link's host (`example.atlassian.net`), or the URL as written when it does not parse. */
function siteOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A line of the card's words, through the same inline markdown as a thread
 * message: a bare `#123` links into the card's project's repo, `owner/repo#123`
 * and full URLs link as written. The lane cards keep plain text.
 */
function CardText({ text, repo }: { text: string; repo: InboxProjectRepo | null }) {
  return <InlineMarkdown text={text} githubRepo={repo?.display} repoHost={repo?.host ?? undefined} />;
}

/** Link an issue or PR from the opened card. */
function LinkField({ onLink, phone }: { onLink: (ref: string) => Promise<string | null>; phone: boolean }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="ib-crdp-link"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!text.trim()) return;
        const failed = await onLink(text.trim());
        setError(failed);
        if (!failed) setText('');
      }}
    >
      <label className="ib-sr" htmlFor="ib-card-link">
        Add a link
      </label>
      <input
        id="ib-card-link"
        type="text"
        // Any web link, or GitHub's owner/repo#123; a phone's narrow field keeps the short form whole.
        placeholder={phone ? 'Paste a link' : 'Paste a link, or owner/repo#123'}
        value={text} onChange={(event) => setText(event.target.value)} data-card-link-field="" />
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
