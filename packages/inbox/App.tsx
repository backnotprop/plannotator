/**
 * The Plannotator Inbox window (`plannotator inbox`), built to its design of
 * record (kept privately, not in this repo). A mail client for
 * what agents send: the list in the approved sections (a row is a thread),
 * the thread read as an email with Plannotator's question cards, pick then
 * Send, and Settings.
 *
 * Routing is the URL hash (`#thread=msg_…`, `#project=prj_…`, `#settings`),
 * the same `#thread=` the MCP tools hand agents. An older link to the removed
 * Decisions page (`#decisions=…`) opens the list.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { TooltipProvider } from '@plannotator/ui/components/Tooltip';
import { TIP_DELAY_MS } from './components/Tip';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { selectionToolbarShowing } from './selectionToolbar';
import { storage } from '@plannotator/ui/utils/storage';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import type { InboxHealth, InboxListRow, InboxListSection, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import {
  InboxApiError,
  inboxApi,
  setPageSession,
  subscribeInboxEvents,
  type AgentToolHost,
  type ListModel,
  type SettingsModel,
  type UpdateDetails,
  type WhatsNewModel,
} from './api';
import { addOwnThreads, adoptKeepingOpen, filterSections, heldNotice, markHeldRowArchived, refreshHeldRows, settleOwn, settleThread, showBroughtIn, waitingCount, type OpenThread } from './held';
import { hasMovingDelivery } from './rowDelivery';
import {
  captureSettle,
  COVERED_LIST_SETTLES,
  listBody,
  playSettle,
  prefersReducedMotion,
  rowInSlot,
  SETTLE_AFTER_SIDEBAR_MS,
  SETTLE_BEAT_MS,
  SHOW_LIT_AFTER_SLIDE_MS,
  SHOW_LIT_MS,
  stopSettle,
  type SettleSnapshot,
} from './settle';
import { tildePath } from './format';
import { inboxImageSrcResolver } from './images';
import { shellLine, type ConnectContext } from './harnesses';
import { Sidebar } from './components/Sidebar';
import { SidebarShell } from './shell/SidebarShell';
import { InboxList } from './components/InboxList';
import { ThreadPane } from './components/Thread';
import { SearchHost, type SearchLanding } from './components/SearchHost';
import { onOpenSearchKey } from './search/searchShortcut';
import { useShortcutScope } from '@plannotator/ui/shortcuts';
import { inboxThreadShortcuts } from './shortcuts/thread.shortcuts';
import { isComposingKey, isEditableTarget, isRepeatKey } from './shortcuts/guards';
import { EmptyState } from './components/EmptyState';
import { AgentNoteDialog } from './components/AgentNoteDialog';
import { cardReport, noteQuestionRows } from './agents';
import type { InboxAgentRow, InboxAgentsModel, InboxConnectReport } from '@plannotator/core/inbox-types';
import { SettingsPage } from './components/Settings';
import { ArchivedBlock } from './components/Archived';
import { NotificationAsk, TabSleptLine } from './components/NotificationAsk';
import { useInboxNotifications } from './notify';
import { pageInFront, useInboxSound } from './sound';
import { notificationLine, SoundIntroDialog } from './components/SoundIntro';
import { GuidePane } from './components/GuidePane';
import { AboutBlock, FailedDialog, RestartDialog, UpdateDialog, WhatsNewPage } from './components/Updates';
import { unsentReply } from './unsent';
import { InboxToast, type InboxToastModel, toastSpeech } from './components/Toast';
import { canToggleRead, MARK_READ_UNDO_MS, markReadToast } from './markRead';
import { threadLink, type RowMenuAction } from './rowMenu';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { newBatchId, projectAllArchived, projectBatchToast, projectsWithReadable, type ProjectAction } from './projectMenu';
import { lookBoundary } from './folding';
import { latestAgentSeq } from './seenOnSight';
import { isPhone, trackKeyboard, usePhone } from './phone';
import { installPasteFollowsField } from './pasteTarget';
import { installPlainTextPaste } from '@plannotator/ui/utils/pasteInsert';
import { LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, paneGutters, useStack } from './stack';
import { backTo, pushScreen } from './history';
import { adoptSavedTheme, inboxThemeSync } from './theme';
import { adoptSavedTextSize, applyRememberedTextSize } from './textSize';
import { parseSettingsHash, settingsHash, type SettingsSection } from './settingsRoute';
import { ComposeDialog, type ComposeRequest, type ComposeSent } from './compose/ComposeDialog';
import { DraftsPage } from './compose/DraftsPage';
import { useComposeSessions } from './compose/useComposeSessions';
import { composeActions, composeTargets, hostLabel, type ComposeAction } from './compose/model';
import type { DraftView } from './api';
import { inboxTabCount, useTabCount } from './tabCount';
import { BoardListPage, BoardPage, CardDialog, type BoardActions } from './components/Board';
import { askTarget, askWhereText, boardOf, type BoardView } from './board';
import { INBOX_CARD_COLUMN_LABELS, type InboxCardColumn, type InboxCardWire } from '@plannotator/core/inbox-types';
import type { CardMove, CardsModel } from './api';

// The Inbox has no /api/config and no browser-agent tools: settings stay in
// the page's own cookies, except the theme, which goes to config.json `theme`
// through the Inbox's settings route so plan review follows it (theme.ts).
// WebMCP is off.
// No image uploads either: a comment's image would need an upload route the
// Inbox does not have, so the composer says so instead of posting nowhere.
// The text size this browser last showed, on the document before the first render (textSize.ts).
applyRememberedTextSize();

configurePlannotatorUI({
  serverSync: inboxThemeSync,
  // ui's own hover text (annotation panel and toolbar, question cards, links to attachments) as ui's Tooltip,
  // never a native title (the owner, 2026-10-17).
  componentTooltips: true,
  // Images in a message load from the Inbox's per-message route (#1813).
  imageSrcResolver: inboxImageSrcResolver,
  webmcp: { enabled: false, namePrefix: 'plannotator.' },
  // The `/` and `$` skill picker (composers and comments on attached files)
  // lists this computer's global skills (approval "inbox-skill-references").
  skillCatalogTransport: async () => {
    const { skills } = await inboxApi.skills();
    return Array.isArray(skills) ? (skills as SkillCatalogEntry[]) : [];
  },
  // A Send composes ONE skills block for the whole message (skills.ts), so a
  // comment's `$name` stays plain text in the attachments' feedback.
  skillReferenceExport: false,
  // A comment on an attached file rides the person's next reply.
  skillInstructionsDestination: 'your reply',
  uploadTransport: {
    upload: async () => {
      throw new Error('Images cannot be added to a comment in the Inbox.');
    },
  },
});

const SIDEBAR_OPEN_COOKIE = 'plannotator-inbox-sidebar-open';
/** The session the person last sent a new message to (compose preselects it while it is live). */
const COMPOSE_LAST_COOKIE = 'plannotator-inbox-compose-last';
/** How often the Drafts page reads its drafts again, so each chip follows its session. */
const DRAFTS_REFRESH_MS = 10_000;
/** How long the refresh icon shows after a click on Inbox: one turn (inbox.css `ib-refresh-turn`, 500 ms), then back to the inbox icon. */
const REFRESH_SPIN_MS = 600;
/** Settings → Agents re-reads the agents this often while open, so "Open sessions" follows the sessions as they restart. */
const AGENTS_SESSIONS_REFRESH_MS = 5_000;
/** A look seen on sight that the server did not take is sent again this many times, 1 s, 2 s, 4 s… apart. */
const SEEN_RETRIES = 5;
const SEEN_RETRY_MS = 1000;
/** The What's new page asks again this often while the server fetches the notes (its request gives up after 10 s). */
const WHATS_NEW_RETRIES = 15;
const WHATS_NEW_RETRY_MS = 1000;

interface Route {
  page: 'inbox' | 'settings' | 'whats-new' | 'drafts' | 'board';
  /** The Board's page (`#board`, `#board=shipped`, `#board=icebox`; approval "inbox-board"). */
  board?: BoardView;
  /** The card open over the Board (`&card=crd_…`). */
  card?: string | null;
  /** The release whose notes the What's new page shows (`#whats-new=0.28.12`). */
  version?: string | null;
  project: string | null;
  thread: string | null;
  /**
   * An attachment open beside the thread: `file=att_…`, `v=sent` for the version the agent sent, `at=` an annotation to show,
   * `linked=` a page the attached HTML page links to, shown read-only over it (its path in the page's folder, `#fragment` kept).
   */
  file?: { id: string; version: 'current' | 'sent'; focus: string | null; linked?: string | null } | null;
  /** The message whose guided review is open over the window (`#thread=…&guide=msg_…`). */
  guide?: string | null;
  /**
   * A message to land on (`#thread=…&msg=msg_…`, a search result): the thread
   * opens there, the message unfolded, centred, focused and ringed. Dropped
   * from the hash once landed, so a reload does not jump again.
   */
  msg?: string | null;
  /** Settings' section (`#settings/<section>`); null is `#settings` alone (settingsRoute.ts). */
  section?: SettingsSection | null;
  /** `#settings/devices/pair`: Pair a phone is open. */
  pair?: boolean;
}

function readRoute(): Route {
  return routeOf(window.location.hash);
}

function routeOf(fullHash: string): Route {
  const hash = fullHash.replace(/^#/, '');
  const settingsAt = parseSettingsHash(hash);
  if (settingsAt) return { page: 'settings', project: null, thread: null, section: settingsAt.section, pair: settingsAt.pair };
  const params = new URLSearchParams(hash);
  if (params.has('whats-new')) return { page: 'whats-new', project: null, thread: null, version: params.get('whats-new') };
  if (params.has('drafts')) return { page: 'drafts', project: null, thread: null };
  if (params.has('board')) {
    const view = params.get('board');
    return { page: 'board', project: null, thread: null, board: view === 'shipped' || view === 'icebox' ? view : 'live', card: params.get('card') };
  }
  const thread = params.get('thread');
  const fileId = thread ? params.get('file') : null;
  return {
    page: 'inbox',
    project: params.get('project'),
    thread,
    file: fileId ? { id: fileId, version: params.get('v') === 'sent' ? 'sent' : 'current', focus: params.get('at'), linked: params.get('linked') } : null,
    guide: thread ? params.get('guide') : null,
    msg: thread ? params.get('msg') : null,
  };
}

/** The route's hash, `#thread=…` (empty for the list at rest). */
function hashOf(route: Route): string {
  let hash = '';
  if (route.page === 'settings') hash = settingsHash({ section: route.section ?? null, pair: route.pair });
  else if (route.page === 'whats-new') hash = new URLSearchParams({ 'whats-new': route.version ?? '' }).toString();
  else if (route.page === 'drafts') hash = 'drafts';
  else if (route.page === 'board') {
    hash = route.board === 'shipped' || route.board === 'icebox' ? `board=${route.board}` : 'board';
    if (route.card) hash += `&card=${encodeURIComponent(route.card)}`;
  }
  else {
    const params = new URLSearchParams();
    if (route.project) params.set('project', route.project);
    if (route.thread) params.set('thread', route.thread);
    if (route.thread && route.msg) params.set('msg', route.msg);
    if (route.thread && route.file) {
      params.set('file', route.file.id);
      if (route.file.version === 'sent') params.set('v', 'sent');
      if (route.file.focus) params.set('at', route.file.focus);
      if (route.file.linked) params.set('linked', route.file.linked);
    }
    if (route.thread && route.guide) params.set('guide', route.guide);
    hash = params.toString();
  }
  return hash ? `#${hash}` : '';
}

/** The hash the page shows now, in hashOf's spelling (`#` alone reads as none). */
function currentHash(): string {
  return window.location.hash === '#' ? '' : window.location.hash;
}

/**
 * Write the route to the hash. `replace` swaps the current history entry
 * instead of adding one: stepping between a thread's attachments, so one
 * Back returns to the thread rather than through every file. The entry keeps
 * its state (the screen it was opened from, history.ts), so that Back is still
 * the browser's Back on a phone.
 */
function writeRoute(route: Route, options: { replace?: boolean } = {}): void {
  const hash = hashOf(route);
  const next = hash || window.location.pathname + window.location.search;
  if (options.replace) {
    if (hash !== currentHash()) window.history.replaceState(window.history.state, '', next);
  } else {
    // Each entry remembers the one it was opened from, so a phone's way back can be the browser's own Back (closeTo).
    pushScreen(hash, currentHash(), next);
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** A `msg=` with no thread to land in (a hand-edited or truncated link) leaves the address bar; the route already ignores it. */
function stripStrayMsg(): void {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (!params.has('msg') || params.get('thread')) return;
  const hash = hashOf(readRoute());
  window.history.replaceState(window.history.state, '', hash || window.location.pathname + window.location.search);
}

/**
 * Leave the screen on top for the one under it (a thread for the list, a
 * file for its thread). On a phone that is the browser's Back when this
 * screen was opened from there (history.ts), so the swipe back and the Back
 * button agree. On a desktop, and for a screen reached any other way, it is
 * a new entry, so the browser's Back reopens what was just closed.
 */
function closeTo(route: Route): void {
  if (!((isPhone() || leavesCoveringPane(route)) && backTo(hashOf(route)))) writeRoute(route);
}

/**
 * Which panes cover their list now (a window too narrow for both, stack.ts),
 * kept in step by the window. Closing a covering thread back to the list is
 * then the browser's Back, as on a phone, so an iPad's swipe back and
 * `‹ Inbox` agree.
 * Every other close, and every close beside the list, stays a new entry, as on
 * a desktop.
 */
const covering = { thread: false };

function leavesCoveringPane(route: Route): boolean {
  const from = readRoute();
  if (covering.thread && route.page === 'inbox' && !route.thread) {
    return from.page === 'inbox' && !!from.thread && !from.file && !from.guide;
  }
  return false;
}

/** The thread covers the list (a phone, a stacked window): the list is out of sight while a thread is open. */
function listCovered(): boolean {
  return isPhone() || covering.thread;
}

/** A row of the list on screen, by its thread (one element per row: the wide, two-line or phone row). */
function rowElement(body: ParentNode, threadId: string): HTMLElement | null {
  return body.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`);
}

/**
 * The person's last way of acting: a key, or a pointer (a mouse, a finger,
 * a pen). The window moves focus for the person (to a closed thread's row, to
 * the row now in a gone row's slot, to the first row Show brought in) only
 * after a key: after a mouse or a tap it would put a row under the keyboard
 * that the person never chose, and `E` would mark it read.
 */
let lastInput: 'keyboard' | 'pointer' | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (lastInput = 'keyboard'), true);
  window.addEventListener('pointerdown', () => (lastInput = 'pointer'), true);
  // A screen reader (or switch access) presses a control with a click that no key or pointer came
  // before, and that counts no clicks (`detail` 0): the person is not using a mouse.
  window.addEventListener('click', (event) => {
    if (event.detail === 0) lastInput = 'keyboard';
  }, true);
}

/**
 * The element the person aimed a key at on purpose: one with keyboard focus
 * (`:focus-visible`). A row that holds focus because it was clicked, or because
 * the window put focus there after a mouse action, is not.
 */
function keyboardFocused(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    // A DOM without the selector (tests): focus counts.
    return true;
  }
}

/** Focus the first element on screen that matches one of `selectors`, in order (a list draws some rows twice, one hidden). */
function focusFirst(selectors: readonly string[]): void {
  for (const selector of selectors) {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => candidate.getClientRects().length > 0);
    if (el) {
      el.focus();
      return;
    }
  }
}

/** How often the first-run screen reads the agents again while it shows, and the least gap between two reads (focus and the timer). */
const FIRST_RUN_AGENTS_REFRESH_MS = 8_000;
const FIRST_RUN_AGENTS_MIN_GAP_MS = 2_000;

function platformOf(): ConnectContext['platform'] {
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  return 'linux';
}

/** A reply is being typed: the box holds unsent text, or a text field has focus. The sound dialog waits. */
function replyInProgress(): boolean {
  if (unsentReply()) return true;
  const active = document.activeElement as HTMLElement | null;
  return !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
}

function hasRows(sections: readonly InboxListSection[] | null): boolean {
  return !!sections && sections.some((s) => s.threads.length > 0);
}

function Inbox() {
  const [route, setRoute] = useState<Route>(readRoute);
  // Open or closed as the person left it (⌘B or the toggle): a cookie of the Inbox's own, open when absent.
  const [sidebarOpen, setSidebarOpen] = useState(() => storage.getItem(SIDEBAR_OPEN_COOKIE) !== 'false');
  const changeSidebar = useCallback((next: boolean) => {
    setSidebarOpen(next);
    storage.setItem(SIDEBAR_OPEN_COOKIE, String(next));
  }, []);
  const [latest, setLatest] = useState<ListModel | null>(null);
  /** The latest list read's sections, for the event stream's `deliveries` (which reads again only while a delivery can move). */
  const latestSectionsRef = useRef<ListModel['sections'] | null>(null);
  latestSectionsRef.current = latest?.sections ?? null;
  // The tab's count (tabCount.ts): every thread with news the person has not looked at, from the
  // latest read (not the held list on screen, and not the sidebar's project filter).
  useTabCount(useMemo(() => (latest ? inboxTabCount(latest.sections) : 0), [latest]));
  /** The list on screen: held until the person acts (the "N new" notice). */
  const [shown, setShown] = useState<InboxListSection[] | null>(null);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const [thread, setThread] = useState<InboxThread | null>(null);
  /** The open thread's own list row, from its read: an archived thread has none in the list. */
  const [threadRow, setThreadRow] = useState<InboxListRow | null>(null);
  /**
   * The open thread's "new since you looked" boundary (folding.ts), from
   * before this look, and `through`: what the window's looks this visit cover
   * (the newest agent message of the first read, raised as messages that
   * arrive while it is open are seen on sight, seenOnSight.ts). Null when the
   * thread carries no seqs (an older Inbox).
   */
  const [look, setLook] = useState<{ threadId: string; seq: number | null; through: number | null } | null>(null);
  const [settings, setSettings] = useState<SettingsModel | null>(null);
  /** The agents on this computer (GET /api/inbox/agents): the agent-note dialog and Settings → Agents. Null on an older Inbox. */
  const [agents, setAgentsState] = useState<InboxAgentsModel | null>(null);
  // Every read and every save of the agents takes a number; a read answered after a newer read or save
  // started (a re-read in flight while Turn on saved) never replaces the newer model.
  const agentsSeq = useRef(0);
  const setAgents = useCallback((next: InboxAgentsModel) => {
    agentsSeq.current += 1;
    setAgentsState(next);
  }, []);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  /** The first read of the agents is done (a run that opened the window has finished connecting): the agent-note dialog may decide. */
  const [agentsSettled, setAgentsSettled] = useState(false);
  /**
   * The one-time agent-note dialog: open on this load (with the agents it
   * asks about and the band's news, fixed when it opens), or shown on it.
   * Decided once per load, after the sound dialog and never on a load that
   * showed it.
   */
  const [agentNote, setAgentNote] = useState<'none' | 'shown' | { rows: InboxAgentRow[]; report: InboxConnectReport | null }>('none');
  const agentNoteDecided = useRef(false);
  /** The sound dialog's claim has answered on this load (or it was never due). */
  const [soundClaimed, setSoundClaimed] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [update, setUpdate] = useState<InboxHealth['update']>(null);
  const [restarting, setRestarting] = useState(false);
  /** This run started on a newer version: the sidebar's "What's new in X" link. */
  const [updated, setUpdated] = useState<string | null>(null);
  // Claude Code sessions a /reload-plugins would bring up to date: the sidebar's "Reload Claude Code N" (owner approval "restart-warning").
  const [restartClaudeCode, setRestartClaudeCode] = useState(0);
  /** The update control's dialogs and what they read (GET /api/inbox/update). */
  const [updateDialog, setUpdateDialog] = useState<null | 'update' | 'restart' | 'failed'>(null);
  const [updateDetails, setUpdateDetails] = useState<UpdateDetails | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  /** The person pressed Update now in this tab: once the new binary is in, the Inbox restarts itself. */
  const restartWhenReady = useRef(false);
  const [whatsNew, setWhatsNew] = useState<WhatsNewModel | null>(null);
  const [whatsNewError, setWhatsNewError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The one-time sound dialog: open on this load, or shown on it (then the notification ask line waits for another load). */
  const [soundDialog, setSoundDialog] = useState<'none' | 'open' | 'shown'>('none');
  const soundDialogAsked = useRef(false);
  const routeRef = useRef(route);
  routeRef.current = route;
  const sound = useInboxSound({
    settings: settings?.sound,
    onSettings: (next) => setSettings((current) => (current ? { ...current, sound: next } : current)),
  });
  /**
   * Search (the approved "inbox-search" design): the palette's code loads on
   * the first open and stays mounted after. It opens from the sidebar's
   * Search entry (and a phone's list header); no key opens it.
   */
  const [searchMounted, setSearchMounted] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpener = useRef<HTMLElement | null>(null);
  /** The landing a search result asked for: the query's words to highlight in that message, a question's card to focus. */
  const searchLanding = useRef<SearchLanding | null>(null);
  /**
   * Compose (a new message to a connected agent): open with what it starts
   * from (a draft, a session), and the drafts not sent (the sidebar's Drafts
   * row, the Drafts page).
   */
  const [compose, setCompose] = useState<ComposeRequest | null>(null);
  const composeOpener = useRef<HTMLElement | null>(null);
  /** Where focus goes once compose closes or a draft row goes: the opener, else `focusFallback(next)`. */
  const pendingFocus = useRef<{ opener: HTMLElement | null; next: string | null } | null>(null);
  const [drafts, setDrafts] = useState<DraftView[] | null>(null);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [lastSent, setLastSent] = useState<string | null>(() => storage.getItem(COMPOSE_LAST_COOKIE));
  /** The one toast (Mark read, Archive) with its Undo, and what the live region last said. */
  const [toast, setToast] = useState<InboxToastModel | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the toast's timer ends, and what was left of it while a swipe holds it. */
  const toastDeadline = useRef(0);
  const toastLeft = useRef<number | null>(null);
  const [said, setSaid] = useState('');
  /** The thread whose reply box opens once it is on screen (the warning toast's Reply). */
  const [replyFor, setReplyFor] = useState<string | null>(null);
  /** The thread pane on screen and whether anything covers it (ThreadPane's `onScreenChange`). */
  const threadOnScreenRef = useRef<{ threadId: string; covered: boolean } | null>(null);
  const notifications = useInboxNotifications({
    settings: settings?.notifications ?? null,
    // New questions ring the doorbell on their own rules (sound.ts), whatever notifications say.
    onQuestions: sound.questionsArrived,
    // The bell owns a question's sound when it is on and armed and no other Inbox tab is in front (notify.ts adds: this tab away).
    bellCovers: () => sound.settings.enabled && sound.armed && !sound.otherTabInFront(),
    // Another Inbox tab in front raises what arrives; this one stays quiet.
    otherTabInFront: () => sound.otherTabInFront(),
    // A question in the thread the person has open and visible raises nothing (the tab in front is notify.ts's check).
    threadOnScreen: (threadId) => {
      const pane = threadOnScreenRef.current;
      return pane !== null && pane.threadId === threadId && !pane.covered && routeRef.current.thread === threadId;
    },
    onSettings: (next) => setSettings((current) => (current ? { ...current, notifications: next } : current)),
    // A click on a notification: the thread opens, and the list on screen catches up, even with a
    // thread open. The one exception to "the list holds still while a thread is open" (settle.ts):
    // the person was away, and the thread notified may not be on screen at all.
    openThread: (threadId) => {
      writeRoute({ page: 'inbox', project: null, thread: threadId });
      void refreshList(true);
    },
    // A click on a burst's notice: the list at rest, as it now is.
    openList: () => {
      writeRoute({ page: 'inbox', project: null, thread: null });
      void refreshList(true);
    },
  });
  const { observe: observeEvent, flush: flushNotifications, setReach: setNotifyReach, windowReport, reportWindow } = notifications;

  useEffect(() => {
    const onHash = () => {
      stripStrayMsg();
      setRoute(readRoute());
    };
    stripStrayMsg();
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const latestRef = useRef(latest);
  latestRef.current = latest;
  /**
   * The threads opened in this tab (a row, a link, a notification, Settings'
   * Unarchive). One not on screen whose messages are all seen came in by the
   * person's own hand, not an agent's (held.ts).
   */
  const openedHere = useRef(new Set<string>());
  if (route.thread) openedHere.current.add(route.thread);
  /** The rows as they were just before the list on screen changes, when that change slides (settle.ts). */
  const slideFrom = useRef<SettleSnapshot | null>(null);
  /** Measure the rows now, so the next change of the list on screen slides from here. Nothing under reduced motion. */
  const armSlide = useCallback(() => {
    const body = prefersReducedMotion() ? null : listBody(rootRef.current);
    slideFrom.current = body ? captureSettle(body) : null;
  }, []);
  /**
   * Show's brief light (design record "inbox-polish", item 6): the list on
   * screen when Show was pressed, until the list it brings in is drawn; then
   * the rows it brought in (held.ts showBroughtIn) light up where they landed,
   * once they have slid into place, and the light is taken off after it fades.
   * Only Show lights rows: not a thread's close, not the first load.
   */
  const showFrom = useRef<InboxListSection[] | null>(null);
  const [lit, setLit] = useState<ReadonlySet<string>>(() => new Set());
  const litTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearLit = useCallback(() => {
    for (const timer of litTimers.current) clearTimeout(timer);
    litTimers.current = [];
  }, []);
  useEffect(() => clearLit, [clearLit]);
  /** Clicking Inbox with a thread open: the close adopts the refresh's read instead of settling (refreshInbox). */
  const refreshPending = useRef(false);
  /** The refresh signal: the Inbox row's (or the list title's) refresh icon turns once. */
  const [refreshSpin, setRefreshSpin] = useState<{ key: number; scope: string | null } | null>(null);
  /** The settle waiting out its beat after a thread closed (settle.ts). */
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The thread just closed, until the list settles: like the open thread, it
   * is never held (held.ts): never in "N new", its row kept as it now is, and
   * it settles where its state puts it (design record "inbox-new-in-open-thread").
   */
  const closing = useRef<OpenThread | null>(null);
  /**
   * The thread the held list treats as open: the route's, else the one
   * closing (with its row as it stood at the close, so an agent message after
   * the close waits behind "N new" like any other); the close's own render
   * reads the route it leaves.
   */
  const heldOpen = (): OpenThread | null => {
    const open = routeRef.current.thread ?? (closing.current ? null : lastRoute.current.thread);
    return open ? { threadId: open } : closing.current;
  };
  const cancelSettle = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
  }, []);
  /**
   * The list on screen catches up: with the person's own reads and actions
   * (`own`: closing a thread; agent activity still waits behind "N new"), or
   * with everything (`all`: Show, another folder or page).
   */
  const settleList = useCallback(
    (what: 'own' | 'all', slide: boolean) => {
      cancelSettle();
      // The thread just closed settles as it now is, an arrival there included (held.ts settleOwn).
      const closed = closing.current;
      closing.current = null;
      const next = latestRef.current;
      if (!next) return;
      if (slide) armSlide();
      setShown((current) => (what === 'all' || current === null || !hasRows(current) ? next.sections : settleOwn(current, next.sections, openedHere.current, closed)));
    },
    [armSlide, cancelSettle],
  );
  useEffect(() => cancelSettle, [cancelSettle]);

  /**
   * Read the list; `adopt` puts it on screen (an action, Show, or nothing on
   * screen yet), sliding the rows to their places when `slide` says so.
   */
  const refreshList = useCallback(async (adopt: boolean, slide = false, refresh?: { light?: boolean; keepOpen?: boolean }) => {
    try {
      const next = await inboxApi.list();
      setPageSession(next.serverSession);
      setLatest(next);
      if (adopt && slide) armSlide();
      // Show's light for a refresh (clicking Inbox): the rows it brings in, against the list on screen now.
      if (adopt && refresh?.light) showFrom.current = shownRef.current;
      // A refresh beside an open thread keeps that thread's row where it is on screen (held.ts adoptKeepingOpen).
      const keep = adopt && refresh?.keepOpen ? routeRef.current.thread : null;
      setUpdate(next.update);
      setUpdated(next.updated ?? null);
      setRestartClaudeCode(next.restart_claude_code ?? 0);
      // Held: the order waits for an action, but each row's own state (a delivery, an agent's read) follows at once.
      setShown((current) =>
        current === null || !hasRows(current)
          ? next.sections
          : adopt
            ? keep
              ? adoptKeepingOpen(current, next.sections, keep)
              : next.sections
            : refreshHeldRows(current, next.sections, heldOpen()),
      );
      setLoadError(null);
      return next;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [armSlide]);

  /**
   * Seen on sight (seenOnSight.ts): messages that arrived in the open thread
   * have been on screen; record the look up to `through` (never past it) and
   * let the row unbold in place. `look.through` rises only once the server
   * took the look; a look that failed is sent again (a few times, waiting
   * longer each time) unless a later one covers it.
   */
  const lookRef = useRef(look);
  lookRef.current = look;
  /** Per thread, the furthest look on its way to the server. */
  const seenPosting = useRef(new Map<string, number>());
  const seenRetries = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const retries = seenRetries.current;
    return () => {
      for (const timer of retries) clearTimeout(timer);
      retries.clear();
    };
  }, []);
  const seenOnSight = useCallback(
    (threadId: string, through: number) => {
      const current = lookRef.current;
      if (!current || current.threadId !== threadId || (current.through !== null && current.through >= through)) return;
      if ((seenPosting.current.get(threadId) ?? -1) >= through) return;
      seenPosting.current.set(threadId, through);
      const attempt = (tries: number) => {
        void inboxApi
          .seen(threadId, through)
          .then(() => {
            if (seenPosting.current.get(threadId) === through) seenPosting.current.delete(threadId);
            const now = lookRef.current;
            if (now && now.threadId === threadId && (now.through === null || now.through < through)) {
              const next = { ...now, through };
              lookRef.current = next;
              setLook(next);
            }
            return refreshList(false);
          })
          .catch(() => {
            // A later look on its way covers this one.
            if (seenPosting.current.get(threadId) !== through) return;
            if (tries >= SEEN_RETRIES) {
              seenPosting.current.delete(threadId);
              return;
            }
            const timer = setTimeout(() => {
              seenRetries.current.delete(timer);
              attempt(tries + 1);
            }, SEEN_RETRY_MS * 2 ** tries);
            seenRetries.current.add(timer);
          });
      };
      attempt(0);
    },
    [refreshList],
  );

  const refreshThread = useCallback(async (threadId: string) => {
    try {
      const next = await inboxApi.thread(threadId);
      if (routeRef.current.thread === threadId) {
        setThread(next.thread);
        setThreadRow(next.row ?? null);
        // What is new since the last look, from the first read of this thread:
        // it lands before the window records the look, and is kept until the person leaves the thread.
        setLook((current) => (current?.threadId === threadId ? current : { threadId, seq: lookBoundary(next.thread), through: latestAgentSeq(next.thread) }));
      }
      return next.thread;
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.status === 404 && routeRef.current.thread === threadId) setThread(null);
      return null;
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const next = await inboxApi.settings();
      adoptSavedTheme(next.theme);
      adoptSavedTextSize(next.text_size);
      setSettings(next);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const refreshDrafts = useCallback(async () => {
    try {
      const next = await inboxApi.drafts();
      setDrafts(next.drafts);
      setDraftsError(null);
    } catch (cause) {
      setDraftsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);
  // The Drafts page follows each draft's session (live, ended) while it is open.
  useEffect(() => {
    if (route.page !== 'drafts') return;
    void refreshDrafts();
    const timer = setInterval(() => void refreshDrafts(), DRAFTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [route.page, refreshDrafts]);

  // The Board (approval "inbox-board", step 2): every card, read at start (the sidebar's Board count), again when a
  // card line arrives on the event stream, and while the Board is open when anything moves (its threads' rows).
  const [cards, setCards] = useState<CardsModel | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [cardBusy, setCardBusy] = useState(false);
  // Reads answer out of order (a read started before a move can land after it): only the newest read, started
  // after the last move, is taken, so a stale answer never flips a card back (or closes a form the person opened).
  const cardsSeq = useRef(0);
  const refreshCards = useCallback(async () => {
    const mine = ++cardsSeq.current;
    try {
      const next = await inboxApi.cards();
      if (mine !== cardsSeq.current) return null;
      setCards(next);
      setCardsError(null);
      return next;
    } catch (cause) {
      setCardsError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);
  useEffect(() => {
    void refreshCards();
  }, [refreshCards]);
  const cardsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCards = useCallback(() => {
    if (cardsTimer.current) clearTimeout(cardsTimer.current);
    cardsTimer.current = setTimeout(() => {
      cardsTimer.current = null;
      void refreshCards();
    }, 80);
  }, [refreshCards]);
  useEffect(() => () => {
    if (cardsTimer.current) clearTimeout(cardsTimer.current);
  }, []);
  // Each card's age ("2d ago") follows the clock while the Board is open.
  const [boardNow, setBoardNow] = useState(() => Date.now());
  useEffect(() => {
    if (route.page !== 'board') return;
    setBoardNow(Date.now());
    void refreshCards();
    const timer = setInterval(() => setBoardNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [route.page, route.board, refreshCards]);
  // Opening Dropped (the Icebox page) is the person looking at an agent's drops: they leave "N dropped by an agent".
  // Only the drops the page drew, and only while it is in front (visible, with focus): a tab in the background
  // marks nothing, and waits until the person brings it forward.
  const unseenDropIds = cards ? boardOf(cards.cards).droppedByAgent.map((c) => c.id).join(',') : '';
  useEffect(() => {
    if (route.page !== 'board' || route.board !== 'icebox' || !unseenDropIds) return;
    let done = false;
    const mark = () => {
      if (done || !pageInFront()) return;
      done = true;
      void inboxApi
        .cardDropsSeen(unseenDropIds.split(','))
        .then(() => refreshCards())
        .catch(() => {});
    };
    mark();
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [route.page, route.board, unseenDropIds, refreshCards]);

  /** Read the agents; while `plannotator inbox` is still connecting them, read again until it is done. */
  const refreshAgents = useCallback(async () => {
    try {
      const mine = ++agentsSeq.current;
      const next = await inboxApi.agents();
      if (mine === agentsSeq.current) setAgentsState(next);
      return next;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The page can load before the run that opened it starts connecting, so read once more a moment later.
    let extra = 1;
    const read = async () => {
      const next = await refreshAgents();
      if (cancelled) return;
      if (next?.connecting || extra-- > 0) timer = setTimeout(() => void read(), next?.connecting ? 1500 : 2500);
      else setAgentsSettled(true);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshAgents]);
  // Settings → Agents reads them again each time it opens: an agent installed meanwhile shows at once.
  const agentsSection = route.page === 'settings' && route.section === 'agents';
  // While it is open it follows the agent sessions too: a session that restarts leaves "Open sessions" by itself.
  useEffect(() => {
    if (!agentsSection) return;
    void refreshAgents();
    const timer = setInterval(() => void refreshAgents(), AGENTS_SESSIONS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [agentsSection, refreshAgents]);

  const loadUpdateDetails = useCallback(async () => {
    try {
      const next = await inboxApi.updateDetails();
      setUpdateDetails(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  // First read, then the event stream keeps the counts, the open thread and the notice live.
  useEffect(() => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deliveriesTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    void (async () => {
      const first = await refreshList(true);
      void refreshSettings();
      if (cancelled || !first) return;
      // The threads already here: a later line of one of their roots is never a new thread (notify.ts).
      flushNotifications(first);
      unsubscribe = subscribeInboxEvents(first.cursor, {
        onRecord: (event) => {
          observeEvent(event);
          // A card line, or anything while the Board is open (a linked thread's row may have moved).
          if (event?.kind === 'card' || routeRef.current.page === 'board') scheduleCards();
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void refreshList(false).then((next) => next && flushNotifications(next));
            const open = routeRef.current.thread;
            if (open) void refreshThread(open);
          }, 80);
        },
        onStatus: (next, nextUpdated, nextRestart) => {
          setUpdate(next);
          if (nextUpdated !== undefined) setUpdated(nextUpdated);
          if (nextRestart !== undefined) setRestartClaudeCode(nextRestart);
        },
        // Whether any open Inbox tab can show a notification (Settings → General).
        onReach: setNotifyReach,
        // The live sessions moved (approval "inbox-row-delivery"): read the list again while a row's
        // delivery can still change (queued, sending, saved, not delivered), so its glyph follows.
        onDeliveries: () => {
          if (!hasMovingDelivery(latestSectionsRef.current)) return;
          if (deliveriesTimer) clearTimeout(deliveriesTimer);
          deliveriesTimer = setTimeout(() => void refreshList(false), 80);
        },
        // Every (re)connect: the permission now, since a reconnect's URL may be stale.
        onConnect: reportWindow,
      }, windowReport());
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      if (deliveriesTimer) clearTimeout(deliveriesTimer);
    };
  }, [refreshList, refreshSettings, refreshThread, observeEvent, flushNotifications, setNotifyReach, windowReport, reportWindow, scheduleCards]);

  // Opening a thread: read it, record the look, and update its row in place.
  // While any thread is open the list holds still (settle.ts): the look
  // unbolds the row where it is and does not re-sort the list. Where the
  // thread covers the list, the list catches up now, out of sight, before the
  // look (so the row being opened keeps its place): Back shows it as left.
  useEffect(() => {
    const threadId = route.thread;
    if (!threadId) {
      setThread(null);
      setThreadRow(null);
      setLook(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const opened = await refreshThread(threadId);
      if (cancelled || !opened) return;
      closing.current = null;
      if (listCovered() && COVERED_LIST_SETTLES === 'while-covered') settleList('own', false);
      // The look covers what this read showed, not a message that lands before the server takes it.
      await inboxApi.seen(threadId, latestAgentSeq(opened)).catch(() => {});
      if (!cancelled) await refreshList(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [route.thread, refreshThread, refreshList, settleList]);

  // When the list on screen catches up as the route changes (settle.ts).
  // Another page or folder: the list there is drawn as it is now. A thread
  // opening, or replacing another: nothing moves (a slide still playing
  // stops). The thread closing: the person's own reads and actions settle, a
  // beat after the list has widened (at once under reduced motion, with no
  // slide); where the thread covered the list, COVERED_LIST_SETTLES decides.
  // After a keyboard close, focus that the closed pane took with it goes to
  // the thread's row.
  const lastRoute = useRef({ page: route.page, project: route.project ?? null, thread: route.thread });
  /** The docked sidebar is held closed beside a file (#1871); the close gives it back, so the settle waits for its spring. */
  const sidebarHeldNow = useRef(false);
  useLayoutEffect(() => {
    const before = lastRoute.current;
    const now = { page: route.page, project: route.project ?? null, thread: route.thread };
    lastRoute.current = now;
    if (before.page === now.page && before.project === now.project && before.thread === now.thread) return;
    if (!(before.page === 'inbox' && now.page === 'inbox' && before.project === now.project)) {
      settleList('all', false);
      return;
    }
    const body = listBody(rootRef.current);
    if (now.thread) {
      // A thread opens: the list holds still, so a settle waiting out its beat
      // never comes, and one still sliding stops where the rows belong.
      cancelSettle();
      if (body) stopSettle(body);
      return;
    }
    const closed = before.thread;
    if (!closed) return;
    // Closed by clicking Inbox: the refresh's read is adopted whole (refreshInbox), so nothing settles here.
    if (refreshPending.current) {
      closing.current = null;
      return;
    }
    closing.current = { threadId: closed, asOf: latestRef.current?.sections.flatMap((section) => section.threads).find((row) => row.thread_id === closed) ?? null };
    const active = document.activeElement;
    if (body && lastInput === 'keyboard' && (!active || active === document.body)) rowElement(body, closed)?.focus({ preventScroll: true });
    if (listCovered() && COVERED_LIST_SETTLES === 'while-covered') {
      // The list as the person left it, except the thread they just closed
      // when a message arrived there that they did not see: it comes back
      // unread, in the section its state gives it (held.ts settleThread).
      closing.current = null;
      const next = latestRef.current?.sections.flatMap((section) => section.threads).find((row) => row.thread_id === closed);
      if (next && next.unseen > 0) setShown((current) => (current ? settleThread(current, latestRef.current!.sections, closed) : current));
      return;
    }
    if (prefersReducedMotion()) settleList('own', false);
    else settleTimer.current = setTimeout(() => settleList('own', true), sidebarHeldNow.current ? SETTLE_AFTER_SIDEBAR_MS : SETTLE_BEAT_MS);
  }, [route.page, route.project, route.thread, settleList, cancelSettle]);

  useEffect(() => {
    if (route.page === 'settings') {
      void refreshSettings();
      void loadUpdateDetails();
    }
  }, [route.page, refreshSettings, loadUpdateDetails]);

  // Settings' Archived count in its nav: read while Settings is open, again whenever the store moves.
  const [archivedTotal, setArchivedTotal] = useState<number | null>(null);
  const storeCursor = latest?.cursor ?? null;
  useEffect(() => {
    if (route.page !== 'settings') return;
    let cancelled = false;
    inboxApi
      .archived({ limit: 1 })
      .then((model) => !cancelled && setArchivedTotal(model.total))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [route.page, storeCursor]);

  // "← Inbox" returns to where the person was before Settings: the last hash that was not a Settings page,
  // so moving between sections never changes where Back goes (Workspaces' BackLink).
  const settingsReturn = useRef('');
  if (route.page !== 'settings') settingsReturn.current = hashOf(route);
  // What's new's "‹ Inbox" returns to the last Inbox screen (not Settings, not another What's new page):
  // the browser's Back when the page was opened from there (history.ts), a new entry otherwise.
  const whatsNewReturn = useRef('');
  if (route.page !== 'settings' && route.page !== 'whats-new') whatsNewReturn.current = hashOf(route);

  // Settings is a focused page (design of record inbox-settings-tabs): the sidebar slides away while it
  // is open and comes back on leaving, without writing the person's stored choice. ⌘B there opens it
  // for this visit only.
  const [settingsSidebar, setSettingsSidebar] = useState(false);
  useEffect(() => {
    if (route.page !== 'settings') setSettingsSidebar(false);
  }, [route.page]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An open file owns Escape (the HTML viewer's ladder, the composers).
      if (event.key !== 'Escape' || !routeRef.current.thread || routeRef.current.file) return;
      // Something inside the thread already used this Escape (the reply's choice at Send goes back to the reply).
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
      // Words selected in a message (approval "inbox-message-comments"): its selection toolbar or label picker owns this Escape.
      if (selectionToolbarShowing()) return;
      // An open guided review closes first, back to its thread.
      closeTo(routeRef.current.guide ? { ...routeRef.current, guide: null } : { ...routeRef.current, thread: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The one-time sound dialog: due when the Inbox says so (the first start of
  // this version found someone who used an earlier Inbox; kept until claimed),
  // never on a page that came through the tailnet, never before the list has
  // loaded. It waits while a reply is being typed and while an update dialog
  // is open, then asks the Inbox, which says yes to the first page only (a
  // compare-and-set).
  const soundDialogDue = latest !== null && settings?.sound?.dialog_due === true && (settings.via ?? 'local') === 'local';
  const soundDialogBlocked = updateDialog !== null || restarting;
  useEffect(() => {
    if (!soundDialogDue || soundDialogBlocked || soundDialogAsked.current) return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (cancelled || soundDialogAsked.current || replyInProgress()) return;
      soundDialogAsked.current = true;
      clearInterval(timer);
      inboxApi
        .claimSoundDialog()
        .then((answer) => {
          setSettings((current) => (current ? { ...current, sound: answer.sound } : current));
          if (answer.show && !cancelled) setSoundDialog('open');
        })
        .catch(() => {})
        .finally(() => setSoundClaimed(true));
    }, 700);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [soundDialogDue, soundDialogBlocked]);

  // The one-time agent-note dialog (the approved "inbox-agent-note-dialog"
  // design): asks about each agent that can take a note and was never asked.
  // Decided once per load, once the agents are read (the run that opened the
  // window has finished connecting) and the list has loaded; after the sound
  // dialog, and never on a load that showed it. Never through the tailnet
  // (the agents are local only, so `agents` stays null there), never while an
  // update dialog is open or a reply is being typed, and it waits while
  // Settings is open (Settings → Agents asks the same thing).
  const soundSettled = settings !== null && (!(settings.sound?.dialog_due === true && (settings.via ?? 'local') === 'local') || soundClaimed);
  const agentNoteReady =
    agentsSettled && latest !== null && soundSettled && soundDialog === 'none' && updateDialog === null && !restarting && route.page !== 'settings';
  useEffect(() => {
    if (!agentNoteReady || agentNoteDecided.current) return;
    let cancelled = false;
    const decide = () => {
      if (cancelled || agentNoteDecided.current || replyInProgress()) return false;
      agentNoteDecided.current = true;
      const model = agentsRef.current;
      const rows = model ? noteQuestionRows(model) : [];
      if (rows.length > 0 && model) setAgentNote({ rows, report: cardReport(model) });
      return true;
    };
    if (decide()) return;
    const timer = setInterval(() => {
      if (decide()) clearInterval(timer);
    }, 700);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agentNoteReady]);
  const agentNoteOpen = typeof agentNote === 'object';


  // The list on screen catches up as the route changes (the layout effect above), not here.
  const go = (next: Route) => writeRoute(next);
  /** Back to the screen under this one (closeTo): a thread's list, a file's thread. */
  const close = (next: Route) => closeTo(next);

  const openSearch = (opener?: HTMLElement | null) => {
    searchOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSearchMounted(true);
    setSearchOpen(true);
  };
  const openSearchRef = useRef(openSearch);
  openSearchRef.current = openSearch;
  // ⌘K / Ctrl+K opens search: the Inbox's one shortcut, an owner exception (approval amendment 2026-10-14;
  // search/searchShortcut.ts). Capture phase, so it also reaches the open palette, whose keys stop at its dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onOpenSearchKey(event, (opener) => openSearchRef.current(opener));
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const closeSearch = (reason: 'dismissed' | 'opened') => {
    setSearchOpen(false);
    if (reason !== 'dismissed') return;
    // Focus back to what opened it, else the Search entry on screen (a phone's sheet has closed).
    const opener = searchOpener.current;
    searchOpener.current = null;
    requestAnimationFrame(() => {
      if (opener && opener.isConnected && opener.getClientRects().length > 0) opener.focus();
      else focusFirst(['[data-open-search]']);
    });
  };
  const openSearchResult = (hash: string, land: SearchLanding | null) => {
    searchLanding.current = land;
    const now = routeRef.current;
    const next = routeOf(hash);
    // As a row click does (openRow): searched from a project's list, the list stays that project's.
    if (now.page === 'inbox' && next.page === 'inbox' && next.thread) next.project = now.project;
    // Landing in the thread already open (nothing beside it) replaces the entry: once `msg=` drops,
    // a new one would equal the last and the first Back would do nothing.
    const sameThread = now.page === 'inbox' && !!now.thread && now.thread === next.thread && !now.file && !now.guide;
    // Otherwise a new history entry: Back returns to where the search started (on a phone, the list).
    writeRoute(next, sameThread ? { replace: true } : {});
  };
  // ── Compose: a new message to a connected agent (compose/ComposeDialog.tsx) ──
  const openCompose = (request: ComposeRequest, opener?: HTMLElement | null) => {
    composeOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setCompose(request);
  };
  /**
   * The draft after this one in the Drafts list (else the one before), for
   * focus once it leaves the list: sent, deleted or discarded.
   */
  const draftNeighbour = (draftId: string): string | null => {
    const list = drafts ?? [];
    const index = list.findIndex((d) => d.id === draftId);
    if (index < 0) return null;
    return (list[index + 1] ?? list[index - 1])?.id ?? null;
  };
  /**
   * Focus somewhere real once what had it is gone: the draft row named, else
   * the Drafts heading, else a New message button. Never left on the page.
   */
  const focusFallback = (draftId: string | null) => {
    // The Drafts page is the page on screen when it has these; the New message
    // buttons are several (sidebar, a phone's list header), so the shown one.
    const row = draftId ? document.querySelector<HTMLElement>(`[data-draft-id="${CSS.escape(draftId)}"] .ib-draft-open`) : null;
    if (row) return row.focus();
    const heading = document.querySelector<HTMLElement>('[data-drafts-page] h1');
    if (heading) return heading.focus();
    for (const button of document.querySelectorAll<HTMLElement>('[data-open-compose]')) {
      button.focus();
      if (document.activeElement === button) return;
    }
  };
  // Runs after the render that closed compose or dropped a draft row, so the DOM is the new one.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || compose) return;
    pendingFocus.current = null;
    const { opener, next } = pending;
    // A hidden opener (a closed phone sheet) does not take focus; then the fallback.
    if (opener?.isConnected) opener.focus();
    if (opener && document.activeElement === opener) return;
    focusFallback(next);
  });
  /** Close compose; focus goes back to what opened it, or, when that is gone (a draft row), `focusFallback(next)`. */
  const closeCompose = (next: string | null = null) => {
    setCompose(null);
    // After the render that closes it (and drops a sent draft's row): see the effect below.
    pendingFocus.current = { opener: composeOpener.current, next };
    composeOpener.current = null;
  };
  const composeSent = (sent: ComposeSent) => {
    // A draft sent leaves the list now; focus goes to the next one.
    const next = sent.draftId ? draftNeighbour(sent.draftId) : null;
    if (sent.draftId) setDrafts((current) => (current ?? []).filter((d) => d.id !== sent.draftId));
    closeCompose(next);
    // With no thread open the list adopts what it reads, the new row with it.
    // While one is open the list holds still, but the thread the person just
    // started is their own action: it goes into Sent now (held.ts
    // addOwnThreads), the other rows sliding to make room, never behind "N new".
    const adopt = !routeRef.current.thread;
    void refreshList(adopt, true).then((next) => {
      if (!next || adopt) return;
      armSlide();
      setShown((current) => (current === null ? next.sections : addOwnThreads(current, next.sections, [sent.threadId])));
    });
    if (sent.draftId) void refreshDrafts();
    showToast(
      {
        icon: 'check',
        lead: `Sent to ${hostLabel(sent.host)}`,
        // Short enough for one line; the thread's own line says Queued / Sending / Delivered.
        detail: `in ${sent.projectName}`,
        speech: `Sent to ${hostLabel(sent.host)} in ${sent.projectName}. It takes it as its next turn.`,
        action: { label: 'Open', onPress: () => {
          dismissToast();
          go({ page: 'inbox', project: routeRef.current.page === 'inbox' ? routeRef.current.project : null, thread: sent.threadId });
        } },
      },
      7000,
    );
  };
  const lastSentRef = useRef(lastSent);
  const rememberSent = (session: string) => {
    lastSentRef.current = session;
    setLastSent(session);
    storage.setItem(COMPOSE_LAST_COOKIE, session);
  };
  const composeSaved = (draft: DraftView) => {
    closeCompose();
    setDrafts((current) => [draft, ...(current ?? []).filter((d) => d.id !== draft.id)]);
    void refreshDrafts();
    showToast({
      icon: 'check',
      lead: 'Draft saved',
      detail: 'It waits under Drafts and never sends itself.',
      action: { label: 'Drafts', onPress: () => {
        dismissToast();
        go({ page: 'drafts', project: null, thread: null });
      } },
    });
  };
  /** Delete a draft, with Undo: the window re-creates it from what it still holds (no soft delete on the server). */
  const deleteDraft = async (draft: DraftView, alreadyDeleted = false) => {
    const next = draftNeighbour(draft.id);
    const hadFocus = document.activeElement instanceof HTMLElement && !!document.activeElement.closest(`[data-draft-id="${CSS.escape(draft.id)}"]`);
    if (!alreadyDeleted) {
      try {
        await inboxApi.deleteDraft(draft.id);
      } catch (cause) {
        showToast({ icon: 'warn', lead: cause instanceof Error ? cause.message : 'The draft was not deleted.', wrap: true });
        return;
      }
    }
    setDrafts((current) => (current ?? []).filter((d) => d.id !== draft.id));
    // The row held focus (its delete button): the next row takes it.
    if (hadFocus) pendingFocus.current = { opener: null, next };
    void refreshDrafts();
    showToast({
      icon: 'check',
      lead: 'Draft deleted',
      onUndo: () => {
        dismissToast();
        void inboxApi
          .saveDraft(draft.id, { body: draft.body, to: draft.to, project: draft.project, files: draft.files.map((f) => f.upload_id), base: null })
          .then(() => refreshDrafts())
          .then(() => say('Draft restored.'))
          .catch(() => showToast({ icon: 'warn', lead: 'The draft could not be restored.', wrap: true }));
      },
    });
  };
  // The palette's Actions group reads the live sessions while it is open.
  const { model: paletteSessions } = useComposeSessions(searchOpen);
  const paletteActions = useCallback(
    (q: string): ComposeAction[] => composeActions(q, composeTargets(paletteSessions?.projects ?? []), lastSentRef.current),
    [paletteSessions],
  );

  /** The thread landed on the message `msg=` named: drop it from the hash, so a reload does not jump again. */
  const landed = () => {
    searchLanding.current = null;
    if (routeRef.current.msg) writeRoute({ ...routeRef.current, msg: null }, { replace: true });
  };

  // A phone shows one screen at a time (phone.ts, inbox.css), and its keyboard shrinks the window.
  const phone = usePhone();
  useEffect(() => (phone ? trackKeyboard() : undefined), [phone]);
  // A ⌘V with focus on something that takes no text (a question's choice, the page) goes to the text
  // field the person was writing in: dictation apps paste with a synthetic ⌘V (pasteTarget.ts).
  useEffect(() => installPasteFollowsField(), []);
  // ...and the page inserts that plain-text paste itself: Chrome 155-156 on macOS drops dictated
  // (synthetic ⌘V) text otherwise. Remove once Chrome 157 is stable (pasteInsert.ts).
  useEffect(() => installPlainTextPaste(), []);
  // A window too narrow for two panes (an iPad in portrait, a narrow desktop window): the pane on top covers the one under it (stack.ts).
  // `‹ Inbox` from a file beside the thread in a window with room for the list and the thread but not for
  // the sidebar too (about 920 to 1050 px): the sidebar stays closed on screen so the list shows beside the
  // thread, as the open file kept it, without writing the person's choice. It comes back once there is room,
  // when the thread closes, or when the person opens it.
  const [sidebarHeld, setSidebarHeld] = useState(false);
  sidebarHeldNow.current = sidebarHeld;
  const stack = useStack(rootRef, phone, [hashOf(route), sidebarOpen, sidebarHeld]);
  useEffect(() => {
    if (!sidebarHeld) return;
    const check = () => {
      const now = routeRef.current;
      if (now.page !== 'inbox' || !now.thread) {
        setSidebarHeld(false);
        return;
      }
      const root = rootRef.current;
      if (!root) return;
      const sidebar = root.querySelector('.ib-sb-inner')?.getBoundingClientRect().width ?? 0;
      if (root.getBoundingClientRect().width - sidebar >= LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH + paneGutters(root)) setSidebarHeld(false);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [sidebarHeld, route]);
  useLayoutEffect(() => {
    covering.thread = stack.thread;
  }, [stack.thread]);

  const openRow = (row: InboxListRow) => go({ page: 'inbox', project: route.project, thread: row.thread_id });

  const patchQuestions = (messageId: string, questions: InboxQuestion[]) => {
    setThread((current) =>
      current
        ? { ...current, messages: current.messages.map((m) => (m.id === messageId ? { ...m, questions } : m)) }
        : current,
    );
    // While a thread is open the person's own writes never reorder the list
    // (owner ruling 2026-10-11): each row shows its new state in place, and
    // the list catches up when the thread closes (settle.ts).
    void refreshList(!routeRef.current.thread, true);
  };

  const afterWrite = async () => {
    const open = routeRef.current.thread;
    if (open) await refreshThread(open);
    await refreshList(!open, true);
  };

  const rowOf = (threadId: string): InboxListRow | undefined =>
    (latestRef.current?.sections ?? []).flatMap((section) => section.threads).find((row) => row.thread_id === threadId);

  const say = (text: string) => {
    setSaid('');
    setTimeout(() => setSaid(text), 30);
  };
  /**
   * Click Inbox to refresh (the owner, 2026-10-20: "Just click inbox, it
   * refreshes"): clicking Inbox, or the project folder the list shows, or the
   * list header's title, while that list is on screen reads the list again and
   * adopts it as Show does (held rows settle, new rows come in and light up,
   * "N new · Show" goes away), with the drafts, settings and the open thread
   * read again too: what a page reload would bring, and nothing more (no look
   * is recorded, so the tab's count and the rows' New stay as the server says).
   * `closeThread`: the sidebar's row with a thread open keeps today's behaviour
   * (the thread closes) and refreshes as well; the list adopts what it reads
   * instead of settling the person's own reads a beat later.
   */
  const refreshSpinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (refreshSpinTimer.current) clearTimeout(refreshSpinTimer.current);
  }, []);
  /** A refresh is reading: another click waits for it (a second read would light nothing and take the first one's light). */
  const refreshing = useRef(false);
  const refreshInbox = async (scope: string | null, closeThread: boolean) => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      await refreshInboxNow(scope, closeThread);
    } finally {
      refreshing.current = false;
    }
  };
  const refreshInboxNow = async (scope: string | null, closeThread: boolean) => {
    const label = scope ? (projects.find((p) => p.id === scope)?.name ?? 'Project') : 'Inbox';
    // The brief signal plays whether or not anything changed: the icon turns once.
    setRefreshSpin((last) => ({ key: (last?.key ?? 0) + 1, scope }));
    if (refreshSpinTimer.current) clearTimeout(refreshSpinTimer.current);
    refreshSpinTimer.current = setTimeout(() => setRefreshSpin(null), REFRESH_SPIN_MS);
    if (closeThread) {
      refreshPending.current = true;
      go({ page: 'inbox', project: scope, thread: null });
    }
    cancelSettle();
    closing.current = null;
    // After a key, focus stays where it is (the row or title pressed); Show's own focus move is not wanted here.
    focusAfterShow.current = false;
    listOrder.current = [...(listBody(rootRef.current)?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
    const next = await refreshList(true, true, { light: true, keepOpen: true });
    refreshPending.current = false;
    if (!next) {
      say(`${label} could not refresh`);
      return;
    }
    void refreshDrafts();
    void refreshSettings();
    const open = routeRef.current.thread;
    if (open) void refreshThread(open);
    say(`${label} refreshed`);
  };
  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    toastLeft.current = null;
    setToast(null);
  }, []);
  /** The window's one toast: a new one replaces the last, so two never stack. */
  const armToastTimer = (ms: number) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastDeadline.current = Date.now() + ms;
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, ms);
  };
  const showToast = (next: Omit<InboxToastModel, 'id'>, ms = MARK_READ_UNDO_MS) => {
    toastLeft.current = null;
    setToast({ ...next, id: Date.now() });
    say(toastSpeech(next, phone));
    armToastTimer(ms);
  };
  /** A swipe in progress pauses the toast's timer; a spring-back resumes it (at least 1.5 s more, so it never vanishes on release). */
  const holdToast = useCallback((held: boolean) => {
    if (held) {
      if (!toastTimer.current) return;
      clearTimeout(toastTimer.current);
      toastTimer.current = null;
      toastLeft.current = Math.max(0, toastDeadline.current - Date.now());
      return;
    }
    if (toastLeft.current === null) return;
    const left = toastLeft.current;
    toastLeft.current = null;
    armToastTimer(Math.max(left, 1500));
    // armToastTimer reads only refs and setToast, so the first render's copy serves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** A write that failed: its message, whole (it may wrap). */
  const showError = (cause: unknown) =>
    showToast({ icon: 'warn', lead: cause instanceof Error ? cause.message : 'The thread did not change.', wrap: true });
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  // ── The Board's moves (approval "inbox-board"): the person's only. ──
  /** One move on a card; the card on screen takes the answer at once, the rest follows the next read. */
  // From the open card (a modal dialog: a toast under it could not be reached), what happened, or what failed, is
  // said in the card itself, and its own Restore or Take out undoes it. From the page, the window's one toast, with Undo.
  const [cardNote, setCardNote] = useState<{ card: string; text: string; error?: boolean } | null>(null);
  const moveCard = async (card: InboxCardWire, move: CardMove, inCard = false): Promise<InboxCardWire | null> => {
    setCardBusy(true);
    try {
      const { card: next } = await inboxApi.moveCard(card.id, move);
      // Any read still out started before this move: its answer is older than this card.
      cardsSeq.current++;
      setCards((current) => (current ? { ...current, cards: current.cards.map((c) => (c.id === next.id ? next : c)) } : current));
      void refreshCards();
      return next;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : 'The card did not change.';
      if (inCard) {
        setCardNote({ card: card.id, text, error: true });
        say(text);
      } else showToast({ icon: 'warn', lead: text, wrap: true });
      return null;
    } finally {
      setCardBusy(false);
    }
  };
  const cardDone = (card: InboxCardWire, inCard: boolean, toast: Omit<InboxToastModel, 'id'>, note: string) => {
    if (inCard) {
      setCardNote({ card: card.id, text: note });
      say(note);
    } else showToast(toast, toast.onUndo ? MARK_READ_UNDO_MS : 4200);
  };
  const restoreCard = async (card: InboxCardWire, inCard = false) => {
    const next = await moveCard(card, { op: 'restore' }, inCard);
    if (next) cardDone(card, inCard, { icon: 'check', lead: `Back in ${INBOX_CARD_COLUMN_LABELS[next.column]}`, detail: `“${card.title}”` }, `Back in ${INBOX_CARD_COLUMN_LABELS[next.column]}.`);
  };
  const iceboxCard = async (card: InboxCardWire, inCard = false) => {
    const next = await moveCard(card, { op: 'icebox' }, inCard);
    if (next)
      cardDone(card, inCard, { icon: 'check', lead: 'Paused', detail: `“${card.title}” is in the Icebox`, onUndo: () => void restoreCard(next) }, 'Paused: it is in the Icebox. Take out puts it back.');
  };
  const dropCard = async (card: InboxCardWire, reason: string, inCard = false) => {
    const next = await moveCard(card, reason ? { op: 'drop', reason } : { op: 'drop' }, inCard);
    if (next) cardDone(card, inCard, { icon: 'archive', lead: 'Dropped', detail: `“${card.title}”`, onUndo: () => void restoreCard(next) }, 'Dropped. Restore puts it back.');
  };
  const moveCardTo = async (card: InboxCardWire, column: InboxCardColumn, inCard = false) => {
    const next = await moveCard(card, { op: 'move', column }, inCard);
    if (next) cardDone(card, inCard, { icon: 'check', lead: `Moved to ${INBOX_CARD_COLUMN_LABELS[column]}`, detail: `“${card.title}”` }, `Moved to ${INBOX_CARD_COLUMN_LABELS[column]}.`);
  };
  /** Got it: the drops the notice showed are seen (never one that arrived after it was drawn). */
  const dropsSeen = async (cardIds: readonly string[]) => {
    try {
      await inboxApi.cardDropsSeen(cardIds);
    } catch (cause) {
      showToast({ icon: 'warn', lead: cause instanceof Error ? cause.message : 'Not saved.', wrap: true });
    }
    void refreshCards();
  };

  /**
   * Mark read, or move it back (the pressed button, `E` again, Undo). The
   * thread leaves the top for Quiet with its waiting questions closed; Undo
   * reopens them as they were. An agent stopped or held up on it makes the
   * toast a warning with Reply.
   */
  const markRead = async (threadId: string, read: boolean) => {
    const before = rowOf(threadId);
    // With a thread open the list holds still: the row moves to Quiet when the list next settles.
    const open = routeRef.current.thread;
    const deferred = open !== null;
    const place = threadId === open ? 'open' : deferred ? 'held' : 'list';
    try {
      await inboxApi.markRead(threadId, read);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite();
    if (!read) {
      dismissToast();
      // With a thread open the row has not left its place, so it has nowhere to come back from yet.
      say(deferred ? 'Moved back.' : 'Moved back to the top.');
      return;
    }
    if (!before) return;
    const { warn, ...copy } = markReadToast(before, place);
    showToast({
      ...copy,
      icon: warn ? 'warn' : 'check',
      onUndo: () => void markRead(threadId, false),
      ...(warn
        ? {
            onReply: () => {
              void (async () => {
                await markRead(threadId, false);
                if (routeRef.current.thread !== threadId) go({ page: 'inbox', project: routeRef.current.project, thread: threadId });
                setReplyFor(threadId);
              })();
            },
          }
        : {}),
    });
  };

  /**
   * 👍 Looks good (design record "inbox-acknowledge", approved 2026-10-15,
   * amended 2026-10-16), or take it back (the toast's Undo, `Z`, the pressed
   * button). The ack is recorded on the agent's latest message and the thread
   * is marked read; once the Undo window passes the Inbox sends it to the
   * agent. The held-order rules of Mark read apply: with the thread open its
   * row changes in place.
   */
  const acknowledge = async (threadId: string, messageId: string, on: boolean, agent: string) => {
    try {
      await inboxApi.ack(messageId, on);
    } catch (cause) {
      showError(cause);
      await afterWrite();
      return;
    }
    await afterWrite();
    if (!on) {
      dismissToast();
      say('Looks good taken back.');
      return;
    }
    // Only the open thread's foot offers 👍, so the toast always speaks of that thread.
    showToast({
      icon: 'thumb',
      lead: 'Looks good',
      // Short enough for one line at 520 px with Undo and its Z (a toast's words always show whole).
      detail: `Goes to ${agent} in 10 s · Moves to Quiet`,
      onUndo: () => void acknowledge(threadId, messageId, false, agent),
    });
  };

  /** Archive (the MCP's resolve) or Unarchive, with Undo. */
  const archive = async (threadId: string, rootId: string, next: boolean) => {
    const before = rowOf(threadId);
    const open = routeRef.current.thread;
    try {
      await inboxApi.resolve(rootId, next);
    } catch (cause) {
      showError(cause);
      return;
    }
    // The list leaves archived threads out (Settings lists them). While the
    // thread is open its row stays where it is, shown archived; it goes when
    // the person leaves the thread.
    // A row archived from its menu while another thread is open does the same (the list holds still).
    if (next && routeRef.current.thread !== null) {
      const at = new Date().toISOString();
      setShown((current) => (current ? markHeldRowArchived(current, threadId, at) : current));
    }
    await afterWrite();
    if (next) {
      // The thread's foot says the next message starts a new thread.
      // From a row's menu, a thread that is not the open one: the subject says which (as Mark read's toast).
      const detail = threadId !== open && before ? `“${before.subject ?? '(no subject)'}”` : undefined;
      showToast({ icon: 'archive', lead: 'Archived', ...(detail ? { detail } : {}), onUndo: () => void archive(threadId, rootId, false) });
    } else {
      dismissToast();
      say('Unarchived.');
    }
  };

  /**
   * A thread row's right-click menu. Copy link and Copy thread ID say so in
   * the window's one toast; Mark read, Move back and Archive are the row's
   * hover action and the header's, with their toasts.
   */
  const rowAction = (row: InboxListRow, action: RowMenuAction) => {
    if (action === 'read' || action === 'unread') return void markRead(row.thread_id, action === 'read');
    if (action === 'archive') return void archive(row.thread_id, row.thread_id, true);
    const text = action === 'copy-link' ? threadLink(row.thread_id, settings, window.location.origin) : row.thread_id;
    void copyTextToClipboard(text).then((ok) =>
      showToast(
        ok
          ? { icon: 'check', lead: action === 'copy-link' ? 'Link copied' : 'Thread ID copied', detail: `“${row.subject ?? '(no subject)'}”` }
          : { icon: 'warn', lead: "Couldn't copy" },
        4200,
      ),
    );
  };

  /**
   * The project menu (design record "inbox-project-menu", approved
   * 2026-10-14): Mark all as read and Archive all on one project, each one
   * batch on the server, with one Undo for the batch (the toast, `Z`). The
   * same held-order rules as the single actions: with a thread open the
   * rows show their new state in place and the list settles when it closes;
   * with none open the rows slide to their places. A project left with
   * nothing listed leaves the sidebar (the one the list shows stays until
   * the person leaves it).
   */
  const projectAction = async (projectId: string, action: ProjectAction) => {
    const name = latestRef.current?.projects.find((p) => p.id === projectId)?.name ?? 'the project';
    const before = (latestRef.current?.sections ?? []).flatMap((section) => section.threads).filter((row) => row.project.id === projectId);
    const openThread = routeRef.current.thread;
    let taken: string[];
    let undo: () => Promise<unknown>;
    /** The batch stopped partway: Undo still covers what it changed, and the toast says the rest did not change. */
    let incomplete: string | null = null;
    try {
      if (action === 'read') {
        const answer = await inboxApi.markProjectRead(projectId, newBatchId());
        taken = answer.batch.read;
        incomplete = answer.error?.message ?? null;
        undo = () => inboxApi.unmarkProjectRead(projectId, answer.batch.read);
      } else {
        const answer = await inboxApi.archiveProject(projectId, newBatchId());
        taken = [...answer.batch.resolved, ...answer.batch.read];
        incomplete = answer.error?.message ?? null;
        undo = () => inboxApi.unarchiveProject(projectId, answer.batch);
        // The list leaves archived threads out; while a thread is open each taken row stays where it is,
        // shown archived, and goes when the person leaves the thread (as the single Archive does).
        if (openThread) {
          const at = new Date().toISOString();
          setShown((current) => (current ? taken.reduce((sections, id) => markHeldRowArchived(sections, id, at), current) : current));
        }
      }
    } catch (cause) {
      showToast({ icon: 'warn', lead: cause instanceof Error ? cause.message : 'The project did not change.', wrap: true });
      return;
    }
    await afterWrite();
    if (taken.length === 0) {
      if (incomplete) showToast({ icon: 'warn', lead: `${name} did not change`, detail: incomplete, wrap: true });
      else say(action === 'read' ? `Nothing in ${name} waits on you.` : `Nothing in ${name} to archive.`);
      return;
    }
    const copy = projectBatchToast(action, name, taken.length, before.filter((row) => taken.includes(row.thread_id)));
    showToast({
      ...copy,
      // Stopped partway: the warning, and why, whole (it may wrap); Undo still covers what did apply.
      ...(incomplete ? { icon: 'warn' as const, detail: `${incomplete} · ${name}`, speech: undefined, wrap: true } : {}),
      onUndo: () => {
        void (async () => {
          try {
            await undo();
          } catch (cause) {
            showToast({ icon: 'warn', lead: cause instanceof Error ? cause.message : 'The project did not change.', wrap: true });
            return;
          }
          await afterWrite();
          dismissToast();
          say('Moved back.');
        })();
      },
    });
  };

  /**
   * Settings' Unarchive: the thread goes back to the list, in whatever
   * section its state puts it, and opens there (owner ruling 2026-10-12).
   */
  const unarchiveFromSettings = async (row: InboxListRow): Promise<boolean> => {
    try {
      await inboxApi.resolve(row.thread_id, false);
    } catch (cause) {
      showError(cause);
      return false;
    }
    go({ page: 'inbox', project: null, thread: row.thread_id });
    await refreshList(true);
    showToast({
      icon: 'check',
      lead: 'Back in your Inbox',
      detail: `“${row.subject ?? '(no subject)'}”`,
      onUndo: () => void archive(row.thread_id, row.thread_id, true),
    });
    return true;
  };

  // E marks the open thread (or the focused row) read, and again moves it
  // back; Z undoes while the toast is up. Never while typing, never with a
  // modifier (so the reply box keeps its own ⌘Z).
  // An open file (its viewer, the stepping bar, the guard row) and a guided
  // review own the keyboard: E and Z stand down there, and while the sound
  // dialog is up.
  const keysRef = useRef({ markRead, toast, thread, soundDialog, agentNoteOpen: false });
  keysRef.current = { markRead, toast, thread, soundDialog, agentNoteOpen: typeof agentNote === 'object' };
  /**
   * What E or Z does now, or null when it stands down (the rules: guards.ts
   * for typing, composition and repeat; the rest is the thread's own).
   */
  const threadKeyAction = (event: KeyboardEvent, key: 'e' | 'z'): (() => void) | null => {
    if (event.defaultPrevented || isRepeatKey(event) || isComposingKey(event)) return null;
    if (keysRef.current.soundDialog === 'open' || keysRef.current.agentNoteOpen || routeRef.current.guide) return null;
    // Words selected in a message: its toolbar takes the letters (a comment starting with them).
    if (selectionToolbarShowing()) return null;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target) {
      if (isEditableTarget(target)) return null;
      if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], iframe, .ib-view, [data-step-guard]')) return null;
    }
    // With a file open beside the thread, only a key aimed at the thread or the list counts.
    if (routeRef.current.file && !target?.closest('section.ib-pane, .ib-listcol')) return null;
    const { markRead: toggle, toast: current, thread: open } = keysRef.current;
    if (key === 'z') return current?.onUndo ?? null;
    if (routeRef.current.page !== 'inbox') return null;
    // A row the keyboard is on wins over the thread open beside the list; a
    // row that merely holds focus (clicked, or put there after a mouse close) does not.
    const rowEl = target?.closest('.ib-listcol [data-row]') ?? null;
    const rowId = rowEl && target && keyboardFocused(target) ? rowEl.getAttribute('data-row') : null;
    const threadId = rowId ?? (open && open.thread_id === routeRef.current.thread ? open.thread_id : null);
    if (!threadId) return null;
    const row = rowOf(threadId);
    if (!row || !canToggleRead(row)) return null;
    return () => void toggle(threadId, !(row.read_at ?? null));
  };
  const threadKey = useRef<(() => void) | null>(null);
  useShortcutScope({
    scope: inboxThreadShortcuts,
    handlers: {
      markRead: {
        when: (event) => (threadKey.current = threadKeyAction(event, 'e')) !== null,
        handle: () => threadKey.current?.(),
      },
      undo: {
        when: (event) => (threadKey.current = threadKeyAction(event, 'z')) !== null,
        handle: () => threadKey.current?.(),
      },
    },
  });

  const restart = async () => {
    setRestarting(true);
    const before = latest?.serverSession;
    try {
      await inboxApi.restart();
    } catch {
      setRestarting(false);
      return;
    }
    // The new Inbox comes up on the same port: reload once it answers.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const health = await inboxApi.health();
        if (health.serverSession !== before) {
          window.location.reload();
          return;
        }
      } catch {
        // Not up yet.
      }
    }
    setRestarting(false);
  };

  /** Restart onto the binary on disk, after saying what an unsent reply would lose. */
  const requestRestart = () => {
    if (unsentReply()) setUpdateDialog('restart');
    else void restart();
  };

  /** The sidebar button (and What's new's Update): what a press does depends on the state. */
  const pressUpdate = () => {
    if (!update || restarting) return;
    setUpdateError(null);
    if (update.state === 'ready') requestRestart();
    else if (update.state === 'available') {
      setUpdateDialog('update');
      void loadUpdateDetails();
    } else if (update.state === 'failed') {
      setUpdateDialog('failed');
      void loadUpdateDetails();
    }
  };

  /** Update now: the install script runs on the server; the button shows Updating… until the binary is in. */
  const updateNow = async () => {
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      const result = await inboxApi.updateNow();
      restartWhenReady.current = true;
      setUpdate(result.update);
      setUpdateDialog(null);
    } catch (cause) {
      setUpdateError(cause instanceof Error ? cause.message : 'The update could not start.');
    } finally {
      setUpdateBusy(false);
    }
  };

  // The update the person started is in: restart onto it (asking first when a reply would be lost).
  useEffect(() => {
    if (update?.state !== 'ready' || !restartWhenReady.current) return;
    restartWhenReady.current = false;
    if (unsentReply()) setUpdateDialog('restart');
    else void restart();
    // restart() reads only refs and setters it closes over each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update?.state]);

  const remindTomorrow = async () => {
    try {
      const result = await inboxApi.snoozeUpdate();
      setUpdate(result.update);
    } catch {
      // Nothing changes; the button stays.
    }
    setUpdateDialog(null);
  };

  const saveUpdateSwitches = async (change: { update_check?: boolean; auto_update?: boolean }) => {
    setSettingsError(null);
    setUpdateError(null);
    try {
      const saved = await inboxApi.saveUpdateSwitches(change);
      setSettings((current) => (current ? { ...current, updates: saved.updates } : current));
      setUpdateDetails((current) =>
        current ? { ...current, auto_update: { ...current.auto_update, on: saved.updates.auto_update.on }, check: { ...current.check, on: saved.updates.update_check.on } } : current,
      );
      void refreshList(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The setting was not saved.';
      setSettingsError(message);
      setUpdateError(message);
    }
  };

  const checkNow = async () => {
    setChecking(true);
    setSettingsError(null);
    try {
      const result = await inboxApi.checkForUpdate();
      setUpdateDetails(result);
      setUpdate(result.update);
      if (!result.checked.ok) setSettingsError(`Could not reach GitHub: ${result.checked.error ?? 'the check failed'}.`);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The check failed.');
    } finally {
      setChecking(false);
    }
  };

  const openWhatsNew = (version: string) => {
    setUpdateDialog(null);
    go({ page: 'whats-new', project: null, thread: null, version });
  };

  const whatsNewVersion = route.page === 'whats-new' ? (route.version ?? null) : null;
  useEffect(() => {
    if (!whatsNewVersion) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setWhatsNew(null);
    setWhatsNewError(null);
    // Notes this machine never saved are fetched from GitHub by the server,
    // which answers `notes_loading` while that takes longer than it waits.
    const load = (attempt: number) => {
      inboxApi
        .whatsNew(whatsNewVersion)
        .then((model) => !cancelled && setWhatsNew(model))
        .catch((cause) => {
          if (cancelled) return;
          if (cause instanceof InboxApiError && cause.code === 'notes_loading' && attempt < WHATS_NEW_RETRIES) {
            retry = setTimeout(() => load(attempt + 1), WHATS_NEW_RETRY_MS);
            return;
          }
          setWhatsNewError(cause instanceof Error ? cause.message : String(cause));
        });
    };
    load(0);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [whatsNewVersion]);

  const toggleTool = async (host: AgentToolHost, next: boolean) => {
    setSettingsError(null);
    setSettings((current) =>
      current ? { ...current, inbox_tool: { ...current.inbox_tool, hosts: { ...current.inbox_tool.hosts, [host]: next } } } : current,
    );
    try {
      const saved = await inboxApi.saveInboxTool({ [host]: next });
      setSettings((current) => (current ? { ...current, inbox_tool: saved.inbox_tool } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  // "Over your tailnet": saved to config.json and applied at once; the answer carries the address or why not.
  const [tailscaleBusy, setTailscaleBusy] = useState(false);
  const toggleTailscale = async (next: boolean, replaceExposed = false) => {
    setSettingsError(null);
    setTailscaleBusy(true);
    try {
      const saved = await inboxApi.saveTailscale(next, replaceExposed);
      setSettings((current) => (current ? { ...current, tailscale: saved.tailscale } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    } finally {
      setTailscaleBusy(false);
    }
  };

  // Settings' Delete thread / Delete project: the store, its blobs and the size read again.
  const deleteThread = async (threadId: string) => {
    setSettingsError(null);
    try {
      await inboxApi.deleteThread(threadId);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The thread was not deleted.');
    }
    await Promise.all([refreshSettings(), refreshList(true)]);
  };
  const deleteProject = async (projectId: string) => {
    setSettingsError(null);
    try {
      await inboxApi.deleteProject(projectId);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The project was not deleted.');
    }
    await Promise.all([refreshSettings(), refreshList(true)]);
  };

  const projects = latest?.projects ?? [];
  const latestSections = latest?.sections ?? [];
  // The open thread's row: the list's, else its own read's (an archived thread is not in the list).
  const openThreadRow = thread
    ? (latestSections.flatMap((section) => section.threads).find((row) => row.thread_id === thread.thread_id) ??
      (threadRow?.thread_id === thread.thread_id ? threadRow : null))
    : null;
  /** The projects where Mark all as read has something to do. */
  const projectsReadable = useMemo(() => projectsWithReadable(latestSections), [latestSections]);
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) counts.set(project.id, waitingCount(latestSections, project.id));
    return counts;
  }, [projects, latestSections]);

  const context: ConnectContext | null = settings
    ? { command: settings.mcp_command, mcpUrl: settings.mcp_url, platform: platformOf() }
    : null;

  const filterProject = route.page === 'inbox' && route.project ? projects.find((p) => p.id === route.project) ?? null : null;
  const notice = shown && latest ? heldNotice(filterSections(shown, route.project), filterSections(latest.sections, route.project), openedHere.current, heldOpen()).text : null;
  const firstRun = latest !== null && projects.length === 0;
  // The first-run screen shows who is running now ("Message Claude Code") and moves on by itself
  // once an agent is installed or turned on: it reads the agents again when the window comes back
  // into focus (the person ran the install command in a terminal) and every few seconds while shown.
  const { model: firstRunSessions } = useComposeSessions(firstRun);
  // Over the tailnet the agents route is local only: nothing to read again.
  const overTailnet = settings?.via === 'tailnet';
  useEffect(() => {
    if (!firstRun || overTailnet) return;
    let last = Date.now();
    const again = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < FIRST_RUN_AGENTS_MIN_GAP_MS) return;
      last = Date.now();
      void refreshAgents();
    };
    const timer = setInterval(again, FIRST_RUN_AGENTS_REFRESH_MS);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', again);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', again);
    };
  }, [firstRun, overTailnet, refreshAgents]);
  // A file beside the thread takes the list's and the sidebar's room (record 2.2).
  const fileOpen = route.page === 'inbox' && !!route.thread && !!route.file;
  const guideMessage =
    route.guide && thread && thread.thread_id === route.thread ? (thread.messages.find((m) => m.id === route.guide && m.guide) ?? null) : null;
  // The screen on top, which a phone shows alone (inbox.css): the list, a thread, a file.
  // A thread is on top once it has loaded, so a phone keeps the list until there is a thread to show.
  const view =
    route.page === 'inbox'
      ? fileOpen
        ? 'file'
        : route.thread && thread?.thread_id === route.thread
          ? 'thread'
          : 'list'
      : route.page;
  // A screen pushed over a shallower one slides in on a phone (inbox.css `data-enter`); one uncovered by
  // closing what was over it (a file back to its thread) does not slide again.
  const viewDepth = (v: string) => (v === 'file' ? 2 : v === 'thread' ? 1 : 0);
  const lastView = useRef(view);
  const entered = useRef<string | null>(null);
  if (lastView.current !== view) {
    entered.current = viewDepth(view) > viewDepth(lastView.current) ? view : null;
    lastView.current = view;
  }

  // A thread that covers the list (stack.ts) takes the focus with it, and gives it back to
  // its row: the list is hidden under it, so focus left on the row clicked (or on the pane's Back) would
  // sit on something nobody can see.
  // The list row that last had focus, and the one to return to on Back (see the resize effect below).
  const listFocus = useRef<string | null>(null);
  const returnRow = useRef<string | null>(null);
  const focusFrom = useRef<{ view: string; thread: string | null }>({ view, thread: null });
  // `‹ Inbox` in the thread's header with a file beside it: the thread whose row takes focus once the file
  // has closed and the list is back (the list is not drawn while the file is open, so it waits for the view).
  const backFromFile = useRef<{ thread: string; name: string | null; label: string } | null>(null);
  useEffect(() => {
    const before = focusFrom.current;
    focusFrom.current = { view, thread: view === 'thread' ? route.thread : null };
    if (before.view === view) return;
    const fromFile = backFromFile.current;
    backFromFile.current = null;
    if (phone) return;
    if (fromFile && before.view === 'file' && view === 'thread' && route.thread === fromFile.thread) {
      // After the stack is measured for the new layout: say what actually happened.
      requestAnimationFrame(() => {
        const covered = rootRef.current?.dataset.stack?.split(' ').includes('thread') ?? false;
        if (!covered) {
          focusFirst([`.ib-listcol .ib-lbody [data-thread-id="${CSS.escape(fromFile.thread)}"]`, 'section.ib-pane h2.ib-subject']);
          say(`${fromFile.label} list shown.${fromFile.name ? ` ${fromFile.name} closed.` : ''}`);
        } else {
          // No room for the list beside the thread even without the sidebar: the thread covers it, as when stacked.
          focusFirst(['section.ib-pane [data-stack-back]', 'section.ib-pane h2.ib-subject']);
          say(`${fromFile.name ?? 'The file'} closed.`);
        }
      });
      return;
    }
    if (stack.thread && view === 'thread' && before.view === 'list') {
      focusFirst(['section.ib-pane [data-stack-back]', 'section.ib-pane h2.ib-subject']);
    } else if (stack.thread && view === 'list' && before.view === 'thread' && before.thread) {
      // The row that had focus when the window stacked (below), else the thread's own row.
      const row = returnRow.current ?? before.thread;
      returnRow.current = null;
      focusFirst([`.ib-listcol .ib-lbody [data-thread-id="${CSS.escape(row)}"]`, `.ib-listcol .ib-lbody [data-thread-id="${CSS.escape(before.thread)}"]`]);
    }
  }, [view, route.thread, stack.thread, phone]);

  // The window resized across the stacking width with a thread open. Into it: a list row that
  // had focus is now hidden under the pane (and redrawn), so focus would drop to the page; it goes to the
  // pane's `‹ Inbox` instead, and Back returns it to that row. Out of it: the pane's Back is
  // gone, so focus goes to the row the person came from, now beside the pane.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      // A row, or its hover action beside it (`.ib-rw[data-row]`).
      const row = target?.closest?.('.ib-listcol [data-thread-id], .ib-listcol [data-row]');
      listFocus.current = row ? (row.getAttribute('data-thread-id') ?? row.getAttribute('data-row')) : null;
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  // The list on screen changed: play the slide when one was armed (settle.ts),
  // and, after a key, never leave focus on the page. A row that had focus and
  // left the rows on screen (for folded Quiet) hands it to the row now in its
  // slot; Show (whose line goes away) hands it to the first row it brought in.
  const listOrder = useRef<string[]>([]);
  const focusAfterShow = useRef(false);
  useLayoutEffect(() => {
    const body = listBody(rootRef.current);
    const from = slideFrom.current;
    slideFrom.current = null;
    const order = from?.order ?? listOrder.current;
    if (body && from) playSettle(body, from);
    const showBefore = showFrom.current;
    showFrom.current = null;
    if (showBefore && shown) {
      const ids = showBroughtIn(showBefore, shown);
      // A read that brings nothing in (Show again, a second refresh) leaves the light already on as it is.
      if (ids.size > 0) {
        clearLit();
        setLit(new Set());
        const start = from ? SHOW_LIT_AFTER_SLIDE_MS : 0;
        litTimers.current.push(
          setTimeout(() => setLit(ids), start),
          setTimeout(() => setLit(new Set()), start + SHOW_LIT_MS),
        );
      }
    }
    const shownAll = focusAfterShow.current;
    focusAfterShow.current = false;
    const gone = listFocus.current;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    if (body && lost && shownAll) {
      const rows = [...body.querySelectorAll<HTMLElement>('[data-thread-id]')];
      (rows.find((row) => !order.includes(row.getAttribute('data-thread-id')!)) ?? rows[0])?.focus({ preventScroll: true });
    } else if (body && lastInput === 'keyboard' && gone && lost && !rowElement(body, gone)) {
      const next = rowInSlot(order, gone, (id) => rowElement(body, id) !== null);
      const target = next ? rowElement(body, next) : body.querySelector<HTMLElement>('button.ib-band');
      target?.focus({ preventScroll: true });
    }
    listOrder.current = body ? [...body.querySelectorAll('[data-thread-id]')].map((el) => el.getAttribute('data-thread-id')!) : [];
  }, [shown]);
  const stackedBefore = useRef({ thread: stack.thread });
  useEffect(() => {
    const was = stackedBefore.current;
    stackedBefore.current = { thread: stack.thread };
    if (phone) return;
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || active.getClientRects().length === 0 || getComputedStyle(active).visibility === 'hidden';
    if (view === 'thread' && was.thread !== stack.thread) {
      if (stack.thread) {
        if (listFocus.current && (lost || active?.closest('.ib-listcol'))) {
          returnRow.current = listFocus.current;
          focusFirst(['section.ib-pane [data-stack-back]', 'section.ib-pane h2.ib-subject']);
        }
      } else if (lost) {
        const row = returnRow.current ?? route.thread;
        returnRow.current = null;
        if (row) focusFirst([`.ib-listcol .ib-lbody [data-thread-id="${CSS.escape(row)}"]`]);
      }
    }
  }, [stack.thread, view, route.thread, phone]);

  // The project compose treats as current: the list's filter, else the open thread's.
  const composeCurrent = (() => {
    const id = route.page === 'inbox' ? (route.project ?? thread?.project.id ?? null) : null;
    const folder = id ? projects.find((p) => p.id === id) : null;
    return folder ? { id: folder.id, root: folder.root, name: folder.name } : thread && route.thread ? { id: thread.project.id, root: thread.project.root, name: thread.project.name } : null;
  })();

  // The open card (`#board…&card=crd_…`), and where "Ask where this is" would go.
  const openCard = route.page === 'board' && route.card ? (cards?.cards.find((c) => c.id === route.card) ?? null) : null;
  const { model: cardSessions } = useComposeSessions(openCard !== null);
  const ask = openCard ? askTarget(openCard, cardSessions?.projects) : null;
  const askSession = ask?.session ?? null;
  /** The card's own agent has ended: "Ask where this is" asks another session in its project, and the card says so. */
  const askOther = ask && !ask.own ? { host: hostLabel(ask.host), project: cards?.projects?.[openCard!.project_id]?.name ?? null } : null;
  const closeCard = () => {
    setCardNote(null);
    const next = { ...routeRef.current, card: null };
    if (!backTo(hashOf(next))) writeRoute(next);
  };

  let main: ReactNode;
  if (route.page === 'settings') {
    main = (
      <SettingsPage
        settings={settings}
        context={context}
        error={settingsError}
        onToggleTool={toggleTool}
        agents={agents}
        onAgents={setAgents}
        onToggleTailscale={(next, replaceExposed) => void toggleTailscale(next, replaceExposed)}
        tailscaleBusy={tailscaleBusy}
        permission={notifications.permission}
        onToggleNotifications={(next) => void notifications.setEnabled(next)}
        notifyReach={notifications.reach}
        onTestNotification={notifications.sendTest}
        onDeleteThread={deleteThread}
        onDeleteProject={deleteProject}
        sound={settings?.sound ? sound : undefined}
        archived={<ArchivedBlock refreshKey={latest?.cursor ?? null} onUnarchive={unarchiveFromSettings} />}
        archivedTotal={archivedTotal}
        aboutDot={!!update}
        about={
          <AboutBlock
            version={latest?.version ?? settings?.version ?? 'dev'}
            details={updateDetails}
            switches={settings?.updates}
            checking={checking}
            error={null}
            onCheckNow={() => void checkNow()}
            onToggle={(change) => void saveUpdateSwitches(change)}
            update={update}
            onUpdate={pressUpdate}
            onWhatsNew={openWhatsNew}
            where={
              settings
                ? { data: tildePath(settings.data_dir, settings.home), mcpUrl: settings.mcp_url, mcpCommand: shellLine(settings.mcp_command) }
                : null
            }
          />
        }
        section={route.section ?? null}
        pairing={route.pair === true}
        phone={phone}
        onSection={(section) =>
          section === null && phone ? close({ page: 'settings', project: null, thread: null, section: null }) : go({ page: 'settings', project: null, thread: null, section })
        }
        onPairing={(open) =>
          open
            ? go({ page: 'settings', project: null, thread: null, section: 'devices', pair: true })
            : close({ page: 'settings', project: null, thread: null, section: 'devices' })
        }
        onBack={() => go(routeOf(settingsReturn.current))}
        onRetry={() => {
          setSettingsError(null);
          void refreshSettings();
        }}
      />
    );
  } else if (route.page === 'whats-new') {
    main = (
      <WhatsNewPage
        model={whatsNew}
        error={whatsNewError}
        update={update}
        onBack={() => {
          const hash = whatsNewReturn.current;
          if (!backTo(hash)) go(routeOf(hash));
        }}
        onUpdate={pressUpdate}
      />
    );
  } else if (route.page === 'drafts') {
    main = (
      <DraftsPage
        drafts={drafts}
        error={draftsError}
        phone={phone}
        onOpen={(draft, opener) => openCompose({ draft }, opener)}
        onDelete={(draft) => void deleteDraft(draft)}
        onCompose={(opener) => openCompose({}, opener)}
      />
    );
  } else if (route.page === 'board') {
    const boardActions: BoardActions = {
      onOpenCard: (card) => go({ page: 'board', project: null, thread: null, board: route.board ?? 'live', card: card.id }),
      onRestore: (card) => restoreCard(card),
      onDropsSeen: (cardIds) => void dropsSeen(cardIds),
      onView: (view) => go({ page: 'board', project: null, thread: null, board: view, card: null }),
    };
    main =
      route.board === 'shipped' || route.board === 'icebox' ? (
        <BoardListPage
          view={route.board}
          model={cards}
          error={cardsError}
          now={boardNow}
          phone={phone}
          actions={boardActions}
          onBack={() => {
            const live = { page: 'board' as const, project: null, thread: null, board: 'live' as const, card: null };
            if (!backTo(hashOf(live))) go(live);
          }}
        />
      ) : (
        <BoardPage model={cards} error={cardsError} now={boardNow} phone={phone} actions={boardActions} />
      );
  } else if (!latest || !shown) {
    main = <div className="ib-listcol">{loadError && <div className="ib-error" style={{ padding: 22 }}>{loadError}</div>}</div>;
  } else if (firstRun) {
    main = (
      <EmptyState
        context={context}
        agents={agents}
        agentsUnavailable={overTailnet ? 'tailnet' : agentsSettled && agents === null ? 'failed' : null}
        onRetry={() => void refreshAgents()}
        sessions={firstRunSessions}
        onAgents={setAgents}
        onMessage={(session, opener) => openCompose({ session }, opener)}
      />
    );
  } else {
    main = (
      <>
        {!fileOpen && (
        <InboxList
          scope={route.project}
          title={filterProject?.name ?? 'Inbox'}
          path={filterProject ? tildePath(filterProject.root, settings?.home) : null}
          sections={filterSections(shown, route.project)}
          filtered={filterProject !== null}
          // A stacked thread covers the list, which keeps its own width (and scroll) under it.
          narrow={route.thread !== null && !stack.thread}
          selectedThreadId={route.thread}
          lit={lit}
          notice={notice}
          ask={
            notifications.ask && soundDialog === 'none' && agentNote === 'none' ? (
              <NotificationAsk
                kind={notifications.ask}
                soundOn={sound.settings.enabled}
                movedFrom={settings?.notifications.allowed_origin ?? null}
                onTurnOn={() => void notifications.turnOn()}
                onNotNow={notifications.notNow}
                onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'general' })}
              />
            ) : notifications.slept && notifications.permission === 'granted' && soundDialog === 'none' && agentNote === 'none' ? (
              <TabSleptLine slept={notifications.slept} onDismiss={notifications.dismissSlept} />
            ) : null
          }
          // The title refreshes the list it names, the thread beside it staying open (the list adopts, as Show does).
          onRefresh={() => void refreshInbox(route.project, false)}
          refreshSpin={refreshSpin && refreshSpin.scope === route.project ? refreshSpin.key : null}
          onShowNew={() => {
            // Show's line goes away with the press: after a key, focus goes to the first row it brought in.
            focusAfterShow.current = lastInput === 'keyboard';
            listOrder.current = [...(listBody(rootRef.current)?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
            if (latestRef.current) showFrom.current = shown;
            settleList('all', true);
          }}
          onOpen={openRow}
          onMarkRead={(row) => void markRead(row.thread_id, true)}
          onRowAction={rowAction}
          onSearch={(opener) => openSearch(opener)}
          onCompose={(opener) => openCompose({}, opener)}
          phone={phone}
          empty={
            projectAllArchived(filterProject) ? (
              <div className="ib-empty-list" data-project-archived="">
                <b dir="auto">Everything in {filterProject!.name} is archived.</b>
                It leaves the sidebar when you go elsewhere, and comes back when an agent writes there.{' '}
                <a href="#settings/archived">See archived threads</a>
              </div>
            ) : null
          }
        />
        )}
        {route.thread && thread && thread.thread_id === route.thread && (
          <ThreadPane
            thread={thread}
            sent={openThreadRow?.sent ?? null}
            row={openThreadRow}
            onMarkRead={(read) => void markRead(thread.thread_id, read)}
            onAck={(messageId, on, agent) => void acknowledge(thread.thread_id, messageId, on, agent)}
            onArchive={(next) => void archive(thread.thread_id, thread.messages[0]!.id, next)}
            replyRequest={replyFor}
            onReplyOpened={() => setReplyFor(null)}
            onQuestions={patchQuestions}
            onChanged={afterWrite}
            onClose={() => close({ ...route, thread: null, file: null })}
            file={route.file ?? null}
            onOpenFile={(file, options) => {
              if (!file) return closeTo({ ...routeRef.current, file });
              const next = { ...routeRef.current, file };
              // Back through a linked page's stack: the browser's Back when this entry was opened from there.
              if (options?.back && backTo(hashOf(next))) return;
              writeRoute(next, options);
            }}
            onOpenGuide={(messageId) => go({ ...route, guide: messageId })}
            landing={
              route.msg
                ? {
                    messageId: route.msg,
                    terms: searchLanding.current?.messageId === route.msg ? searchLanding.current.terms : [],
                    questionKey: searchLanding.current?.messageId === route.msg ? searchLanding.current.questionKey : null,
                  }
                : null
            }
            onLanded={landed}
            lookSeq={look?.threadId === thread.thread_id ? look.seq : undefined}
            seenThrough={look?.threadId === thread.thread_id ? look.through : null}
            onSeen={(through) => seenOnSight(thread.thread_id, through)}
            covered={!!route.guide || updateDialog !== null || soundDialog === 'open' || agentNoteOpen || compose !== null}
            onScreenChange={(state) => {
              threadOnScreenRef.current = state;
            }}
            backLabel={filterProject?.name ?? 'Inbox'}
            phone={phone}
            stacked={stack.thread}
            fileStacked={stack.file}
            remote={settings ? (settings.via ?? 'local') === 'tailnet' : null}
            onBackToList={(fileName) => {
              // The file's own close (its ×), then focus on this thread's row and one line for a screen reader.
              const root = rootRef.current;
              if (root && sidebarOpen) {
                const width = root.getBoundingClientRect().width;
                const sidebar = root.querySelector('.ib-sb-inner')?.getBoundingClientRect().width ?? 0;
                const room = LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH + paneGutters();
                if (width >= room && width - sidebar < room) setSidebarHeld(true);
              }
              backFromFile.current = { thread: thread.thread_id, name: fileName, label: filterProject?.name ?? 'Inbox' };
              closeTo({ ...routeRef.current, file: null });
            }}
          />
        )}
      </>
    );
  }

  return (
    <div
      ref={rootRef}
      className="pn-inbox"
      // Tooltips (Tip, ui's HostTitle) portal here, so the window's tokens (the Soft switches) reach them.
      data-pn-tooltip-root=""
      data-view={view}
      data-enter={entered.current ?? undefined}
      data-stack={stack.thread || stack.file ? [stack.thread && 'thread', stack.file && 'file'].filter(Boolean).join(' ') : undefined}
    >
      {/* A file beside the thread takes the sidebar's room (record 2.2): it closes on the same spring, and the person's choice stays as it was. */}
      <SidebarShell
        className="ib-shell"
        open={route.page === 'settings' ? settingsSidebar : sidebarOpen && !fileOpen && !sidebarHeld}
        onOpenChange={(next) => {
          if (routeRef.current.page === 'settings') {
            setSettingsSidebar(next);
            return;
          }
          setSidebarHeld(false);
          changeSidebar(next);
        }}
        navigation={
          <Sidebar
            page={route.page}
            projectId={route.project}
            inboxCount={waitingCount(latestSections)}
            projects={projects}
            projectCounts={projectCounts}
            projectsReadable={projectsReadable}
            onProjectAction={(projectId, action) => void projectAction(projectId, action)}
            update={update}
            restarting={restarting}
            updated={updated}
            onSearch={(opener) => openSearch(opener)}
            onCompose={(opener) => openCompose({}, opener)}
            onBoard={() => go({ page: 'board', project: null, thread: null, board: 'live', card: null })}
            boardCount={cards ? boardOf(cards.cards).onYou + boardOf(cards.cards).droppedByAgent.length : 0}
            boardDropped={cards ? boardOf(cards.cards).droppedByAgent.length : 0}
            draftsCount={drafts?.length ?? 0}
            onDrafts={() => go({ page: 'drafts', project: null, thread: null })}
            // On the list it shows, Inbox (or a project) refreshes; with a thread open it closes it as before, and refreshes.
            onInbox={() => (route.page === 'inbox' && route.project === null ? void refreshInbox(null, route.thread !== null) : go({ page: 'inbox', project: null, thread: null }))}
            onProject={(projectId) =>
              route.page === 'inbox' && route.project === projectId ? void refreshInbox(projectId, route.thread !== null) : go({ page: 'inbox', project: projectId, thread: null })
            }
            refreshes={route.page === 'inbox' && route.thread === null}
            refreshSpin={refreshSpin}
            onSettings={() => go({ page: 'settings', project: null, thread: null })}
            onUpdate={pressUpdate}
            onWhatsNew={openWhatsNew}
            // Not on a page opened over the tailnet: Settings → Agents is local only there.
            restartClaudeCode={settings && settings.via !== 'tailnet' ? restartClaudeCode : 0}
            onRestartSessions={() => go({ page: 'settings', project: null, thread: null, section: 'agents' })}
            mcpCommand={settings?.mcp_command ?? null}
          />
        }
      >
        <main className="ib-main">{main}</main>
      </SidebarShell>
      {updateDialog === 'update' && update && (
        <UpdateDialog
          details={updateDetails}
          update={update}
          error={updateError}
          busy={updateBusy}
          onUpdateNow={() => void updateNow()}
          onRemindTomorrow={() => void remindTomorrow()}
          onCancel={() => setUpdateDialog(null)}
          onWhatsNew={() => openWhatsNew(update.version)}
          onAutoUpdate={(next) => void saveUpdateSwitches({ auto_update: next })}
        />
      )}
      {updateDialog === 'restart' && update && (
        <RestartDialog
          update={update}
          subject={unsentReply()?.subject ?? 'this thread'}
          onRestart={() => {
            setUpdateDialog(null);
            void restart();
          }}
          onCancel={() => setUpdateDialog(null)}
        />
      )}
      {updateDialog === 'failed' && update && (
        <FailedDialog
          update={update}
          details={updateDetails}
          home={settings?.home ?? null}
          onRetry={() => void updateNow()}
          onClose={() => setUpdateDialog(null)}
        />
      )}
      {soundDialog === 'open' && settings && (
        <SoundIntroDialog
          line={notificationLine(settings.notifications.enabled, notifications.permission)}
          playing={sound.playing}
          onPlay={() => sound.preview()}
          onTurnOnNotifications={() => void notifications.setEnabled(true)}
          onKeep={() => setSoundDialog('shown')}
          onTurnOff={() => {
            setSoundDialog('shown');
            void sound.setEnabled(false).then((saved) => showToast(saved ? { icon: 'mute', lead: 'Sound off' } : { icon: 'warn', lead: 'Sound setting not saved' }, 4200));
          }}
        />
      )}
      {typeof agentNote === 'object' && agents && (
        <AgentNoteDialog
          rows={agentNote.rows}
          report={agentNote.report}
          noteText={agents.note_text}
          onModel={setAgents}
          onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'agents' })}
          onClosed={() => setAgentNote('shown')}
        />
      )}
      {openCard && (
        <CardDialog
          key={openCard.id}
          card={openCard}
          model={cards}
          now={boardNow}
          canAsk={askSession !== null}
          busy={cardBusy}
          note={cardNote?.card === openCard.id ? cardNote : null}
          askOther={askOther}
          onClose={closeCard}
          onMove={(column) => void moveCardTo(openCard, column, true)}
          onIcebox={() => void iceboxCard(openCard, true)}
          onDrop={(reason) => void dropCard(openCard, reason, true)}
          onRestore={() => void restoreCard(openCard, true)}
          onOpenThread={(threadId) => go({ page: 'inbox', project: null, thread: threadId })}
          onAsk={() => {
            const session = askSession;
            const card = openCard;
            closeCard();
            openCompose({ session, body: askWhereText(card) });
          }}
        />
      )}
      {toast && soundDialog !== 'open' && !agentNoteOpen && <InboxToast toast={toast} phone={phone} onDismiss={dismissToast} onHold={holdToast} />}
      <SearchHost
        mounted={searchMounted}
        open={searchOpen}
        phone={phone}
        currentProject={route.page === 'inbox' ? route.project : null}
        projects={projects}
        onClose={closeSearch}
        onOpenResult={openSearchResult}
        actions={paletteActions}
        onAction={(action) => openCompose(action.kind === 'message' ? { session: action.target.session } : {}, searchOpener.current)}
      />
      {compose && (
        <ComposeDialog
          request={compose}
          phone={phone}
          current={composeCurrent}
          lastSent={lastSent}
          home={settings?.home ?? null}
          onSent={(sent) => {
            rememberSent(sent.session);
            composeSent(sent);
          }}
          onSaved={composeSaved}
          onDeleted={(draft) => {
            closeCompose(draftNeighbour(draft.id));
            void deleteDraft(draft, true);
          }}
          onClose={() => closeCompose()}
        />
      )}
      <div className="ib-sr" aria-live="polite" data-inbox-live="">
        {said}
      </div>
      {guideMessage && thread && (
        <GuidePane
          thread={thread}
          message={guideMessage}
          onBack={() => close({ ...route, guide: null })}
          onClose={() => close({ ...route, thread: null, guide: null })}
        />
      )}
    </div>
  );
}

export function InboxApp() {
  return (
    <ThemeProvider defaultTheme="system">
      {/* Every tooltip in the window (Tip): 150 ms to open, and the next one at once within 400 ms. */}
      <TooltipProvider delayDuration={TIP_DELAY_MS} skipDelayDuration={400} disableHoverableContent>
        <Inbox />
      </TooltipProvider>
    </ThemeProvider>
  );
}
