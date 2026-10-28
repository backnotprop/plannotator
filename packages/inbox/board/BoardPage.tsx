import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { INBOX_CARD_COLUMN_LABELS, INBOX_CARD_LIVE_COLUMNS, inboxCardMarkRef, type InboxCardColumn, type InboxCardMark, type InboxCardHistoryEntry, type InboxCardRef, type InboxCardWire, type InboxListRow, type InboxProjectRepo } from '@plannotator/core/inbox-types';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { inboxApi, type CardsModel, type ComposeSessionsModel, type ProjectFolder } from '../api';
import { formatCount, fullTime, whenTime } from '../format';
import { AuthorMark, Icon } from '../icons';
import { Tip, isTextCut } from '../components/Tip';
import { DeliveryTick } from '../components/DeliveryTick';
import { SidebarTrigger } from '../shell/sidebar';
import { pageInFront } from '../sound';
import { useComposeSessions } from '../compose/useComposeSessions';
import { findTarget, hostLabel } from '../compose/model';
import { CardPanel } from './CardPanel';
import { OnceButton } from './OnceButton';
import { RefMark, markLabel } from './RefMark';
import { useCardMarks } from './useCardMarks';
import { NewCardDialog, type NewCardInput } from './NewCardDialog';
import { BoardIntro, useCopyBoardPrompt } from './BoardIntro';
import { ProjectFilter } from './ProjectFilter';
import { projectNames } from '../search/model';
import {
  agentState,
  askWhereBody,
  boardCounts,
  boardLanes,
  boardProjects,
  cardsInProject,
  BOARD_FILTER_ROW_BELOW,
  cardAge,
  cardLabel,
  cardLine,
  cardMessageBody,
  messageKey,
  lanesThatFit,
  laneWindowStart,
  cardOwnerName,
  cardShowsUnread,
  moveSaid,
  sentTo,
  startBody,
  youLinkLabel,
  youThread,
  unseenDrops,
  type BoardView,
} from './model';

/** A move the person makes on a card (the window's route `POST /api/inbox/cards/:id`). */
export type BoardMove = { op: 'move'; column: InboxCardColumn } | { op: 'icebox' } | { op: 'drop'; reason?: string | null } | { op: 'restore' };

export interface BoardPageProps {
  view: BoardView;
  /** This computer's `plannotator` (settings `mcp_command`): the Board prompt names it. */
  mcpCommand: readonly string[] | null;
  /** Ask for the first-visit dialog (once per machine; never over the tailnet). False: never ask (tests, the tour). */
  claimIntro?: boolean;
  model: CardsModel | null;
  error: string | null;
  /** The person's look when this visit began: cards an agent wrote to after it are bold. */
  visitLook: number | null;
  /** Cards the person opened or moved this visit: no longer bold. */
  handled: ReadonlySet<string>;
  /** Projects a New card can go in (the sidebar's). */
  projects: readonly ProjectFolder[];
  /** Where a New card goes unless the person picks another. */
  defaultProject: string | null;
  home: string | null;
  phone: boolean;
  /** The opened card (`#board&card=crd_…`), or null. */
  openCard: string | null;
  onOpenCard: (id: string | null) => void;
  /** A thread's list row (its subject, state and delivery), or null when the list does not hold it. */
  rowOf: (threadId: string) => InboxListRow | null;
  onView: (view: BoardView) => void;
  onMove: (card: InboxCardWire, move: BoardMove) => Promise<InboxCardWire | null>;
  /** A card was made or edited here: read the cards again (the event stream does too). */
  onChanged: (card?: InboxCardWire) => void;
  /** The person looked at these agents' drops ("Got it", or the Icebox page while it is in front): only those are marked seen. */
  onSeeDrops: (ids: readonly string[]) => void;
  /** A thread of the opened card opens in the Inbox view, with a way back to the card. */
  onOpenThread: (card: InboxCardWire, threadId: string) => void;
  /** Create thread (an opened card with no thread): compose to `session` (the card's agent, else a live session in its project), linked to the card on Send. */
  onCreateThread: (card: InboxCardWire, session: string | null, opener: HTMLElement) => void;
  /** Read the lane cards' marks (their linked PR's or issue's state). False on a page opened over the tailnet (and in tests that do not serve them). */
  marks?: boolean;
  /**
   * The project the Board shows (`#board&project=prj_…`, the list's own key), or null for every card.
   * Lanes, counts, Shipped, Icebox and the agents' drops all follow it.
   */
  project?: string | null;
  onProject?: (project: string | null) => void;
}

/**
 * The Board (approval "inbox-board", step 2): the five live columns as lanes
 * (Soft + Lanes), cards in variant C "Lean", Shipped and Icebox as links to
 * their own lists, the agents' unseen drops above the lanes. A card opens in
 * a panel beside the Board (the lanes narrow and scroll, so the card's lane
 * stays in view); on a phone the lanes are one stacked list (Shipped and
 * Icebox folded at the end) and an opened card is a full screen. Every move
 * is on the opened card's column menu (the keyboard's way), and on a desktop
 * a card can be dragged to another lane.
 */
export function BoardPage(props: BoardPageProps) {
  const { model, view, phone } = props;
  const allCards = model?.cards ?? [];
  const project = props.project ?? null;
  // Filtered to a project: everything below reads only its cards (the opened card is found among all).
  const cards = cardsInProject(allCards, project);
  const names = useMemo(() => projectNames(props.projects), [props.projects]);
  const offered = boardProjects(allCards, props.projects, project);
  const projectName = project ? (names.get(project) ?? null) : null;
  const counts = boardCounts(cards);
  const drops = unseenDrops(cards);
  const [creating, setCreating] = useState<null | 'backlog' | 'send'>(null);
  const [intro, setIntro] = useState(false);
  const claimed = useRef(false);
  useEffect(() => {
    if (claimed.current || props.claimIntro === false) return;
    claimed.current = true;
    inboxApi
      .claimBoardIntro()
      .then((answer) => answer.show && setIntro(true))
      .catch(() => {});
  }, [props.claimIntro]);
  const promptCopy = useCopyBoardPrompt(props.mcpCommand);
  const liveCount = counts.inFlight;
  const [sendingCard, setSendingCard] = useState<InboxCardWire | null>(null);
  const [said, setSaid] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const { model: sessions } = useComposeSessions(true);
  const live = sessions ? sessions.projects.flatMap((g) => g.sessions) : null;
  const open = props.openCard ? (allCards.find((c) => c.id === props.openCard) ?? null) : null;
  const projectOf = (card: InboxCardWire) => props.projects.find((p) => p.id === card.project_id) ?? null;

  // When the opened card closes, focus that the panel took with it goes back to the card, in whatever
  // lane it now sits (a move from its menu included), else to the Board's heading; never the page.
  const lastOpen = useRef<string | null>(null);
  useLayoutEffect(() => {
    const was = lastOpen.current;
    lastOpen.current = props.openCard;
    if (!was || props.openCard) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const heading = document.getElementById(titleId);
    const root = heading?.closest('.ib-bpage') ?? document;
    const button = root.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(was)}"] [data-card-open]`);
    (button ?? heading)?.focus();
  }, [props.openCard]);

  const move = async (card: InboxCardWire, change: BoardMove) => {
    setFailed(null);
    const moved = await props.onMove(card, change);
    if (!moved) {
      setFailed(`“${card.title}” did not move. Try again.`);
      return;
    }
    setSaid(moveSaid(card, moved));
  };

  // A New card dialog makes one card, whatever its retries. Each try that makes it has its own key and
  // its own content; when a try's answer is lost, the next try first replays that try exactly (its key,
  // its words), which answers the card it made (or makes it now), and then brings the card to what the
  // dialog says now (title, notes, added links, Backlog or Icebox). So editing the title after a lost
  // answer never reuses a key with other words (`idempotency_key_reused`) and never makes a second card.
  const dialogKey = useRef('');
  /** The card a New card dialog already made (a retry reconciles and sends that one, never a second). */
  const dialogCard = useRef<InboxCardWire | null>(null);
  /** The try that makes the card, while its answer is not known: replayed as it was. */
  const madeTry = useRef<{ input: NewCardInput; target: string; key: string; run: () => Promise<InboxCardWire> } | null>(null);
  /** The inputs the card was last brought to (what the made card already holds). */
  const madeFrom = useRef<{ input: NewCardInput; target: string } | null>(null);
  /** The message that sends the dialog's card, as first tried: a retry sends the same words, so never twice. */
  const sendTry = useRef<{ session: string; body: string } | null>(null);
  const resetDialog = () => {
    dialogKey.current = crypto.randomUUID();
    dialogCard.current = null;
    madeTry.current = null;
    madeFrom.current = null;
    sendTry.current = null;
  };
  const openCreate = (mode: 'backlog' | 'send') => {
    resetDialog();
    setCreating(mode);
  };
  const openSend = (card: InboxCardWire) => {
    resetDialog();
    setSendingCard(card);
  };

  /** Give a card to an agent: a new thread to it (the notes the message, naming the card), then the card is sent. */
  const sendCardTo = async (card: InboxCardWire, to: NonNullable<NewCardInput["to"]>, key: string): Promise<InboxCardWire> => {
    if (!sendTry.current || sendTry.current.session !== to.session) sendTry.current = { session: to.session, body: cardMessageBody(card.title, card.notes, card.id) };
    const body = sendTry.current.body;
    const started = await inboxApi.startThread({ to: { host: to.host, session: to.session }, body, idempotency_key: messageKey(key, to.session, body) });
    return (await inboxApi.editCard(card.id, { op: 'send', thread_id: started.thread_id })).card;
  };

  /** Where a dialog's card lives: its project, or (a folder with no project yet) the session the thread makes it in. */
  const targetOf = (input: NewCardInput): string =>
    input.mode === 'send' && input.to ? (input.to.project.id ? `project:${input.to.project.id}` : `session:${input.to.session}`) : `project:${input.project ?? ''}`;

  /** One try at making the dialog's card, with its own key and these words; replayable as it is. */
  const makeTry = (input: NewCardInput): { key: string; run: () => Promise<InboxCardWire> } => {
    const key = crypto.randomUUID();
    const column: 'backlog' | 'icebox' = input.mode === 'icebox' ? 'icebox' : 'backlog';
    if (input.mode === 'send' && input.to && !input.to.project.id) {
      // A folder the Inbox has not seen has no project yet: the thread makes it, and the card is
      // made and sent in one step with it (checked by the server before anything is written).
      const to = input.to;
      const body = cardMessageBody(input.title, input.notes, null);
      return {
        key,
        run: async () => {
          const started = await inboxApi.startThread({ to: { host: to.host, session: to.session }, body, idempotency_key: messageKey(key, to.session, body) });
          return (await inboxApi.createCard({ title: input.title, notes: input.notes, refs: input.refs, thread_id: started.thread_id, idempotency_key: key })).card;
        },
      };
    }
    const project = input.mode === 'send' && input.to ? input.to.project.id : input.project;
    return { key, run: async () => (await inboxApi.createCard({ project, title: input.title, notes: input.notes, refs: input.refs, column, idempotency_key: key })).card };
  };

  /** The dialog's card, made once and brought to what the dialog says now. */
  const dialogCardFor = async (input: NewCardInput): Promise<InboxCardWire> => {
    const target = targetOf(input);
    let card = dialogCard.current;
    if (!card && madeTry.current) {
      const before = madeTry.current;
      if (before.target !== target && before.target.startsWith('project:') && target.startsWith('project:')) {
        // The answer was lost and the person chose another project: look for the card that try made
        // (by its key) instead of replaying it, so a try that never reached the server is not made in
        // the old project only to be dropped there.
        const { cards: all } = await inboxApi.cards();
        card = all.find((c) => c.idempotency_key === before.key) ?? null;
      } else {
        // The last try's answer was lost: replay it as it was.
        card = await before.run();
      }
      dialogCard.current = card;
      madeFrom.current = card ? { input: before.input, target: before.target } : null;
      madeTry.current = null;
    }
    if (card && madeFrom.current && madeFrom.current.target !== target) {
      // Made in another project (or for another session's new folder): the person moved it, so that
      // card goes (their own drop, kept in Dropped) and this try makes it where they chose now. The
      // card is read first: a drop whose answer was lost has landed, and dropping it again is refused.
      // A drop that fails stops here (the retry drops it), so two live cards never stand.
      const now = (await inboxApi.card(card.id)).card;
      if (now.column !== 'dropped') await inboxApi.moveCard(card.id, { op: 'drop', reason: 'Made again in another project' });
      card = null;
      dialogCard.current = null;
      madeFrom.current = null;
    }
    if (!card) {
      const { key, run } = makeTry(input);
      madeTry.current = { input, target, key, run };
      card = await run();
      dialogCard.current = card;
      madeFrom.current = { input, target };
      madeTry.current = null;
      return card;
    }
    const was = madeFrom.current?.input;
    if (card.title !== input.title || (card.notes ?? null) !== (input.notes ?? null)) {
      card = (await inboxApi.editCard(card.id, { op: 'edit', title: input.title, notes: input.notes })).card;
    }
    for (const ref of input.refs) if (!was || !was.refs.includes(ref)) card = (await inboxApi.editCard(card.id, { op: 'link', ref })).card;
    const column = input.mode === 'icebox' ? 'icebox' : 'backlog';
    if (card.column !== column) card = (await inboxApi.moveCard(card.id, column === 'icebox' ? { op: 'icebox' } : { op: 'move', column: 'backlog' })).card;
    dialogCard.current = card;
    madeFrom.current = { input, target };
    return card;
  };

  /**
   * Make a card from New card: Backlog or Icebox in a project, or sent to an
   * agent. Sending makes the card first (Backlog, in the session's project)
   * and names it in the message, so the agent never gets "it is yours now"
   * for a card that does not exist; a retry reuses the card and the key.
   */
  const create = async (input: NewCardInput): Promise<string | null> => {
    const key = dialogKey.current || crypto.randomUUID();
    dialogKey.current = key;
    try {
      const card = await dialogCardFor(input);
      // Made in another project than the Board shows: the card is not on screen, so the words say where it went.
      const elsewhere = project && card.project_id !== project ? ` in ${names.get(card.project_id) ?? 'another project'}` : '';
      if (input.mode === 'send' && input.to) {
        const sent = card.sent ? card : await sendCardTo(card, input.to, key);
        props.onChanged(sent);
        setSaid(`Sent “${input.title}” to ${hostLabel(input.to.host)}${elsewhere}.`);
      } else {
        props.onChanged(card);
        setSaid(`Added “${input.title}” to ${input.mode === 'icebox' ? 'Icebox' : 'Backlog'}${elsewhere}.`);
      }
      setCreating(null);
      resetDialog();
      return null;
    } catch (cause) {
      if (dialogCard.current) props.onChanged(dialogCard.current);
      return cause instanceof Error ? cause.message : 'The card was not made. Try again.';
    }
  };

  /** Send a Backlog card nobody was asked about: a new thread to the agent (its notes the message), then the card is sent. */
  const sendExisting = async (card: InboxCardWire, input: NewCardInput): Promise<string | null> => {
    if (!input.to) return 'Choose an agent to send it to.';
    const key = dialogKey.current || crypto.randomUUID();
    dialogKey.current = key;
    try {
      const next = await sendCardTo(card, input.to, key);
      props.onChanged(next);
      setSendingCard(null);
      setSaid(`Sent “${card.title}” to ${hostLabel(input.to.host)}.`);
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : 'Nothing was sent. Try again.';
    }
  };

  // The lane marks: the state of each card's linked PR or issue, for the cards on screen only.
  const pageRef = useRef<HTMLElement | null>(null);
  // A narrow page (a narrow window, or a wide sidebar): the Project chip takes a row of its own under the
  // header, as on a phone, so neither it nor the counts are cut to a few letters.
  const [narrowHead, setNarrowHead] = useState(false);
  useLayoutEffect(() => {
    const el = pageRef.current;
    if (!el || phone) return;
    const measure = () => setNarrowHead(el.clientWidth > 0 && el.clientWidth < BOARD_FILTER_ROW_BELOW);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [phone, model !== null]);
  const marks = useCardMarks(cards, props.marks === true && model !== null, pageRef, `${view}|${phone}|${phone && open ? 'card' : ''}`);
  const markOf = (card: InboxCardWire): InboxCardMark | null => {
    const ref = inboxCardMarkRef(card);
    if (!ref) return null;
    const mark = marks.get(card.id);
    return mark && mark.url === ref.url ? mark : { kind: ref.kind === 'issue' ? 'issue' : 'pr', ref: ref.ref, url: ref.url, state: 'unknown', title: null };
  };

  const common: CardCommon = {
    visitLook: props.visitLook,
    handled: props.handled,
    now,
    phone,
    openId: props.openCard,
    rowOf: props.rowOf,
    markOf,
    onOpen: (card) => props.onOpenCard(card.id),
    onOpenThread: props.onOpenThread,
  };

  // The project filter: the chip in the header, and the way back to every card when it hides them all.
  // Shown once the cards span two projects (or one is picked): a Board of one project looks as it always did.
  const showFilter = model !== null && props.onProject !== undefined && (offered.length > 1 || project !== null);
  const filter = showFilter ? <ProjectFilter projects={offered} names={names} value={project} phone={phone} onChange={(next) => props.onProject?.(next)} /> : null;
  const inProject = <b dir="auto">{projectName ?? 'this project'}</b>;
  const showAll = (
    <button
      type="button"
      className="ib-btn ib-sm"
      onClick={() => {
        props.onProject?.(null);
        requestAnimationFrame(() => document.getElementById(titleId)?.focus());
      }}
      data-board-show-all=""
    >
      Show all projects
    </button>
  );
  // Say a new filter once it lands (not on the first draw).
  const saidProject = useRef(project);
  useEffect(() => {
    if (saidProject.current === project) return;
    saidProject.current = project;
    setSaid(project ? `Showing the cards in ${projectName ?? 'one project'}.` : 'Showing the cards in every project.');
  }, [project, projectName]);

  let body: ReactNode;
  if (!model) body = props.error ? <div className="ib-error">{props.error}</div> : <div className="ib-bload" aria-busy="true" />;
  else if (phone && project && cards.length === 0)
    body = (
      <div className="ib-bempty ib-bempty-in" data-board-empty="project">
        <span>No cards in {inProject}</span>
        {showAll}
      </div>
    );
  else if (phone) body = <PhoneBoard cards={cards} counts={counts} {...common} onRestore={(card) => move(card, { op: 'restore' })} />;
  else if (view === 'shipped')
    body = (
      <CardList
        title="Shipped"
        empty={project ? <>Nothing shipped in {inProject} yet.</> : 'Nothing shipped yet. A card goes here when its work is merged or live.'}
        cards={cards.filter((c) => c.column === 'shipped')}
        {...common}
      />
    );
  else if (view === 'icebox')
    body = <IceboxPage cards={cards} inProject={project ? inProject : null} {...common} onRestore={(card) => move(card, { op: 'restore' })} onSeeDrops={props.onSeeDrops} unseen={drops} />;
  else body = <Lanes cards={cards} {...common} openColumn={open?.column ?? null} onMove={(card, column) => void move(card, { op: 'move', column })} />;

  const titleId = useId();
  const panel = open ? (
    <OpenedCard
      key={open.id}
      card={open}
      projectName={projectOf(open)?.name ?? ''}
      projectRoot={projectOf(open)?.root ?? null}
      sessions={sessions}
      live={live}
      phone={phone}
      now={now}
      rowOf={props.rowOf}
      onClose={() => props.onOpenCard(null)}
      onMove={(change) => move(open, change)}
      onSend={() => openSend(open)}
      onChanged={props.onChanged}
      onOpenThread={(threadId) => props.onOpenThread(open, threadId)}
      onCreateThread={(session, opener) => props.onCreateThread(open, session, opener)}
    />
  ) : null;

  // On a phone an opened card is a screen of its own, over the Board.
  if (phone && panel) {
    return (
      <section className="ib-bpage ib-bpage-card" aria-label={`Card: ${open!.title}`} data-board-page="" data-board-view="card">
        {panel}
        {sendingCard && <SendDialog card={sendingCard} sessions={sessions} projects={props.projects} home={props.home} phone={phone} onClose={() => setSendingCard(null)} onSend={sendExisting} />}
      </section>
    );
  }

  return (
    <section ref={pageRef} className="ib-bpage" aria-labelledby={titleId} data-board-page="" data-board-view={phone ? 'phone' : view} data-card-open={open ? '' : undefined}>
      <div className="ib-bhead">
        <SidebarTrigger />
        {view !== 'lanes' && !phone ? (
          <>
            <button type="button" className="ib-bback" data-board-back="" onClick={() => props.onView('lanes')}>
              <Icon name="chevL" size={16} />
              Board
            </button>
            <h1 id={titleId} tabIndex={-1}>
              {view === 'shipped' ? 'Shipped' : 'Icebox'}
            </h1>
            {!narrowHead && filter}
          </>
        ) : (
          <>
            <h1 id={titleId} tabIndex={-1}>
              Board
            </h1>
            {model && (
              <span className="ib-bsum" data-board-summary="">
                {counts.inFlight === 0 ? (
                  'Nothing in flight'
                ) : (
                  <>
                    {phone ? formatCount(counts.inFlight) : `${formatCount(counts.inFlight)} in flight`} · <b>{formatCount(counts.onYou)} on you</b>
                  </>
                )}
              </span>
            )}
            {!phone && !narrowHead && filter}
          </>
        )}
        <span className="ib-bsp" />
        {/* The "?" sits left of Shipped and Icebox (the intro mock). */}
        {(view === 'lanes' || phone) && (
          <Tip content="About the Board">
            <button type="button" className="ib-iconbtn ib-babout" aria-label="About the Board" aria-haspopup="dialog" onClick={() => setIntro(true)} data-board-about="">
              <Icon name="question" size={17} />
            </button>
          </Tip>
        )}
        {!phone && view === 'lanes' && model && (
          <nav className="ib-blinks" aria-label="Cards out of the lanes">
            <a href="#board=shipped" data-board-link="shipped" onClick={(event) => (event.preventDefault(), props.onView('shipped'))}>
              Shipped {formatCount(counts.shipped)}
            </a>
            <span aria-hidden="true">·</span>
            <a href="#board=icebox" data-board-link="icebox" onClick={(event) => (event.preventDefault(), props.onView('icebox'))}>
              Icebox {formatCount(counts.icebox)}
            </a>
          </nav>
        )}
        {(view === 'lanes' || phone) && <NewCardButton disabled={props.projects.length === 0 && !(live && live.length > 0)} phone={phone} onOpen={() => openCreate('backlog')} />}
      </div>
      {(phone || narrowHead) && filter && <div className="ib-bfbar">{filter}</div>}
      {model && drops.length > 0 && view !== 'icebox' && (
        <DroppedNotice drops={drops} onRestore={(card) => move(card, { op: 'restore' })} onSeen={() => props.onSeeDrops(drops.map((card) => card.id))} onOpenIcebox={phone ? null : () => props.onView('icebox')} />
      )}
      {failed && (
        <div className="ib-error ib-bfail" role="alert">
          {failed}
        </div>
      )}
      <div className="ib-bmain">
        {body}
        {panel}
        {model && view === 'lanes' && !phone && liveCount === 0 && !open && project !== null && (
          <div className="ib-bempty" data-board-empty="project">
            <span>Nothing in flight in {inProject}</span>
            {showAll}
          </div>
        )}
        {model && view === 'lanes' && !phone && liveCount === 0 && !open && project === null && (
          <div className="ib-bempty" data-board-empty="">
            No cards yet
            <button type="button" className="ib-btn ib-sm" onClick={() => void promptCopy.copy()} data-board-empty-copy="">
              <Icon name={promptCopy.state === 'copied' ? 'check' : 'copy'} size={14} />
              {promptCopy.state === 'copied' ? 'Copied' : 'Copy prompt'}
            </button>
          </div>
        )}
      </div>
      <div className="ib-sr" aria-live="polite" data-board-live="">
        {said}
      </div>
      {creating && (
        <NewCardDialog
          projects={props.projects}
          defaultProject={props.defaultProject}
          sessions={sessions}
          home={props.home}
          phone={phone}
          initialMode={creating}
          onClose={() => setCreating(null)}
          onCreate={create}
        />
      )}
      {intro && <BoardIntro mcpCommand={props.mcpCommand} phone={phone} onClose={() => setIntro(false)} />}
      {sendingCard && <SendDialog card={sendingCard} sessions={sessions} projects={props.projects} home={props.home} phone={phone} onClose={() => setSendingCard(null)} onSend={sendExisting} />}
    </section>
  );
}

/** Send to an agent from the opened card: New card's dialog, its text already the card's, only the agent to pick. */
function SendDialog({
  card,
  sessions,
  projects,
  home,
  phone,
  onClose,
  onSend,
}: {
  card: InboxCardWire;
  sessions: ComposeSessionsModel | null;
  projects: readonly ProjectFolder[];
  home: string | null;
  phone: boolean;
  onClose: () => void;
  onSend: (card: InboxCardWire, input: NewCardInput) => Promise<string | null>;
}) {
  return (
    <NewCardDialog
      projects={projects}
      defaultProject={card.project_id}
      sessions={sessions}
      home={home}
      phone={phone}
      initialMode="send"
      fixed={{ title: card.title, notes: card.notes }}
      onClose={onClose}
      onCreate={(input) => onSend(card, input)}
    />
  );
}

interface CardCommon {
  visitLook: number | null;
  handled: ReadonlySet<string>;
  now: number;
  phone: boolean;
  openId: string | null;
  rowOf: (threadId: string) => InboxListRow | null;
  /** The card's lane mark (its linked PR or issue), null when it links neither. */
  markOf: (card: InboxCardWire) => InboxCardMark | null;
  onOpen: (card: InboxCardWire) => void;
  /** The "You: …" line's way in: the thread where the person makes the call (`youThread`). */
  onOpenThread: (card: InboxCardWire, threadId: string) => void;
}

function NewCardButton({ disabled, phone, onOpen }: { disabled: boolean; phone: boolean; onOpen: () => void }) {
  const button = (
    <button type="button" className="ib-btn ib-sm ib-bnew" data-board-new="" disabled={disabled} aria-haspopup="dialog" onClick={onOpen} aria-label={phone ? 'New card' : undefined}>
      <Icon name="plus" size={15} />
      {!phone && 'New card'}
    </button>
  );
  return disabled ? <Tip content="A card needs a project: an agent's first message makes one.">{button}</Tip> : button;
}

function Lanes({
  cards,
  onMove,
  openColumn,
  ...common
}: CardCommon & { cards: readonly InboxCardWire[]; openColumn: InboxCardColumn | null; onMove: (card: InboxCardWire, column: InboxCardColumn) => void }) {
  const [dragging, setDragging] = useState<InboxCardWire | null>(null);
  const [over, setOver] = useState<InboxCardColumn | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // With a card open the lanes narrow to as many whole lanes as fit (never a cut sliver of one),
  // the open card's lane among them: the window centres on it, held at the ends (the mock).
  const [fit, setFit] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!openColumn || !el) {
      setFit(null);
      return;
    }
    const measure = () => {
      const style = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      setFit(lanesThatFit(width));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [openColumn]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!openColumn || !el || fit === null) return;
    const index = INBOX_CARD_LIVE_COLUMNS.indexOf(openColumn);
    if (index < 0) return;
    const start = laneWindowStart(index, fit, INBOX_CARD_LIVE_COLUMNS.length);
    const lane = el.querySelectorAll<HTMLElement>('[data-lane]')[start];
    if (lane) el.scrollLeft = lane.offsetLeft - el.querySelector<HTMLElement>('[data-lane]')!.offsetLeft;
  }, [openColumn, common.openId, fit]);
  return (
    <div
      className="ib-blanes"
      ref={scroller}
      data-dragging={dragging ? '' : undefined}
      data-fit={fit ?? undefined}
      style={fit ? ({ '--ib-lanes-fit': fit } as CSSProperties) : undefined}
    >
      {boardLanes(cards).map((lane) => {
        const target = dragging !== null && dragging.column !== lane.column;
        const dragOver = (event: DragEvent) => {
          if (!target) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (over !== lane.column) setOver(lane.column);
        };
        return (
          <section
            key={lane.column}
            className="ib-lane"
            aria-labelledby={`ib-lane-${lane.column}`}
            data-lane={lane.column}
            data-drop={target ? '' : undefined}
            data-over={target && over === lane.column ? '' : undefined}
            onDragOver={dragOver}
            onDragEnter={dragOver}
            onDragLeave={(event) => {
              if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOver((current) => (current === lane.column ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              const card = dragging;
              setDragging(null);
              setOver(null);
              if (card && card.column !== lane.column) onMove(card, lane.column);
            }}
          >
            <h2 className="ib-lane-h" id={`ib-lane-${lane.column}`} tabIndex={-1}>
              <span className="ib-lane-dot" data-col={lane.column} aria-hidden="true" />
              <span className="ib-lane-l">{lane.label}</span>
              <span className="ib-lane-n">{formatCount(lane.cards.length)}</span>
            </h2>
            {lane.cards.length > 0 ? (
              <ul className="ib-lane-cards" aria-labelledby={`ib-lane-${lane.column}`}>
                {lane.cards.map((card) => (
                  <BoardCard
                    key={card.id}
                    card={card}
                    {...common}
                    draggable
                    dragging={dragging?.id === card.id}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="ib-lane-empty">{LANE_EMPTY[lane.column]}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

const LANE_EMPTY: Partial<Record<InboxCardColumn, string>> = {
  backlog: 'Nothing waiting. A card here is not sent to any agent.',
  designing: 'No agent is designing anything.',
  your_look: 'Nothing waits on your look.',
  building: 'No agent is building anything.',
  your_review: 'Nothing waits on your review.',
};

/** A lane card's title is cut (clamped at three lines, or a word cut at the edge): its button overflows. */
const titleCut = (trigger: Element) => isTextCut(trigger.closest('.ib-bc-main'));

/**
 * One card, "Title row" (approval board-lane-card, r1, 2026-10-27): the
 * title, with the linked PR's or issue's mark, the agent's small round mark (a
 * dashed ring for the person's card) and how long ago anyone last wrote to it
 * at the right of its first line. A second line only when the person owes
 * something ("You: …", in the person's columns) or a send is pending ("Sent to
 * <agent>" with the delivery tick, until it moves). The agent's last word is
 * not on the lane card: the opened card has it. Bold while unread. The title
 * is the button that opens the card (a click anywhere else on the card does
 * too); "You: …" is its own button, to the thread where the person makes the
 * call (`youThread`); with no thread linked it is plain words, and a click on
 * it opens the card.
 */
function BoardCard({
  card,
  visitLook,
  handled,
  now,
  phone,
  openId,
  rowOf,
  markOf,
  onOpen,
  onOpenThread,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragEnd,
}: CardCommon & { card: InboxCardWire; draggable?: boolean; dragging?: boolean; onDragStart?: () => void; onDragEnd?: () => void }) {
  const unread = cardShowsUnread(card, visitLook, handled);
  const line = cardLine(card);
  const sent = sentTo(card);
  const delivery = sent && card.sent ? (rowOf(card.sent.thread_id)?.delivery ?? null) : null;
  const age = cardAge(card.heard_at, now);
  const mark = markOf(card);
  const label = cardLabel(card, unread, now) + (sent ? `. Sent to ${sent}` : '') + (mark ? `. ${markLabel(mark)}` : '');
  const thread = line?.you ? youThread(card, rowOf) : null;
  // "Title row" (approval board-lane-card, r1): a card is its title row, the marks and the age at its right.
  // A second line only when the person owes something ("You: …") or a send is pending ("Sent to …"); the
  // agent's last word is left off the lane card and stays in the opened card. Never an empty second line.
  const oneLine = !sent && !line?.you;
  const owner = cardOwnerName(card);
  const meta = (
    <span className="ib-bc-meta">
      {mark && <RefMark mark={mark} />}
      <Tip content={owner === 'You' ? 'Your card' : owner}>
        <span className="ib-bc-who" data-host={card.agent?.kind === 'agent' ? card.agent.host : 'you'}>
          {card.agent ? <AuthorMark author={card.agent} /> : <span className="ib-lane-dot ib-bc-yourdot" data-col="backlog" aria-hidden="true" />}
        </span>
      </Tip>
      <Tip content={`Last heard ${fullTime(card.heard_at)}`}>
        <span className="ib-bc-age">{age.short.replace(' ago', '')}</span>
      </Tip>
    </span>
  );
  return (
    <li
      className="ib-bcard"
      data-card-id={card.id}
      data-column={card.column}
      data-unread={unread ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      data-open={openId === card.id ? '' : undefined}
      data-sent={sent ? '' : undefined}
      draggable={draggable && !phone ? true : undefined}
      onClick={(event) => {
        // The card's buttons do their own thing; a click anywhere else on it opens the card, as its title does.
        if ((event.target as Element).closest('button, a')) return;
        onOpen(card);
      }}
      onDragStart={(event) => {
        if (!draggable || phone) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.title);
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
    >
      <span className="ib-bc-top">
        <button type="button" className="ib-bc-main" aria-label={label} aria-current={openId === card.id || undefined} data-card-open="" onClick={() => onOpen(card)}>
          {meta}
          {/* The clamp (three lines) is on the button, not on the inline title: measure the button. */}
          <Tip content={card.title} when={titleCut}>
            <span className="ib-bc-t" dir="auto">
              {card.title}
            </span>
          </Tip>
        </button>
      </span>
      {!oneLine && (
        <span className="ib-bc-bot">
          <span className="ib-bc-line" dir="auto">
            {sent ? (
              <span className="ib-bc-sent">
                {delivery ? <DeliveryTick delivery={delivery} /> : <Icon name="clock" size={13} />}
                <span className="ib-bc-sentt">Sent to {sent}</span>
              </span>
            ) : line?.you && thread ? (
              <button type="button" className="ib-bc-youlink" data-card-you-link={thread} aria-label={youLinkLabel(line.text)} onClick={() => onOpenThread(card, thread)}>
                <b className="ib-bc-youw">You:</b> <span className="ib-bc-yout">{line.text}</span>
                <Icon name="arrowUpRight" size={12} />
              </button>
            ) : (
              // No thread to go to: plain words (a click on them opens the card, as anywhere on it), no second tab stop.
              <>
                <b className="ib-bc-youw">You:</b> {line?.text}
              </>
            )}
          </span>
        </span>
      )}
    </li>
  );
}

/** "2 dropped by an agent", with each title and reason, until the person has looked. */
function DroppedNotice({
  drops,
  onRestore,
  onSeen,
  onOpenIcebox,
}: {
  drops: readonly InboxCardWire[];
  onRestore: (card: InboxCardWire) => unknown;
  onSeen: () => void;
  onOpenIcebox: (() => void) | null;
}) {
  const headingId = useId();
  return (
    <section className="ib-bdrops" aria-labelledby={headingId} data-dropped-notice={drops.length}>
      <div className="ib-bdrops-h">
        <Icon name="warn" size={16} />
        <h2 id={headingId}>
          {formatCount(drops.length)} dropped by {drops.length === 1 ? 'an agent' : 'agents'}
        </h2>
        <span className="ib-bsp" />
        {onOpenIcebox && (
          <button type="button" className="ib-lnk" onClick={onOpenIcebox}>
            See Dropped
          </button>
        )}
        <button type="button" className="ib-btn ib-sm" data-dropped-seen="" onClick={onSeen}>
          Got it
        </button>
      </div>
      <ul>
        {drops.map((card) => (
          <li key={card.id} data-dropped-card={card.id}>
            <span className="ib-bdrops-t" dir="auto">
              <b>{card.title}</b>
              {' · '}
              {card.dropped?.by.kind === 'agent' ? cardOwnerName({ ...card, agent: card.dropped.by }) : 'An agent'}
              {card.dropped?.reason ? `: ${card.dropped.reason}` : ''}
            </span>
            <OnceButton className="ib-btn ib-sm" data-card-restore={card.id} onClick={() => onRestore(card)} aria-label={`Restore “${card.title}”`}>
              Restore
            </OnceButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A list of cards (Shipped, Icebox), newest move first. */
function CardList({ title, empty, cards, ...common }: CardCommon & { title: string; empty: ReactNode; cards: readonly InboxCardWire[] }) {
  const id = useId();
  return (
    <section className="ib-blist" aria-labelledby={id}>
      <h2 id={id} className="ib-blist-h" tabIndex={-1}>
        {title} <span className="ib-lane-n">{formatCount(cards.length)}</span>
      </h2>
      {cards.length > 0 ? (
        <ul className="ib-lane-cards">
          {cards.map((card) => (
            <BoardCard key={card.id} card={card} {...common} />
          ))}
        </ul>
      ) : (
        <p className="ib-lane-empty">{empty}</p>
      )}
    </section>
  );
}

/**
 * The Icebox page: cards the person put aside (nothing happens to them: no
 * agent is told, nothing moves them), then Dropped with the date, who dropped
 * it, the reason and Restore. Opening it is the person looking at Dropped.
 */
function IceboxPage({
  cards,
  inProject,
  onRestore,
  onSeeDrops,
  unseen,
  ...common
}: CardCommon & {
  cards: readonly InboxCardWire[];
  /** Filtered to a project: its name, for the empty lines. */
  inProject: ReactNode;
  onRestore: (card: InboxCardWire) => unknown;
  onSeeDrops: (ids: readonly string[]) => void;
  unseen: readonly InboxCardWire[];
}) {
  // Opening Dropped is looking at it: the drops this page drew are marked seen, but only while the
  // page is in front (a tab in the background, or a window without focus, waits until it is).
  const unseenKey = unseen.map((card) => card.id).join(' ');
  useEffect(() => {
    if (!unseenKey) return;
    const ids = unseenKey.split(' ');
    const look = () => {
      if (!pageInFront()) return false;
      onSeeDrops(ids);
      return true;
    };
    if (look()) return;
    const retry = () => {
      if (look()) stop();
    };
    const stop = () => {
      document.removeEventListener('visibilitychange', retry);
      window.removeEventListener('focus', retry);
    };
    document.addEventListener('visibilitychange', retry);
    window.addEventListener('focus', retry);
    return stop;
  }, [unseenKey, onSeeDrops]);
  const iced = cards.filter((c) => c.column === 'icebox');
  const dropped = cards.filter((c) => c.column === 'dropped').sort((a, b) => (b.dropped?.at ?? b.moved_at).localeCompare(a.dropped?.at ?? a.moved_at));
  return (
    <div className="ib-blists">
      <CardList
        title="Icebox"
        empty={inProject ? <>Nothing on ice in {inProject}.</> : 'Nothing on ice. Put a card here to set it aside: no agent is told and nothing moves it.'}
        cards={iced}
        {...common}
      />
      <DroppedList cards={dropped} onRestore={onRestore} inProject={inProject} />
    </div>
  );
}

function DroppedList({ cards, onRestore, inProject = null }: { cards: readonly InboxCardWire[]; onRestore: (card: InboxCardWire) => unknown; inProject?: ReactNode }) {
  const id = useId();
  return (
    <section className="ib-blist" aria-labelledby={id} data-dropped-list="">
      <h2 id={id} className="ib-blist-h" tabIndex={-1}>
        Dropped <span className="ib-lane-n">{formatCount(cards.length)}</span>
      </h2>
      {cards.length > 0 ? (
        <ul className="ib-drops">
          {cards.map((card) => {
            const by = card.dropped?.by.kind === 'agent' ? cardOwnerName({ ...card, agent: card.dropped.by }) : 'you';
            return (
              <li key={card.id} className="ib-drop" data-dropped-row={card.id}>
                <span className="ib-drop-t">
                  <span className="ib-drop-title" dir="auto">
                    {card.title}
                  </span>
                  <span className="ib-drop-meta" dir="auto">
                    {card.dropped ? `Dropped ${whenTime(card.dropped.at)} by ${by}` : 'Dropped'}
                    {card.dropped?.reason ? `: ${card.dropped.reason}` : ''}
                  </span>
                </span>
                <OnceButton className="ib-btn ib-sm" data-card-restore={card.id} onClick={() => onRestore(card)} aria-label={`Restore “${card.title}” to ${INBOX_CARD_COLUMN_LABELS[card.aside_from ?? 'backlog']}`}>
                  Restore
                </OnceButton>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ib-lane-empty">{inProject ? <>Nothing dropped in {inProject}.</> : 'Nothing dropped. A dropped card is kept here and can be restored.'}</p>
      )}
    </section>
  );
}

/**
 * A phone: the lanes as one stacked list in column order, each foldable,
 * with Shipped and Icebox (Dropped inside it) folded at the end. No drag: a
 * card opens full screen, where its column menu moves it.
 */
function PhoneBoard({
  cards,
  counts,
  onRestore,
  ...common
}: CardCommon & { cards: readonly InboxCardWire[]; counts: ReturnType<typeof boardCounts>; onRestore: (card: InboxCardWire) => unknown }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(['shipped', 'icebox']));
  const toggle = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const list = (items: readonly InboxCardWire[], empty: string) =>
    items.length ? (
      <ul className="ib-lane-cards">
        {items.map((card) => (
          <BoardCard key={card.id} card={card} {...common} />
        ))}
      </ul>
    ) : (
      <p className="ib-lane-empty">{empty}</p>
    );
  const groups: { key: string; label: string; count: number; body: ReactNode }[] = boardLanes(cards).map((lane) => ({
    key: lane.column,
    label: lane.label,
    count: lane.cards.length,
    body: list(lane.cards, LANE_EMPTY[lane.column] ?? ''),
  }));
  const dropped = cards.filter((c) => c.column === 'dropped');
  groups.push({ key: 'shipped', label: 'Shipped', count: counts.shipped, body: list(cards.filter((c) => c.column === 'shipped'), 'Nothing shipped yet.') });
  groups.push({
    key: 'icebox',
    label: 'Icebox',
    count: counts.icebox,
    body: (
      <>
        {list(cards.filter((c) => c.column === 'icebox'), 'Nothing on ice.')}
        {dropped.length > 0 && <DroppedList cards={dropped} onRestore={onRestore} />}
      </>
    ),
  });
  return (
    <div className="ib-bstack">
      {groups.map((group) => {
        const opened = !folded.has(group.key);
        const bodyId = `ib-bstack-${group.key}`;
        return (
          <section key={group.key} className="ib-bgroup" data-lane={group.key} aria-labelledby={`${bodyId}-h`}>
            <h2 className="ib-bgroup-h" id={`${bodyId}-h`}>
              <button type="button" aria-expanded={opened} aria-controls={bodyId} onClick={() => toggle(group.key)} data-board-fold={group.key}>
                <span className="ib-lane-dot" data-col={group.key} aria-hidden="true" />
                <span className="ib-lane-l">{group.label}</span>
                <span className="ib-lane-n">{formatCount(group.count)}</span>
                <span className="ib-bsp" />
                <Icon name={opened ? 'chevU' : 'chevD'} size={16} />
              </button>
            </h2>
            <div id={bodyId} hidden={!opened}>
              {group.body}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The opened card with what it reads: its history (read when it opens and
 * after each write) and its links' live state (read once when it opens, and
 * again when a link is added; never before a card is opened).
 */
function OpenedCard({
  card,
  projectName,
  projectRoot,
  sessions,
  live,
  phone,
  now,
  rowOf,
  onClose,
  onMove,
  onSend,
  onChanged,
  onOpenThread,
  onCreateThread,
}: {
  card: InboxCardWire;
  projectName: string;
  projectRoot: string | null;
  sessions: ComposeSessionsModel | null;
  live: { session: string; busy: boolean | null }[] | null;
  phone: boolean;
  now: number;
  rowOf: (threadId: string) => InboxListRow | null;
  onClose: () => void;
  onMove: (move: BoardMove) => Promise<void>;
  onSend: () => void;
  onChanged: (card?: InboxCardWire) => void;
  onOpenThread: (threadId: string) => void;
  onCreateThread: (session: string | null, opener: HTMLElement) => void;
}) {
  const [history, setHistory] = useState<InboxCardHistoryEntry[] | null>(null);
  // The card's own project's repo (not the window's): its text links `#123` there.
  const [repo, setRepo] = useState<InboxProjectRepo | null>(null);
  const [refs, setRefs] = useState<{ ref: InboxCardRef; result: ForgeRefCardResult }[] | null>(null);
  useEffect(() => {
    let alive = true;
    inboxApi
      .card(card.id)
      .then((answer) => {
        if (!alive) return;
        setHistory(answer.history);
        setRepo(answer.repo ?? null);
      })
      .catch(() => alive && setHistory([]));
    return () => {
      alive = false;
    };
  }, [card.id, card.heard_at]);
  const refKey = (card.refs ?? []).map((r) => r.url).join(' ') || card.prs.map((p) => p.url).join(' ');
  useEffect(() => {
    let alive = true;
    setRefs(null);
    if (!refKey) {
      setRefs([]);
      return;
    }
    inboxApi
      .cardRefs(card.id)
      .then((answer) => alive && setRefs(answer.refs))
      .catch(() => alive && setRefs([]));
    return () => {
      alive = false;
    };
  }, [card.id, refKey]);
  const agentSession = card.agent?.kind === 'agent' ? card.agent.session : null;
  // "Ask for an update" and "Create thread": the card's agent while it is live, else a live session in the card's project.
  const askTarget = (() => {
    if (!sessions) return null;
    const own = findTarget(sessions.projects, agentSession);
    if (own) return own;
    const group = sessions.projects.find((g) => g.project.id === card.project_id || (projectRoot !== null && g.project.root === projectRoot));
    return group?.sessions[0] ? { ...group.sessions[0], project: group.project } : null;
  })();
  /**
   * A message to the agent: into the card's thread when the card's own agent
   * is live there, else a new thread to the live session (linked to the
   * card). Answers the message's id.
   */
  // One key per action on this opened card, kept across retries (a lost answer replays the message
  // instead of sending a second one), and fresh after it went (a later Ask is a new message).
  const startKey = useRef(crypto.randomUUID());
  const askKey = useRef(crypto.randomUUID());
  const tellAgent = async (body: string, key: string, link: boolean): Promise<string> => {
    if (!askTarget) throw new Error('No agent is running in this project.');
    const idempotency = messageKey(key, askTarget.session, body);
    const thread = card.threads.find((id) => rowOf(id)?.project.id === card.project_id) ?? card.threads[0];
    if (thread && askTarget.session === agentSession) {
      const sent = await inboxApi.newMessage(thread, { session: askTarget.session, body, idempotency_key: idempotency });
      return sent.message.id;
    }
    const started = await inboxApi.startThread({ to: { host: askTarget.host, session: askTarget.session }, body, idempotency_key: idempotency });
    // A send links the thread itself; an Ask links it here.
    if (link) onChanged((await inboxApi.editCard(card.id, { op: 'link', thread_id: started.thread_id })).card);
    return started.message.id;
  };
  return (
    <CardPanel
      card={card}
      history={history}
      refs={refs}
      projectName={projectName}
      repo={repo}
      state={agentState(agentSession, live)}
      canAsk={askTarget !== null}
      askNote={
        askTarget && agentSession && askTarget.session !== agentSession
          ? `Its agent's session ended; this asks another ${hostLabel(askTarget.host)} session in ${askTarget.project.name}.`
          : null
      }
      rowOf={rowOf}
      phone={phone}
      now={now}
      onClose={onClose}
      onColumn={(column) => onMove(column === 'icebox' ? { op: 'icebox' } : { op: 'move', column })}
      onShip={() => onMove({ op: 'move', column: 'shipped' })}
      onIcebox={() => onMove({ op: 'icebox' })}
      onRestore={() => onMove({ op: 'restore' })}
      onDrop={(reason) => onMove({ op: 'drop', reason })}
      onSend={onSend}
      onStart={async () => {
        // Start: the card's agent (else a live session in its project) is told to begin, in the card's
        // thread when that agent is the card's own; the card shows "Sent to <agent>" until it moves.
        if (!askTarget) return 'No agent is running in this project.';
        try {
          const messageId = await tellAgent(startBody(card), startKey.current, false);
          onChanged((await inboxApi.editCard(card.id, { op: 'send', thread_id: messageId })).card);
          startKey.current = crypto.randomUUID();
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'Nothing was sent.';
        }
      }}
      onAsk={async () => {
        if (!askTarget) return 'No agent is running in this project.';
        try {
          await tellAgent(askWhereBody(card), askKey.current, true);
          askKey.current = crypto.randomUUID();
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'Nothing was sent.';
        }
      }}
      onNotes={async (notes) => {
        try {
          onChanged((await inboxApi.editCard(card.id, { op: 'edit', notes })).card);
          return true;
        } catch {
          return false;
        }
      }}
      onLink={async (ref) => {
        try {
          onChanged((await inboxApi.editCard(card.id, { op: 'link', ref })).card);
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'Not linked.';
        }
      }}
      onOpenThread={onOpenThread}
      onCreateThread={(opener) => onCreateThread(askTarget?.session ?? null, opener)}
    />
  );
}
