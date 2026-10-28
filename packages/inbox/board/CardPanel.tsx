import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_NOTES_MAX,
  INBOX_CARD_REASON_MAX,
  INBOX_SECTIONS,
  inboxAgentName,
  inboxCardRefsOf,
  type InboxCardColumn,
  type InboxCardHistoryEntry,
  type InboxCardRef,
  type InboxCardWire,
  type InboxListRow,
} from '@plannotator/core/inbox-types';
import type { InboxProjectRepo } from '@plannotator/core/inbox-types';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { checksText, useRefHoverCards } from '@plannotator/ui/components/RefHoverCard';
import { fullTime, whenTime } from '../format';
import { AuthorMark, Icon } from '../icons';
import { Tip } from '../components/Tip';
import { OnceButton } from './OnceButton';
import { RefMarkIcon } from './RefMark';
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
  onIcebox: () => void;
  onRestore: () => unknown;
  onDrop: (reason: string | null) => void;
  onSend: () => void;
  /** Start: tell the card's agent (or a live session in its project) to begin; an error to say, or null. */
  onStart: () => Promise<string | null>;
  onAsk: () => Promise<string | null>;
  onNotes: (notes: string | null) => Promise<boolean>;
  onLink: (ref: string) => Promise<string | null>;
  onOpenThread: (threadId: string) => void;
  /** Create thread (a card with no thread): compose to the card's agent (or a live session in its project); the Send links the thread. */
  onCreateThread: (opener: HTMLElement) => void;
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
 * "Ask for an update"; and at the foot Ship · Icebox · Drop… (with a reason),
 * Send to an agent for a Backlog card nobody was asked about, Restore in the
 * Icebox or Dropped.
 */
export function CardPanel(props: CardPanelProps) {
  const { card, phone } = props;
  const headingId = useId();
  const [dropping, setDropping] = useState(false);
  const [reason, setReason] = useState('');
  const [said, setSaid] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus goes into the panel when a card opens (another card: the new one's title).
  useEffect(() => heading.current?.focus(), [card.id]);
  // The card's words (You, notes, what was said) render as a thread message's
  // do: refs and URLs link, with hover cards on issue and PR links.
  const body = useRef<HTMLDivElement>(null);
  const refCard = useRefHoverCards(body);
  const text = (words: string) => <CardText text={words} repo={props.repo ?? null} />;
  const foot = cardFoot(card);
  const sent = sentTo(card);
  const refs = inboxCardRefsOf(card);
  const agent = card.agent?.kind === 'agent' ? card.agent : null;
  const notSent = card.column === 'backlog' && !agent && !card.sent;
  // What the person owes, and the thread where they make that call (the lane card's "You: …" goes there too).
  const you = cardYou(card);
  const threadAt = youThread(card, props.rowOf);
  const live = card.column !== 'dropped' && card.column !== 'icebox' && card.column !== 'shipped';
  const askable = (agent !== null || props.canAsk) && live;
  // Create thread: a card that links no thread, unless it is dropped (nothing is said about a dropped card).
  const creatable = threadAt === null && card.column !== 'dropped' && (agent !== null || props.canAsk);
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
      <div className="ib-crdp-top">
        {phone && (
          <button type="button" className="ib-bback" onClick={props.onClose} data-card-back="">
            <Icon name="chevL" size={16} />
            Board
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
              Open thread
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
        </div>
        {you && (
          <p className="ib-crdp-you" data-card-you="" id={`${headingId}-you`}>
            <b>You:</b> {text(you)}
          </p>
        )}
        {card.column === 'dropped' && card.dropped && (
          <p className="ib-crdp-dropped">
            Dropped {whenTime(card.dropped.at)} by {card.dropped.by.kind === 'person' ? 'you' : inboxAgentName(card.dropped.by)}
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
                <RefRow key={ref.url} refItem={ref} resolved={props.refs?.find((r) => r.ref.url === ref.url)?.result ?? null} loading={props.refs === null} />
              ))}
            </ul>
          )}
          <LinkField onLink={props.onLink} />
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
                const words = historyWords(entry);
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
            setDropping(false);
            props.onDrop(reason.replace(/\s+/g, ' ').trim() || null);
          }}
        >
          <label htmlFor={`${headingId}-reason`} dir="auto">
            Drop “{card.title}”
          </label>
          <input
            id={`${headingId}-reason`}
            type="text"
            placeholder="Why (optional)"
            value={reason}
            maxLength={INBOX_CARD_REASON_MAX}
            onChange={(event) => setReason(event.target.value)}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setDropping(false);
              }
            }}
            data-drop-reason=""
          />
          <div className="ib-crdp-dropacts">
            <button type="button" className="ib-btn ib-ghost" onClick={() => setDropping(false)}>
              Cancel
            </button>
            <button type="submit" className="ib-btn ib-danger" data-drop-confirm="">
              <Icon name="xCircle" size={15} />
              Drop
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
              Ship
            </button>
          )}
          {foot.primary === 'restore' && (
            <OnceButton className="ib-btn ib-soft" onClick={props.onRestore} data-card-restore={card.id}>
              <Icon name="replay" size={15} />
              Restore to {INBOX_CARD_COLUMN_LABELS[card.aside_from ?? 'backlog']}
            </OnceButton>
          )}
          <span className="ib-bsp" />
          {foot.icebox && (
            <button type="button" className="ib-btn ib-ghost" onClick={props.onIcebox} data-card-icebox="">
              <Icon name="snowflake" size={15} />
              Icebox
            </button>
          )}
          {foot.drop && (
            <button type="button" className="ib-btn ib-ghost" onClick={() => setDropping(true)} data-card-drop="">
              <Icon name="xCircle" size={15} />
              Drop…
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

/** The card's column, as a Move menu: the five lanes (its own checked), then Shipped and Icebox; Restore when it is aside. */
function ColumnMenu({ card, sent, onColumn, onRestore }: { card: InboxCardWire; sent: boolean; onColumn: (column: InboxCardColumn) => void; onRestore: () => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const choices = columnChoices(card);
  const aside = card.column === 'icebox' || card.column === 'dropped';
  return (
    <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
      <Menu.Trigger ref={trigger} className="ib-crdp-col" aria-label={`Column: ${INBOX_CARD_COLUMN_LABELS[card.column]}${sent ? ', sent' : ''}. Move`} data-card-column={card.column}>
        <span className="ib-lane-dot" data-col={card.column} aria-hidden="true" />
        <b>{INBOX_CARD_COLUMN_LABELS[card.column]}</b>
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
              {choices.slice(0, 5).map((choice) => (
                <Menu.RadioItem key={choice.column} value={choice.column} closeOnClick className="ib-pmi" label={choice.label} data-card-move-to={choice.column}>
                  <span className="ib-lane-dot" data-col={choice.column} aria-hidden="true" />
                  {choice.label}
                  {choice.current && <Icon name="check" size={15} className="ib-pmi-check" />}
                </Menu.RadioItem>
              ))}
              <Menu.Separator className="ib-pm-sep" />
              {choices.slice(5).map((choice) => (
                <Menu.RadioItem key={choice.column} value={choice.column} closeOnClick className="ib-pmi" label={choice.label} data-card-move-to={choice.column}>
                  <Icon name={choice.column === 'shipped' ? 'checkCircle' : 'snowflake'} size={15} />
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
        Create thread
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

/** One link: its number and, once read, its title and live state (open, draft, checks, merged or closed, with dates). */
function RefRow({ refItem, resolved, loading }: { refItem: InboxCardRef; resolved: ForgeRefCardResult | null; loading: boolean }) {
  const data = resolved?.ok ? resolved.data : null;
  const state = data ? refState(data) : null;
  const kind = refItem.kind === 'pr' ? 'Pull request' : refItem.kind === 'issue' ? 'Issue' : refItem.kind;
  const number = refItem.ref.replace(/^.*?(?=[#!]\d+$)/, '');
  return (
    <li className="ib-crdp-ref" data-card-ref={refItem.ref} data-ref-state={state?.tone ?? (loading ? 'loading' : 'quiet')}>
      <RefMarkIcon kind={refItem.kind === 'issue' ? 'issue' : 'pr'} state={data ? data.state : 'unknown'} size={15} />
      <a href={refItem.url} target="_blank" rel="noreferrer noopener" className="ib-crdp-rn" aria-label={`${kind} ${refItem.ref}${data ? `: ${data.title}` : ''}`}>
        {number}
      </a>
      <span className="ib-crdp-rt" dir="auto">
        {data ? data.title : <span className="ib-crdp-rref">{refItem.ref}</span>}
      </span>
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
 * A line of the card's words, through the same inline markdown as a thread
 * message: a bare `#123` links into the card's project's repo, `owner/repo#123`
 * and full URLs link as written. The lane cards keep plain text.
 */
function CardText({ text, repo }: { text: string; repo: InboxProjectRepo | null }) {
  return <InlineMarkdown text={text} githubRepo={repo?.display} repoHost={repo?.host ?? undefined} />;
}

/** Link an issue or PR from the opened card. */
function LinkField({ onLink }: { onLink: (ref: string) => Promise<string | null> }) {
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
        Link an issue or PR
      </label>
      <input id="ib-card-link" type="text" placeholder="Link an issue or PR (owner/repo#123 or its URL)" value={text} onChange={(event) => setText(event.target.value)} data-card-link-field="" />
      {error && (
        <p className="ib-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
