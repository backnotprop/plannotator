import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { INBOX_CARD_COLUMN_LABELS, INBOX_CARD_LIVE_COLUMNS, displayInboxSubject, inboxCardMarkRef, type InboxCardColumn, type InboxCardMark, type InboxCardHistoryEntry, type InboxCardRef, type InboxCardWire, type InboxListRow, type InboxProjectRepo, type InboxInitiative } from '@plannotator/core/inbox-types';
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
import { CardMenu } from './CardMenu';
import type { InboxToastModel } from '../components/Toast';
import { shortcutAria } from '../shortcuts/hint';
import { inboxListShortcuts } from '../shortcuts/list.shortcuts';
import { OnceButton } from './OnceButton';
import { RefMark, markLabel } from './RefMark';
import { useCardMarks } from './useCardMarks';
import { NewCardDialog, type NewCardInput } from './NewCardDialog';
import { BoardIntro, useCopyBoardPrompt } from './BoardIntro';
import { TidyMenu, type TidyController } from '../components/Tidy';
import { BoardFilter, BoardFilterTokens, initiativeLabel } from './BoardFilter';
import { InitiativesDialog } from './InitiativesDialog';
import { restoreInitiatives } from './initiativeUndo';
import { projectNames } from '../search/model';
import {
  agentState,
  askWhereBody,
  BOARD_LANE_COLUMNS,
  boardCounts,
  boardLanes,
  boardProjects,
  cardsInInitiative,
  cardsInProject,
  initiativeCounts,
  initiativeDeletedToast,
  liveInitiatives,
  newCardInitiative,
  inDoneLane,
  BOARD_FILTER_ROW_BELOW,
  cardAge,
  cardLabel,
  cardLine,
  cardMenuToast,
  cardMessageBody,
  cardUndoStillApplies,
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
  waitingLinkLabel,
  waitingThread,
  type BoardMove,
  type BoardView,
} from './model';
import { newUuid } from '../uuid';
import { noteOneTimeDialogShown } from '../snoozeIntro';
import { cardStepLists, stepsWaitWords } from '../steps/model';
import { StepGlyph } from '../steps/StepsMarks';
import type { InboxStepsWire } from '@plannotator/core/inbox-types';

export type { BoardMove } from './model';

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
  /** The person looked at these agents' drops ("Got it", or the Cancelled page while it is in front): only those are marked seen. */
  onSeeDrops: (ids: readonly string[]) => void;
  /** A thread of the opened card opens in the Inbox view, with a way back to the card. */
  onOpenThread: (card: InboxCardWire, threadId: string) => void;
  /** Create thread (an opened card with no thread): compose to `session` (the card's agent, else a live session in its project), linked to the card on Send. */
  onCreateThread: (card: InboxCardWire, session: string | null, opener: HTMLElement) => void;
  /** Read the lane cards' marks (their linked PR's or issue's state). False on a tailnet guest's page (and in tests that do not serve them). */
  marks?: boolean;
  /** Tidy (2026-10-28): the header's ⋮ menu (Tidy, Refresh). Absent: no menu. */
  tidy?: TidyController;
  /**
   * The project the Board shows (`#board&project=prj_…`, the list's own key), or null for every card.
   * Lanes, counts, Done, Cancelled and the agents' drops all follow it.
   */
  project?: string | null;
  onProject?: (project: string | null) => void;
  /**
   * The initiative the Board shows (`#board&initiative=ini_…`, or `none` for the cards in none), with the
   * project filter: one filter, two parts (approval "board-initiatives"). Null: every initiative.
   */
  initiative?: string | null;
  onInitiative?: (initiative: string | null) => void;
  /** Show all: both parts of the filter cleared in one step (one history entry). Absent: each part's own. */
  onClearFilter?: () => void;
  /**
   * The window's one toast, with its Undo (`Z`), or null to take it down. Shown only when a card leaves
   * the lanes from its right-click menu (`cardMenuToast`). Absent: no toast, the live region alone.
   */
  onToast?: (toast: Omit<InboxToastModel, 'id'> | null) => void;
}

/**
 * The Board (approval "inbox-board", step 2; columns v2): five lanes, Backlog,
 * Todo, In progress, In review and Done (its last seven days), cards in
 * variant C "Lean", All done and Cancelled as links to their own lists, the
 * agents' unseen drops above the lanes. A card opens in
 * a panel beside the Board (the lanes narrow and scroll, so the card's lane
 * stays in view); on a phone the lanes are one stacked list (Done and
 * Cancelled folded at the end) and an opened card is a full screen. Every move
 * is on the opened card's column menu (the keyboard's way), and on a desktop
 * a card can be dragged to another lane.
 */
export function BoardPage(props: BoardPageProps) {
  const { model, view, phone } = props;
  const allCards = model?.cards ?? [];
  /** The cards as the window has them now: a toast's Undo, run later, checks the card against them. */
  const cardsRef = useRef(allCards);
  cardsRef.current = allCards;
  const project = props.project ?? null;
  const initiative = props.initiative ?? null;
  // Filtered to a project and/or an initiative: everything below reads only those cards (the opened card is found among all).
  const projectCards = cardsInProject(allCards, project);
  const names = useMemo(() => projectNames(props.projects), [props.projects]);
  const offered = boardProjects(allCards, props.projects, project);
  const projectName = project ? (names.get(project) ?? null) : null;
  const initiatives = useMemo(() => liveInitiatives(model?.initiatives), [model?.initiatives]);
  const cards = cardsInInitiative(projectCards, initiative, initiatives);
  const initiativeName = initiativeLabel(initiatives, initiative);
  const counts = boardCounts(cards);
  const drops = unseenDrops(cards);
  const [creating, setCreating] = useState<null | 'backlog' | 'send'>(null);
  /** The Initiatives dialog (the filter's New initiative… or Edit initiatives…). */
  const [managing, setManaging] = useState<null | 'new' | 'edit'>(null);
  const [intro, setIntro] = useState(false);
  const claimed = useRef(false);
  useEffect(() => {
    if (claimed.current || props.claimIntro === false) return;
    claimed.current = true;
    inboxApi
      .claimBoardIntro()
      .then((answer) => {
        if (!answer.show) return;
        // Another one-time dialog this load: no Snooze announcement on it (snoozeIntro.ts).
        noteOneTimeDialogShown();
        setIntro(true);
      })
      .catch(() => {});
  }, [props.claimIntro]);
  const promptCopy = useCopyBoardPrompt(props.mcpCommand);
  const [sendingCard, setSendingCard] = useState<InboxCardWire | null>(null);
  const [said, setSaid] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Cards on the lanes (Backlog, and Done's last week, too): none is the empty Board's line.
  const onLanes = (card: InboxCardWire) => INBOX_CARD_LIVE_COLUMNS.includes(card.column) || inDoneLane(card, now);
  const liveCount = cards.filter(onLanes).length;
  // The filter's counts: the cards on the lanes of the picked project, per initiative (and in none).
  const filterCounts = initiativeCounts(projectCards.filter(onLanes), initiatives);
  /** Put a card in an initiative (or none): the card menu's Initiative and the opened card's. */
  const setInitiative = async (card: InboxCardWire, next: string | null) => {
    setFailed(null);
    try {
      const { card: changed } = await inboxApi.setCardInitiative(card.id, next);
      props.onChanged(changed);
      const name = next ? (initiatives.find((i) => i.id === next)?.name ?? 'the initiative') : null;
      setSaid(name ? `“${card.title}” is in ${name} now.` : `“${card.title}” is in no initiative now.`);
    } catch {
      setFailed(`“${card.title}” did not change. Try again.`);
    }
  };
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
    // The menu's Drop… was for the card that just closed (or was replaced): opening it again later is a plain open.
    if (was && was !== props.openCard) setDropAsk((ask) => (ask?.id === was ? null : ask));
    if (!was || props.openCard) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const heading = document.getElementById(titleId);
    const root = heading?.closest('.ib-bpage') ?? document;
    const button = root.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(was)}"] [data-card-open]`);
    (button ?? heading)?.focus();
  }, [props.openCard]);

  /**
   * Move a card. `fromMenu`: the right-click menu asked (or a Drop… it started): a card that leaves the
   * lanes says so in the window's toast, with Undo (`cardMenuToast`); any other move only in the live region.
   */
  const move = async (card: InboxCardWire, change: BoardMove, fromMenu = false): Promise<InboxCardWire | null> => {
    setFailed(null);
    const moved = await props.onMove(card, change);
    if (!moved) {
      setFailed(`“${card.title}” did not move. Try again.`);
      return null;
    }
    const toast = fromMenu && props.onToast ? cardMenuToast(card, moved) : null;
    if (toast) {
      // The toast's live region says it, with how to undo it: the Board's own stays quiet.
      props.onToast!({ icon: 'check', lead: toast.lead, detail: toast.detail, onUndo: () => void undoMove(moved, toast.undo) });
    } else {
      setSaid(moveSaid(card, moved));
    }
    return moved;
  };
  /**
   * The Initiatives dialog closed with its Undo still up: the window's toast takes it over, so Done never loses it.
   * Every restore is tried (`restoreInitiatives`); a failed save offers Undo again, a name taken since only says so.
   */
  const undoableInitiatives = (deleted: readonly InboxInitiative[]) => {
    props.onToast?.({ icon: 'check', ...initiativeDeletedToast(deleted), onUndo: () => void undoInitiatives(deleted) });
  };
  const undoInitiatives = async (deleted: readonly InboxInitiative[]) => {
    props.onToast?.(null);
    const { left, line } = await restoreInitiatives(deleted);
    if (line) props.onToast?.({ icon: 'warn', wrap: true, lead: line, ...(left.length > 0 ? { onUndo: () => void undoInitiatives(left) } : {}) });
    props.onChanged();
  };
  /**
   * The toast's Undo (or `Z`): the move back through the same route, then focus on the card where it is now.
   * A card moved on since (by an agent, or by the person elsewhere) is left where it is: nothing is sent.
   */
  const undoMove = async (moved: InboxCardWire, change: BoardMove) => {
    if (!cardUndoStillApplies(moved, cardsRef.current.find((c) => c.id === moved.id) ?? null)) {
      props.onToast?.({ icon: 'warn', lead: 'It has moved since', detail: `“${moved.title}”` });
      return;
    }
    props.onToast?.(null);
    const back = await move(moved, change);
    if (!back) return;
    // Two frames: the cards read again, then the lanes draw the card in its place.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => pageRef.current?.querySelector<HTMLElement>(`.ib-bcard[data-card-id="${CSS.escape(back.id)}"] [data-card-open]`)?.focus()),
    );
  };
  /** The card whose right-click menu is open (its muted fill). */
  const [menuId, setMenuId] = useState<string | null>(null);
  /** Drop… from a card's right-click menu: the opened card's reason field opens, focused (a new number each time). */
  const [dropAsk, setDropAsk] = useState<{ id: string; n: number } | null>(null);
  const menuKeys = shortcutAria({ scope: inboxListShortcuts, action: 'rowMenu' });

  // A New card dialog makes one card, whatever its retries. Each try that makes it has its own key and
  // its own content; when a try's answer is lost, the next try first replays that try exactly (its key,
  // its words), which answers the card it made (or makes it now), and then brings the card to what the
  // dialog says now (title, notes, added links, Backlog). So editing the title after a lost
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
    dialogKey.current = newUuid();
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
    const key = newUuid();
    const column = 'backlog' as const;
    if (input.mode === 'send' && input.to && !input.to.project.id) {
      // A folder the Inbox has not seen has no project yet: the thread makes it, and the card is
      // made and sent in one step with it (checked by the server before anything is written).
      const to = input.to;
      const body = cardMessageBody(input.title, input.notes, null);
      return {
        key,
        run: async () => {
          const started = await inboxApi.startThread({ to: { host: to.host, session: to.session }, body, idempotency_key: messageKey(key, to.session, body) });
          return (
            await inboxApi.createCard({ title: input.title, notes: input.notes, refs: input.refs, thread_id: started.thread_id, idempotency_key: key, initiative: input.initiative })
          ).card;
        },
      };
    }
    const project = input.mode === 'send' && input.to ? input.to.project.id : input.project;
    return {
      key,
      run: async () => (await inboxApi.createCard({ project, title: input.title, notes: input.notes, refs: input.refs, column, idempotency_key: key, initiative: input.initiative })).card,
    };
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
    if ((card.initiative ?? null) !== input.initiative) card = (await inboxApi.setCardInitiative(card.id, input.initiative)).card;
    // A card the dialog made but has not sent yet stays in Backlog (a send moves it to Todo).
    if (!card.sent && card.column !== 'backlog') card = (await inboxApi.moveCard(card.id, { op: 'move', column: 'backlog' })).card;
    dialogCard.current = card;
    madeFrom.current = { input, target };
    return card;
  };

  /**
   * Make a card from New card: Backlog in a project, or sent to an agent
   * (Todo). Sending makes the card first (Backlog, in the session's project)
   * and names it in the message, so the agent never gets "it is yours now"
   * for a card that does not exist; a retry reuses the card and the key.
   */
  const create = async (input: NewCardInput): Promise<string | null> => {
    const key = dialogKey.current || newUuid();
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
        setSaid(`Added “${input.title}” to Backlog${elsewhere}.`);
      }
      setCreating(null);
      resetDialog();
      return null;
    } catch (cause) {
      if (dialogCard.current) props.onChanged(dialogCard.current);
      return cause instanceof Error ? cause.message : 'The card was not made. Try again.';
    }
  };

  /** Send a card nobody was asked about: a new thread to the agent (its notes the message), then the card is sent. */
  const sendExisting = async (card: InboxCardWire, input: NewCardInput): Promise<string | null> => {
    if (!input.to) return 'Choose an agent to send it to.';
    const key = dialogKey.current || newUuid();
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
  // header, as on a phone, so it is never cut to a few letters.
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
  // The checklist (approval "inbox-thread-steps", part 4): the lists of the card's threads, while the switch is on.
  const stepsOf = (card: InboxCardWire) => cardStepLists(card.threads, model?.steps);

  const common: CardCommon = {
    visitLook: props.visitLook,
    handled: props.handled,
    now,
    phone,
    openId: props.openCard,
    menuId,
    menuKeys,
    rowOf: props.rowOf,
    markOf,
    stepsOf,
    onOpen: (card) => props.onOpenCard(card.id),
    onOpenThread: props.onOpenThread,
  };

  // The one filter (approval "board-initiatives"): an icon at the header's right, its picks as tokens left
  // of it (on their own row on a phone or a narrow page), and the way back to every card when it hides them all.
  const showFilter = model !== null && props.onProject !== undefined;
  const filtered = project !== null || initiative !== null;
  const filterProps = {
    projects: offered,
    names,
    project,
    onProject: (next: string | null) => props.onProject?.(next),
    initiatives,
    counts: filterCounts,
    initiative,
    onInitiative: (next: string | null) => props.onInitiative?.(next),
    onManage: setManaging,
    phone,
  };
  const filter = showFilter ? <BoardFilter {...filterProps} tokens={!phone && !narrowHead} /> : null;
  const tokenRow = showFilter && (phone || narrowHead) && filtered ? <BoardFilterTokens {...filterProps} /> : null;
  // What the filter shows, in words: "Shape", "plannotator", "Shape in plannotator".
  const scope = initiativeName && projectName ? `${initiativeName} in ${projectName}` : (initiativeName ?? projectName ?? 'this project');
  const inProject = <b dir="auto">{scope}</b>;
  const showAll = (
    <button
      type="button"
      className="ib-btn ib-sm"
      onClick={() => {
        if (props.onClearFilter) props.onClearFilter();
        else {
          if (project !== null) props.onProject?.(null);
          if (initiative !== null) props.onInitiative?.(null);
        }
        requestAnimationFrame(() => document.getElementById(titleId)?.focus());
      }}
      data-board-show-all=""
    >
      {initiative !== null ? 'Show all cards' : 'Show all projects'}
    </button>
  );
  // Say a new filter once it lands (not on the first draw).
  const saidFilter = useRef(`${project}|${initiative}`);
  useEffect(() => {
    const key = `${project}|${initiative}`;
    if (saidFilter.current === key) return;
    saidFilter.current = key;
    setSaid(filtered ? `Showing the cards in ${scope}.` : 'Showing every card.');
  }, [project, initiative, scope, filtered]);

  let body: ReactNode;
  if (!model) body = props.error ? <div className="ib-error">{props.error}</div> : <div className="ib-bload" aria-busy="true" />;
  else if (phone && filtered && cards.length === 0)
    body = (
      <div className="ib-bempty ib-bempty-in" data-board-empty="project">
        <span>No cards in {inProject}</span>
        {showAll}
      </div>
    );
  else if (phone) body = <PhoneBoard cards={cards} counts={counts} {...common} onRestore={(card) => move(card, { op: 'restore' })} />;
  else if (view === 'done')
    body = (
      <CardList
        title="Done"
        empty={filtered ? <>Nothing done in {inProject} yet.</> : 'Nothing done yet. A card goes here when its work is merged, live or finished.'}
        cards={cards.filter((c) => c.column === 'done')}
        {...common}
      />
    );
  else if (view === 'cancelled')
    body = <CancelledPage cards={cards} inProject={filtered ? inProject : null} onRestore={(card) => move(card, { op: 'restore' })} onSeeDrops={props.onSeeDrops} unseen={drops} />;
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
      steps={stepsOf(open)}
      onClose={() => props.onOpenCard(null)}
      onMove={async (change, fromMenu) => void (await move(open, change, fromMenu))}
      dropAsk={dropAsk?.id === open.id ? dropAsk.n : 0}
      onSend={() => openSend(open)}
      onChanged={props.onChanged}
      onOpenThread={(threadId) => props.onOpenThread(open, threadId)}
      onCreateThread={(session, opener) => props.onCreateThread(open, session, opener)}
      initiatives={model?.initiatives ?? []}
      onInitiative={(next) => void setInitiative(open, next)}
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
      <div className="ib-bhead" data-narrow={narrowHead && !phone ? '' : undefined}>
        <SidebarTrigger />
        {view !== 'lanes' && !phone ? (
          <>
            <button type="button" className="ib-bback" data-board-back="" onClick={() => props.onView('lanes')}>
              <Icon name="chevL" size={16} />
              Board
            </button>
            <h1 id={titleId} tabIndex={-1}>
              {view === 'done' ? 'Done' : 'Cancelled'}
            </h1>
          </>
        ) : (
          <>
            <h1 id={titleId} tabIndex={-1}>
              Board
            </h1>
          </>
        )}
        <span className="ib-bsp" />
        {/* The one filter (approval "board-initiatives"): its tokens, then its icon, right of the gap. */}
        {filter}
        {/* The "?" sits left of Done and Cancelled (the intro mock). */}
        {(view === 'lanes' || phone) && (
          <Tip content="About the Board">
            <button type="button" className="ib-iconbtn ib-babout" aria-label="About the Board" aria-haspopup="dialog" onClick={() => setIntro(true)} data-board-about="">
              <Icon name="question" size={17} />
            </button>
          </Tip>
        )}
        {!phone && view === 'lanes' && model && (
          <nav className="ib-blinks" aria-label="Cards out of the lanes">
            <a href="#board=done" data-board-link="done" onClick={(event) => (event.preventDefault(), props.onView('done'))}>
              All done
            </a>
            <span aria-hidden="true">·</span>
            <a href="#board=cancelled" data-board-link="cancelled" onClick={(event) => (event.preventDefault(), props.onView('cancelled'))}>
              Cancelled {formatCount(counts.dropped)}
            </a>
          </nav>
        )}
        {(view === 'lanes' || phone) && <NewCardButton disabled={props.projects.length === 0 && !(live && live.length > 0)} phone={phone} onOpen={() => openCreate('backlog')} />}
        {props.tidy && (view === 'lanes' || phone) && (
          <TidyMenu tidy={props.tidy} phone={phone} className="ib-bhead-more" onRefresh={() => props.onChanged()} />
        )}
      </div>
      {tokenRow && <div className="ib-bfbar">{tokenRow}</div>}
      {model && drops.length > 0 && view !== 'cancelled' && (
        <DroppedNotice drops={drops} onRestore={(card) => move(card, { op: 'restore' })} onSeen={() => props.onSeeDrops(drops.map((card) => card.id))} onOpenCancelled={phone ? null : () => props.onView('cancelled')} />
      )}
      {failed && (
        <div className="ib-error ib-bfail" role="alert">
          {failed}
        </div>
      )}
      <CardMenu
        className="ib-bmain"
        cardOf={(id) => allCards.find((c) => c.id === id) ?? null}
        rowOf={props.rowOf}
        onTarget={setMenuId}
        onColumn={(card, column) => void move(card, { op: 'move', column }, true)}
        onRestore={(card) => void move(card, { op: 'restore' })}
        onDrop={(card) => {
          setDropAsk((ask) => ({ id: card.id, n: (ask?.n ?? 0) + 1 }));
          props.onOpenCard(card.id);
        }}
        onOpenThread={props.onOpenThread}
        initiatives={initiatives}
        onInitiative={(card, next) => void setInitiative(card, next)}
      >
        {body}
        {panel}
        {model && view === 'lanes' && !phone && liveCount === 0 && !open && filtered && (
          <div className="ib-bempty" data-board-empty="project">
            <span>Nothing in flight in {inProject}</span>
            {showAll}
          </div>
        )}
        {model && view === 'lanes' && !phone && liveCount === 0 && !open && !filtered && (
          <div className="ib-bempty" data-board-empty="">
            No cards yet
            <button type="button" className="ib-btn ib-sm" onClick={() => void promptCopy.copy()} data-board-empty-copy="">
              <Icon name={promptCopy.state === 'copied' ? 'check' : 'copy'} size={14} />
              {promptCopy.state === 'copied' ? 'Copied' : 'Copy prompt'}
            </button>
          </div>
        )}
      </CardMenu>
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
          initiatives={initiatives}
          defaultInitiative={newCardInitiative(initiative)}
          onClose={() => setCreating(null)}
          onCreate={create}
        />
      )}
      {managing && (
        <InitiativesDialog
          initiatives={initiatives}
          start={managing}
          phone={phone}
          onClose={() => setManaging(null)}
          onChanged={() => props.onChanged()}
          onCloseWithUndo={undoableInitiatives}
          fallbackFocus={() => pageRef.current?.querySelector<HTMLElement>('[data-board-filter-button]') ?? null}
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
  /** The card whose right-click menu is open: its hover look and a muted fill. */
  menuId: string | null;
  /** `aria-keyshortcuts` for the card's right-click menu (Shift+F10, the thread rows' key). */
  menuKeys: string | undefined;
  rowOf: (threadId: string) => InboxListRow | null;
  /** The card's lane mark (its linked PR or issue), null when it links neither. */
  markOf: (card: InboxCardWire) => InboxCardMark | null;
  /** The card's checklists, the latest first (none while the switch is off): the first one's pie is on the card. */
  stepsOf: (card: InboxCardWire) => InboxStepsWire[];
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
    const index = BOARD_LANE_COLUMNS.indexOf(openColumn);
    if (index < 0) return;
    const start = laneWindowStart(index, fit, BOARD_LANE_COLUMNS.length);
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
      {boardLanes(cards, common.now).map((lane) => {
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
  backlog: 'No ideas here. A card here is not sent to any agent.',
  todo: 'Nothing asked and waiting to start.',
  in_progress: 'No agent is working on anything.',
  in_review: 'Nothing waits on your review.',
  done: 'Nothing done in the last 7 days.',
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
  menuId,
  menuKeys,
  rowOf,
  markOf,
  stepsOf,
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
  // The checklist's mark (approval "inbox-checklist-spinners-2026-11-07"): the lane card stays still, with nothing
  // while the agent works and the still amber pause only while a list waits on the person; the opened card has the rest.
  const planWords = stepsWaitWords(stepsOf(card));
  const label = cardLabel(card, unread, now) + (sent ? `. Sent to ${sent}` : '') + (mark ? `. ${markLabel(mark)}` : '') + (planWords ? `. ${planWords}` : '');
  const thread = line?.you ? youThread(card, rowOf) : null;
  // "Waiting on you" (columns v2, display only): a card before In review whose linked thread waits on the person.
  const waiting = line?.you ? null : waitingThread(card, rowOf);
  const waitingSubject = waiting ? displayInboxSubject(rowOf(waiting)?.subject) : null;
  // "Title row" (approval board-lane-card, r1): a card is its title row, the marks and the age at its right.
  // A second line only when the person owes something ("You: …", "Waiting on you") or a send is pending
  // ("Sent to …"); the agent's last word is left off the lane card and stays in the opened card. Never an empty second line.
  const oneLine = !sent && !line?.you && !waiting;
  const owner = cardOwnerName(card);
  const meta = (
    <span className="ib-bc-meta">
      {mark && <RefMark mark={mark} />}
      {planWords && (
        <Tip content={planWords}>
          <span className="ib-strow ib-bc-plan" data-card-steps="waiting">
            <StepGlyph status="waiting" size={13} />
          </span>
        </Tip>
      )}
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
      data-menu={menuId === card.id ? '' : undefined}
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
        <button type="button" className="ib-bc-main" aria-label={label} aria-current={openId === card.id || undefined} aria-keyshortcuts={menuKeys} data-card-open="" onClick={() => onOpen(card)}>
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
            ) : waiting ? (
              <button type="button" className="ib-bc-youlink" data-card-waiting={waiting} aria-label={waitingLinkLabel(waitingSubject)} onClick={() => onOpenThread(card, waiting)}>
                <b className="ib-bc-youw">Waiting on you:</b> <span className="ib-bc-yout">{waitingSubject ?? 'a question'}</span>
                <Icon name="arrowUpRight" size={12} />
              </button>
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

/** "2 cancelled by an agent", with each title and reason, until the person has looked. */
function DroppedNotice({
  drops,
  onRestore,
  onSeen,
  onOpenCancelled,
}: {
  drops: readonly InboxCardWire[];
  onRestore: (card: InboxCardWire) => unknown;
  onSeen: () => void;
  onOpenCancelled: (() => void) | null;
}) {
  const headingId = useId();
  return (
    <section className="ib-bdrops" aria-labelledby={headingId} data-dropped-notice={drops.length}>
      <div className="ib-bdrops-h">
        <Icon name="warn" size={16} />
        <h2 id={headingId}>
          {formatCount(drops.length)} cancelled by {drops.length === 1 ? 'an agent' : 'agents'}
        </h2>
        <span className="ib-bsp" />
        {onOpenCancelled && (
          <button type="button" className="ib-lnk" onClick={onOpenCancelled}>
            See Cancelled
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

/** A list of cards (Done), newest move first. */
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
 * The Cancelled page (the Dropped column; approval "inbox-board-columns-v2"):
 * each card with the date, who cancelled it, the reason and Restore. Opening
 * it is the person looking at the agents' cancels.
 */
function CancelledPage({
  cards,
  inProject,
  onRestore,
  onSeeDrops,
  unseen,
}: {
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
  const dropped = cards.filter((c) => c.column === 'dropped').sort((a, b) => (b.dropped?.at ?? b.moved_at).localeCompare(a.dropped?.at ?? a.moved_at));
  return (
    <div className="ib-blists">
      <DroppedList cards={dropped} onRestore={onRestore} inProject={inProject} />
    </div>
  );
}

function DroppedList({ cards, onRestore, inProject = null }: { cards: readonly InboxCardWire[]; onRestore: (card: InboxCardWire) => unknown; inProject?: ReactNode }) {
  const id = useId();
  return (
    <section className="ib-blist" aria-labelledby={id} data-dropped-list="">
      <h2 id={id} className="ib-blist-h" tabIndex={-1}>
        Cancelled <span className="ib-lane-n">{formatCount(cards.length)}</span>
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
                    {card.dropped ? `Cancelled ${whenTime(card.dropped.at)} by ${by}` : 'Cancelled'}
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
        <p className="ib-lane-empty">{inProject ? <>Nothing cancelled in {inProject}.</> : 'Nothing cancelled. A cancelled card is kept here and can be restored.'}</p>
      )}
    </section>
  );
}

/**
 * A phone: the lanes as one stacked list in column order, each foldable
 * (Done, its last seven days, and Cancelled folded at the end), Done ending
 * in "All done" when older cards are done. No drag: a card opens full
 * screen, where its column menu moves it.
 */
function PhoneBoard({
  cards,
  counts,
  onRestore,
  ...common
}: CardCommon & { cards: readonly InboxCardWire[]; counts: ReturnType<typeof boardCounts>; onRestore: (card: InboxCardWire) => unknown }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(['done', 'dropped']));
  const [allDone, setAllDone] = useState(false);
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
  const done = cards.filter((c) => c.column === 'done');
  const stackRef = useRef<HTMLDivElement | null>(null);
  // "All done" leaves the page when tapped: focus goes to the first card it shows, never to the body.
  const [focusCard, setFocusCard] = useState<string | null>(null);
  useEffect(() => {
    if (!focusCard) return;
    setFocusCard(null);
    stackRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(focusCard)}"] [data-card-open]`)?.focus();
  }, [focusCard]);
  const groups: { key: string; label: string; count: number; body: ReactNode }[] = boardLanes(cards, common.now).map((lane) => {
    if (lane.column !== 'done') return { key: lane.column, label: lane.label, count: lane.cards.length, body: list(lane.cards, LANE_EMPTY[lane.column] ?? '') };
    const recent = new Set(lane.cards.map((card) => card.id));
    const older = done.filter((card) => !recent.has(card.id));
    const showAll = allDone && older.length > 0;
    return {
      key: 'done',
      label: lane.label,
      count: showAll ? done.length : lane.cards.length,
      body: (
        <>
          {showAll ? list(done, '') : list(lane.cards, LANE_EMPTY.done ?? '')}
          {older.length > 0 && !showAll && (
            <button
              type="button"
              className="ib-lnk ib-bdoneall"
              data-board-done-all=""
              onClick={() => {
                setAllDone(true);
                setFocusCard(older[0]!.id);
              }}
            >
              All done ({formatCount(done.length)})
            </button>
          )}
        </>
      ),
    };
  });
  const dropped = cards.filter((c) => c.column === 'dropped');
  groups.push({
    key: 'dropped',
    label: 'Cancelled',
    count: counts.dropped,
    body: dropped.length > 0 ? <DroppedList cards={dropped} onRestore={onRestore} /> : <p className="ib-lane-empty">Nothing cancelled.</p>,
  });
  return (
    <div ref={stackRef} className="ib-bstack">
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
  steps,
  onClose,
  onMove,
  dropAsk,
  onSend,
  onChanged,
  onOpenThread,
  onCreateThread,
  initiatives,
  onInitiative,
}: {
  card: InboxCardWire;
  projectName: string;
  projectRoot: string | null;
  sessions: ComposeSessionsModel | null;
  live: { session: string; busy: boolean | null }[] | null;
  phone: boolean;
  now: number;
  rowOf: (threadId: string) => InboxListRow | null;
  steps: readonly InboxStepsWire[];
  onClose: () => void;
  /** `fromMenu`: a Drop… the card's right-click menu started (its toast). */
  onMove: (move: BoardMove, fromMenu?: boolean) => Promise<void>;
  /** Drop… from the card's right-click menu (a new number each time): the reason field opens, focused. */
  dropAsk: number;
  onSend: () => void;
  onChanged: (card?: InboxCardWire) => void;
  onOpenThread: (threadId: string) => void;
  onCreateThread: (session: string | null, opener: HTMLElement) => void;
  /** Every initiative, deleted ones too (the history names them); the menu offers the live ones. */
  initiatives: readonly InboxInitiative[];
  onInitiative: (initiative: string | null) => void;
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
  const startKey = useRef(newUuid());
  const askKey = useRef(newUuid());
  const tellAgent = async (body: string, key: string, link: boolean): Promise<string> => {
    if (!askTarget) throw new Error('No agent is running in this project.');
    const idempotency = messageKey(key, askTarget.session, body);
    const thread = card.threads.find((id) => rowOf(id)?.project.id === card.project_id) ?? card.threads[0];
    if (thread && askTarget.session === agentSession) {
      const sent = await inboxApi.newMessage(thread, { session: askTarget.session, body, idempotency_key: idempotency });
      // Board cards are this Inbox's own, so its threads are too: a message is never held for another machine here.
      return sent.message?.id ?? idempotency;
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
      initiatives={initiatives}
      onInitiative={onInitiative}
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
      steps={steps}
      phone={phone}
      now={now}
      onClose={onClose}
      onColumn={(column) => onMove({ op: 'move', column })}
      onShip={() => onMove({ op: 'move', column: 'done' })}
      onRestore={() => onMove({ op: 'restore' })}
      onDrop={(reason, fromMenu) => onMove({ op: 'drop', reason }, fromMenu)}
      dropAsk={dropAsk}
      onSend={onSend}
      onStart={async () => {
        // Start: the card's agent (else a live session in its project) is told to begin, in the card's
        // thread when that agent is the card's own; the card shows "Sent to <agent>" until it moves.
        if (!askTarget) return 'No agent is running in this project.';
        try {
          const messageId = await tellAgent(startBody(card), startKey.current, false);
          onChanged((await inboxApi.editCard(card.id, { op: 'send', thread_id: messageId })).card);
          startKey.current = newUuid();
          return null;
        } catch (cause) {
          return cause instanceof Error ? cause.message : 'Nothing was sent.';
        }
      }}
      onAsk={async () => {
        if (!askTarget) return 'No agent is running in this project.';
        try {
          await tellAgent(askWhereBody(card), askKey.current, true);
          askKey.current = newUuid();
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
