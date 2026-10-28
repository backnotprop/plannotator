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

import type { ActionMark } from './components/ActionChecklist';
import { isMootNoteRefusal } from './actionSaves';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { TooltipProvider, TOOLTIP_SKIP_DELAY_MS } from '@plannotator/ui/components/Tooltip';
import { TIP_DELAY_MS } from './components/Tip';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import type { ForgeRefCardResult } from '@plannotator/core/forge-ref-card';
import { selectionToolbarShowing } from './selectionToolbar';
import { storage } from '@plannotator/ui/utils/storage';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import type { InboxCardWire, InboxDecision, InboxHealth, InboxListRow, InboxListSection, InboxQuestion, InboxReplyDraftRow, InboxThread } from '@plannotator/core/inbox-types';
import { DecisionMode } from './decisions/DecisionMode';
import { DecisionPill, decideEntryShown } from './decisions/entry';
import { threadDecisions } from './decisions/model';
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
import { discardPreparedInboxEvents, prepareInboxEvents } from './sharedEvents';
import { addOwnThreads, adoptKeepingOpen, drawnSection, filterSections, heldNotice, markHeldRowArchived, putRowBack, refreshHeldRows, settleOwn, settlesOnBack, settleThread, showBroughtIn, waitingCount, type OpenThread } from './held';
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
import { Icon } from './icons';
import { TourBar, TourCoach, TourLoading, TourMain, TourNavigation, loadTour, tourComposeBody, tourComposeTransport, tourView, useReducedMotion, useTourFixture, useTourReplay } from './tour/Tour';
import { TourEntry, tourEntryModel } from './tour/TourEntry';
import { TOUR_FIT_LINES, TOUR_FIT_TITLE, TourIntro } from './tour/Fit';
import { TOUR_FIRST_QUESTION_PROMPT, TOUR_PROJECT_ID, TOUR_START, TOUR_STEPS, TOUR_THREAD, tourCanBack, tourCanForward, tourCoach, tourCoachSpeech, tourReducer, tourStepOf, type TourAction, type TourDegraded, type TourUi } from './tour/model';
import { ThreadWait } from './components/ThreadWait';
import { AgentNoteDialog } from './components/AgentNoteDialog';
import { FeedbackDialog } from './components/FeedbackDialog';
import { feedbackCopiedToast, feedbackPrompt } from './feedbackPrompt';
import { cardReport, noteQuestionRows } from './agents';
import type { InboxAgentRow, InboxAgentsModel, InboxConnectReport, InboxTourChange, InboxTourState } from '@plannotator/core/inbox-types';
import { SettingsPage } from './components/Settings';
import { ArchivedBlock } from './components/Archived';
import { NotificationAsk, TabSleptLine } from './components/NotificationAsk';
import { useInboxNotifications } from './notify';
import { useInboxSound } from './sound';
import { notificationLine, SoundIntroDialog } from './components/SoundIntro';
import { GuidePane } from './components/GuidePane';
import { AboutBlock, FailedDialog, GeneralUpdateRow, RestartDialog, UpdateDialog, WhatsNewPage } from './components/Updates';
import { leaveOnPurpose, unsentReply } from './unsent';
import { InboxToast, type InboxToastModel, toastSpeech } from './components/Toast';
import { canToggleRead, MARK_READ_LOOK_WAIT_MS, MARK_READ_UNDO_MS, markReadToast, seenHeldInNew } from './markRead';
import { threadLink, type RowMenuAction } from './rowMenu';
import { movePin, unpinnedWhere } from './pins';
import type { PinnedAction } from './components/PinnedRow';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { newBatchId, projectAllArchived, projectBatchToast, projectsWithReadable, type ProjectAction } from './projectMenu';
import { lookBoundary } from './folding';
import { latestAgentSeq } from './seenOnSight';
import { isPhone, trackKeyboard, usePhone } from './phone';
import { installPasteFollowsField } from './pasteTarget';
import { installPlainTextPaste } from '@plannotator/ui/utils/pasteInsert';
import { LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, paneGutters, useStack } from './stack';
import { backBy, backTo, pushScreen, settleLanding, whileWritingRoute } from './history';
import { parseFileView, sameScreenAnyView } from './fileView';
import { fileEntryOp, fullExitFile, fullFromSide, pageBackPastSwitch, withFullMark, type FrameMove, type FullMark } from './fullScreenOrigin';
import { adoptSavedTheme, inboxServerSync } from './theme';
import { adoptSavedDiffStyle } from './diffStyle';
import { adoptSavedTextSize, applyRememberedTextSize } from './textSize';
import { parseSettingsHash, settingsHash, type SettingsSection } from './settingsRoute';
import { ComposeDialog, type ComposeRequest, type ComposeSent } from './compose/ComposeDialog';
import { DraftsPage } from './compose/DraftsPage';
import { BoardPage, type BoardMove } from './board/BoardPage';
import { BoardOff } from './board/BoardOff';
import { CardChip } from './board/CardChip';
import { boardViewOf, newCardProject, type BoardView } from './board/model';
import { useComposeSessions } from './compose/useComposeSessions';
import { composeActions, composeTargets, hostLabel, type ComposeAction } from './compose/model';
import type { CardsModel, DraftView, UpdateCheckFailing } from './api';
import { NO_RESTART_AGENTS, restartAgentsOf } from './restartAgents';
import type { InboxRestartAgents } from '@plannotator/core/inbox-types';
import { inboxTabCount, useTabCount } from './tabCount';
import { pageOffersUpdates, sidebarUpdateNotice, updateForPage } from './updateNotice';

// The Inbox has no /api/config and no browser-agent tools: settings stay in
// the page's own cookies, except the theme, which goes to config.json `theme`
// through the Inbox's settings route so plan review follows it (theme.ts).
// WebMCP is off.
// No image uploads either: a comment's image would need an upload route the
// Inbox does not have, so the composer says so instead of posting nowhere.
// The text size this browser last showed, on the document before the first render (textSize.ts).
applyRememberedTextSize();

configurePlannotatorUI({
  serverSync: inboxServerSync,
  // ui's own hover text (annotation panel and toolbar, question cards, links to attachments) as ui's Tooltip,
  // never a native title (the owner, 2026-10-17).
  componentTooltips: true,
  // A digit-only #186379 in a message is a PR or issue of the project's repo, not a colour (#1932).
  digitHexIssueRefs: true,
  // The selection toolbar's Copy copies rich text, in messages and attached files (#1972).
  richCopy: true,
  // Hover cards for issue, PR and MR links: the server fetches with this computer's gh or glab (ref-cards.ts).
  refCardTransport: async (href, _ref, signal) => {
    const res = await fetch(`/api/inbox/ref?url=${encodeURIComponent(href)}`, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as ForgeRefCardResult;
  },
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
/** The session the person last sent a new message to: first in the To picker and the palette's "Message <host>" while it is live; never put in To by itself. */
const COMPOSE_LAST_COOKIE = 'plannotator-inbox-compose-last';
/** How often the Drafts page reads its drafts again, so each chip follows its session. */
const DRAFTS_REFRESH_MS = 10_000;
/** No cards handled yet (the Board before its first read of a visit). */
const EMPTY_SET: ReadonlySet<string> = new Set();
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
/**
 * Opening a thread whose read failed (a dropped connection, a 5xx; not a 404): read it again after
 * these waits, then every last one, while it stays open. Before this the pane stayed blank until some
 * agent wrote anywhere in the Inbox (the event stream re-reads the open thread), seconds or forever.
 */
export const THREAD_READ_RETRY_MS = [250, 1000, 2000, 4000, 5000] as const;
/**
 * A read of the open thread with no answer by then (a connection held behind
 * the browser's six per host, a stalled server) fails and is read again, as
 * a dropped one is; before this it waited for good.
 */
export const THREAD_READ_TIMEOUT_MS = 8000;
/** Why the open thread is not on screen yet: its read failed (read again soon), or the server has no such thread. */
interface ThreadLoad {
  threadId: string;
  state: 'failed' | 'missing';
  error: string;
}

interface Route {
  page: 'inbox' | 'settings' | 'whats-new' | 'drafts' | 'tour' | 'board';
  /** The Board's list (`#board`, `#board=shipped`, `#board=icebox`; approval "inbox-board", step 2). */
  board?: BoardView;
  /** The opened Board card (`#board&card=crd_…`), or on a thread the card it was opened from (its "‹ Board" way back). */
  card?: string | null;
  /**
   * On a thread opened from a Board card: the project the Board was filtered to (`&board-project=prj_…`), so its
   * way back lands on the same filtered Board. On the Board itself the filter is `project` (`#board&project=prj_…`).
   */
  boardProject?: string | null;
  /** The onboarding tour's step (`#tour=3`, approval "inbox-onboarding-tour"): 1 to 6. */
  step?: number;
  /** The release whose notes the What's new page shows (`#whats-new=0.28.12`). */
  version?: string | null;
  project: string | null;
  thread: string | null;
  /**
   * An attachment open beside the thread: `file=att_…`, `v=sent` for the version the agent sent, `at=` an annotation to show,
   * `linked=` a page the attached HTML page links to, shown read-only over it (its path in the page's folder, `#fragment` kept),
   * `view=full|side` the view it is shown in (fileView.ts; absent: the remembered choice, then the rule by kind).
   */
  file?: { id: string; version: 'current' | 'sent'; focus: string | null; linked?: string | null; view?: 'full' | 'side' | null } | null;
  /** The message whose guided review is open over the window (`#thread=…&guide=msg_…`). */
  guide?: string | null;
  /**
   * The thread's Artifacts view (`#thread=…&artifacts`, approval "inbox-thread-artifacts"): the grid of every
   * artifact in place of the messages. A file or a guided review opened from it keeps it, so their Back returns to it.
   */
  artifacts?: boolean;
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
  /** `#settings/experimental` (an old link): Capabilities, landing on its Experimental group. Never written to the address. */
  experimental?: boolean;
}

function readRoute(): Route {
  return routeOf(window.location.hash);
}

function routeOf(fullHash: string): Route {
  const hash = fullHash.replace(/^#/, '');
  const settingsAt = parseSettingsHash(hash);
  if (settingsAt) return { page: 'settings', project: null, thread: null, section: settingsAt.section, pair: settingsAt.pair, experimental: settingsAt.experimental };
  const params = new URLSearchParams(hash);
  if (params.has('whats-new')) return { page: 'whats-new', project: null, thread: null, version: params.get('whats-new') };
  if (params.has('tour')) return { page: 'tour', project: null, thread: null, step: tourStepOf(params.get('tour')) };
  if (params.has('drafts')) return { page: 'drafts', project: null, thread: null };
  // The Board's project filter rides the list's own key (`#board&project=prj_…`).
  if (params.has('board')) return { page: 'board', project: params.get('project') || null, thread: null, board: boardViewOf(params.get('board')), card: params.get('card') };
  const thread = params.get('thread');
  const fileId = thread ? params.get('file') : null;
  return {
    page: 'inbox',
    project: params.get('project'),
    thread,
    file: fileId ? { id: fileId, version: params.get('v') === 'sent' ? 'sent' : 'current', focus: params.get('at'), linked: params.get('linked'), view: parseFileView(params.get('view')) } : null,
    guide: thread ? params.get('guide') : null,
    msg: thread ? params.get('msg') : null,
    artifacts: thread ? params.has('artifacts') : false,
    card: thread ? params.get('card') : null,
    // The Board list the card was opened from (Shipped, Icebox): the way back goes there.
    board: thread && params.get('card') ? boardViewOf(params.get('from')) : undefined,
    boardProject: thread && params.get('card') ? params.get('board-project') || null : null,
  };
}

/** The route's hash, `#thread=…` (empty for the list at rest). */
function hashOf(route: Route): string {
  let hash = '';
  if (route.page === 'settings') hash = settingsHash({ section: route.section ?? null, pair: route.pair });
  else if (route.page === 'whats-new') hash = new URLSearchParams({ 'whats-new': route.version ?? '' }).toString();
  else if (route.page === 'drafts') hash = 'drafts';
  else if (route.page === 'board')
    hash =
      (route.board && route.board !== 'lanes' ? `board=${route.board}` : 'board') +
      (route.project ? `&project=${encodeURIComponent(route.project)}` : '') +
      (route.card ? `&card=${encodeURIComponent(route.card)}` : '');
  else if (route.page === 'tour') hash = `tour=${route.step ?? 1}`;
  else {
    const params = new URLSearchParams();
    if (route.project) params.set('project', route.project);
    if (route.thread) params.set('thread', route.thread);
    if (route.thread && route.msg) params.set('msg', route.msg);
    if (route.thread && route.artifacts) params.set('artifacts', '');
    if (route.thread && route.file) {
      params.set('file', route.file.id);
      if (route.file.version === 'sent') params.set('v', 'sent');
      if (route.file.focus) params.set('at', route.file.focus);
      if (route.file.linked) params.set('linked', route.file.linked);
      // The view rides the address (fileView.ts), so a reload or a shared link opens the same way.
      if (route.file.view) params.set('view', route.file.view);
    }
    if (route.thread && route.guide) params.set('guide', route.guide);
    // A thread opened from a Board card: its way back is the card (`&card=crd_…`).
    if (route.thread && route.card) params.set('card', route.card);
    if (route.thread && route.card && route.board && route.board !== 'lanes') params.set('from', route.board);
    if (route.thread && route.card && route.boardProject) params.set('board-project', route.boardProject);
    // `&artifacts`, a flag: written without its empty `=`.
    hash = params.toString().replace(/(^|&)artifacts=(?=&|$)/, '$1artifacts');
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
function writeRoute(route: Route, options: { replace?: boolean; fullMark?: FullMark | null } = {}): void {
  // The Artifacts view belongs to the thread it was opened in: another thread, or a message to land on, opens on the messages.
  if (route.artifacts && (route.thread !== readRoute().thread || route.msg)) route = { ...route, artifacts: false };
  const hash = hashOf(route);
  const next = hash || window.location.pathname + window.location.search;
  // Leaving the tour takes the tour's own entry, whatever leads out of it (a sidebar row, a search result, a link),
  // so the browser's Back never reopens #tour=N.
  const leavingTour = readRoute().page === 'tour' && route.page !== 'tour';
  // `fullMark`: the entry's full-screen mark (fullScreenOrigin.ts). Absent: a replace keeps the one on screen, a push sets none.
  const mark = options.fullMark;
  if (options.replace || leavingTour) {
    const state = mark === undefined ? window.history.state : withFullMark(window.history.state, mark);
    if (hash !== currentHash() || state !== window.history.state) window.history.replaceState(state, '', next);
  } else {
    // Each entry remembers the one it was opened from, so a phone's way back can be the browser's own Back (closeTo).
    pushScreen(hash, currentHash(), next, window.history, mark ? withFullMark(null, mark) : undefined);
  }
  // Its own hashchange: a Back still on its way does not land in it (history.ts settleLanding).
  whileWritingRoute(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
}

/** The history-entry mark an ended tour leaves on its own entry: the hash it went back to (approval "inbox-onboarding-tour"). */
const TOUR_ENDED_STATE = 'ibTourEnded';

/**
 * A tour address, settled before the window reads it:
 * - an entry the tour ended from (Exit or Finish went back from it, leaving it
 *   ahead in history) is replaced by the screen the tour went back to, so the
 *   browser's Forward, or a reload of that entry, never reopens the tour;
 * - an odd step (`#tour=`, `0`, `abc`, `99`, `2.5`) is written as the step it reads as.
 */
function settleTourEntry(): void {
  if (routeOf(window.location.hash).page !== 'tour') return;
  const state = window.history.state as Record<string, unknown> | null;
  if (state && typeof state[TOUR_ENDED_STATE] === 'string') {
    const { [TOUR_ENDED_STATE]: to, ...rest } = state;
    window.history.replaceState(rest, '', (to as string) || window.location.pathname + window.location.search);
    return;
  }
  const canonical = `#tour=${tourStepOf(new URLSearchParams(window.location.hash.replace(/^#/, '')).get('tour'))}`;
  if (window.location.hash !== canonical) window.history.replaceState(window.history.state, '', canonical);
}

/**
 * Set when a tour decision (finished, skipped) could not be saved on the server
 * (config.json unreadable, the server stopped): this browser remembers it, so
 * Two paths does not come back here. A cookie, so a port change keeps it.
 */
const TOUR_DECIDED_COOKIE = 'plannotator-inbox-tour-decided';

/**
 * `#settings/experimental`, Experimental's own page before it moved into
 * Capabilities (the owner, 2026-10-27): the address becomes
 * `#settings/capabilities` in place (no new history entry). True when it
 * did, so the route keeps landing on the Experimental group.
 */
function settleOldExperimental(): boolean {
  if (!parseSettingsHash(window.location.hash.replace(/^#/, ''))?.experimental) return false;
  window.history.replaceState(window.history.state, '', `#${settingsHash({ section: 'capabilities' })}`);
  return true;
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

/** The tab is visible and has focus: what the tour's replay needs to stand in for notifications with its chip. */
function tourPageInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Focus the first element on screen that matches one of `selectors`, in order (a list draws some rows twice, one hidden). */
function focusFirst(selectors: readonly string[]): void {
  for (const selector of selectors) {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => candidate.getClientRects().length > 0);
    if (el) {
      // Inside a thread's messages (its subject heading): focus never moves the thread's scroll, the place the
      // person was in (closing a file with `‹ Inbox` put the thread back at its top).
      el.focus(el.closest('.ib-pbody') ? { preventScroll: true } : undefined);
      return;
    }
  }
}

/** A tour setting that did not save is tried again after these waits (ms), then said. */
const TOUR_SAVE_RETRY_MS = [1000, 4000];
/** How long the first-run screen waits for the settings before it draws without them. */
const SETTINGS_LATE_MS = 1500;

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
  const [route, setRoute] = useState<Route>(() => {
    settleTourEntry();
    return readRoute();
  });
  // Open or closed as the person left it (⌘B or the toggle): a cookie of the Inbox's own, open when absent.
  const [sidebarOpen, setSidebarOpen] = useState(() => storage.getItem(SIDEBAR_OPEN_COOKIE) !== 'false');
  const changeSidebar = useCallback((next: boolean) => {
    setSidebarOpen(next);
    storage.setItem(SIDEBAR_OPEN_COOKIE, String(next));
  }, []);
  const [latest, setLatest] = useState<ListModel | null>(null);
  /**
   * Decision mode (experimental, approval "inbox-decision-mode"): the
   * projection while the feature is on, and the sitting (open, or tucked
   * into its pill behind a thread). Off, nothing of it renders. Thread only
   * (owner, 2026-10-27): a sitting is one thread's decisions (`thread`), opened
   * from that thread's open-questions list; there is no global way in.
   */
  const [decisions, setDecisions] = useState<InboxDecision[] | null>(null);
  // `startNonce`: a new start while the sitting is open moves it to that card.
  const [decide, setDecide] = useState<{ thread: string; title: string | null; tucked: boolean; start: string | null; startNonce: number } | null>(null);
  /** What opened decision mode: focus goes back there when the sitting ends. */
  const decideOpener = useRef<HTMLElement | null>(null);
  const [decideLeft, setDecideLeft] = useState(0);
  const [decidePaused, setDecidePaused] = useState(0);
  const decisionModeOnRef = useRef(false);
  const questionListeners = useRef(new Set<(question: InboxQuestion) => void>());
  const subscribeQuestions = useCallback((listener: (question: InboxQuestion) => void) => {
    questionListeners.current.add(listener);
    return () => void questionListeners.current.delete(listener);
  }, []);
  const refreshDecisions = useCallback(async () => {
    if (!decisionModeOnRef.current) return;
    try {
      const next = await inboxApi.decisions();
      if (decisionModeOnRef.current) setDecisions(next.decisions);
    } catch {
      // Off on the server (another window turned it off): the next settings read says so.
    }
  }, []);
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
  /** The open thread's read when it has not landed: failed (read again soon) or missing (a 404). */
  const [threadLoad, setThreadLoadState] = useState<ThreadLoad | null>(null);
  const threadLoadRef = useRef<ThreadLoad | null>(null);
  const setThreadLoad = useCallback((next: ThreadLoad | null) => {
    const current = threadLoadRef.current;
    // The same failure again (a retry): nothing changes on screen, so nothing is said again.
    if (current && next && current.threadId === next.threadId && current.state === next.state && current.error === next.error) return;
    threadLoadRef.current = next;
    setThreadLoadState(next);
  }, []);
  /** Each read of a thread is numbered; an older one never overwrites a newer one that landed (A, then B, then A again). */
  const threadReadSeq = useRef(0);
  const threadReadApplied = useRef(0);
  /** The open thread as last read, for the open effect when another read (the event stream's) landed first. */
  const threadLoaded = useRef<InboxThread | null>(null);
  /** Wakes the open effect's wait between retries when another read lands the thread. */
  const wakeThreadRetry = useRef<(() => void) | null>(null);
  /** Focus was in the thread's place when it gave way to the thread: it goes to the thread's subject. */
  const focusThreadSubject = useRef(false);
  /** Try again on the placeholder: the open effect reads the thread at once. */
  const [threadRetry, setThreadRetry] = useState(0);
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
  /** The note dialog was decided on this load (shown or not): state, so the notification lines re-render when it is. */
  const [agentNoteSettled, setAgentNoteSettled] = useState(false);
  /** The sound dialog's claim has answered on this load (or it was never due). */
  const [soundClaimed, setSoundClaimed] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  /** The last settings read failed (kept apart from settingsError, which a failed save also sets). */
  const [settingsReadFailed, setSettingsReadFailed] = useState(false);
  /** The first settings read is late: the first-run screen draws without it rather than wait blank. */
  const [settingsLate, setSettingsLate] = useState(false);
  const [update, setUpdate] = useState<InboxHealth['update']>(null);
  const [restarting, setRestarting] = useState(false);
  // What this page may offer: nothing over the tailnet, where the update routes are local only.
  const pageUpdate = updateForPage(update, settings);
  // Checking for updates has failed for hours (packages/server/inbox-updates.ts): the sidebar's quiet row,
  // About's dot and the General row's line. Not on a page opened over the tailnet (About is local only there).
  const [checkFailing, setCheckFailing] = useState<UpdateCheckFailing | null>(null);
  const pageCheckFailing = pageOffersUpdates(settings) ? checkFailing : null;
  // The sidebar toggle's dot while the sidebar is closed: an update the Update button offers, or checking failing.
  const updateState = pageUpdate?.state ?? null;
  const sidebarToggleNotice = useMemo(
    () => sidebarUpdateNotice(updateState, restarting, !!pageCheckFailing),
    [updateState, restarting, pageCheckFailing],
  );
  /** This run started on a newer version: the sidebar's "What's new in X" link. */
  const [updated, setUpdated] = useState<string | null>(null);
  // Claude Code sessions a /reload-plugins would bring up to date: the sidebar's "Reload Claude Code N" (owner approval "restart-warning").
  const [restartAgents, setRestartAgents] = useState<InboxRestartAgents>(NO_RESTART_AGENTS);
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
  /** Sidebar → Feedback (components/FeedbackDialog.tsx): open only on the person's click. */
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const soundDialogAsked = useRef(false);
  const routeRef = useRef(route);
  routeRef.current = route;
  /**
   * Real messages that reached the person's Inbox while the tour ran (choice
   * 7): a chip in the tour bar, never an interruption. The tour is in front,
   * so they raise no notification and no sound; both resume when it ends.
   */
  const [tourArrivals, setTourArrivals] = useState<{ count: number; thread: string | null }>({ count: 0, thread: null });
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
  /** Decision mode's "Open the thread" (thread only): the question to land on, its prompt focused. */
  const decideLanding = useRef<{ messageId: string; questionKey: string } | null>(null);
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
  /** Open threads holding unsent work (approval "inbox-reply-drafts"): the Drafts row counts them, its page lists them. */
  const [replyDrafts, setReplyDrafts] = useState<InboxReplyDraftRow[]>([]);
  /** Raised when the open thread's reply draft changed (`event: drafts`): the thread reads it again. */
  const [draftChanged, setDraftChanged] = useState(0);
  // Raised when the Inbox says a session it runs in the open thread changed (`event: runs`).
  const [runsTick, setRunsTick] = useState(0);
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
    // Decision mode is thread only (owner, 2026-10-27): a Stopped notification opens its thread too, never the dialog.
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
      // A Back this window started: its rewrite of the entry it landed on comes first (history.ts settleLanding).
      settleLanding();
      stripStrayMsg();
      settleTourEntry();
      const oldExperimental = settleOldExperimental();
      setRoute(oldExperimental ? { ...readRoute(), experimental: true } : readRoute());
    };
    stripStrayMsg();
    settleOldExperimental();
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
   * with everything (`all`: Show, another folder or page). `opening`: the
   * thread a covered list settles behind (a phone, a stacked window), which
   * settles as it now is, like the thread just closed.
   */
  const settleList = useCallback(
    (what: 'own' | 'all', slide: boolean, opening?: OpenThread) => {
      cancelSettle();
      // The thread just closed settles as it now is, an arrival there included (held.ts settleOwn).
      const closed = opening ?? closing.current;
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
      // Before the render: what waits on this read (Mark read after a look, markRead) reads the rows it brought.
      latestRef.current = next;
      setLatest(next);
      if (adopt && slide) armSlide();
      // Show's light for a refresh (clicking Inbox): the rows it brings in, against the list on screen now.
      if (adopt && refresh?.light) showFrom.current = shownRef.current;
      // A refresh beside an open thread keeps that thread's row where it is on screen (held.ts adoptKeepingOpen).
      const keep = adopt && refresh?.keepOpen ? routeRef.current.thread : null;
      setUpdate(next.update);
      setUpdated(next.updated ?? null);
      setRestartAgents(restartAgentsOf(next.restart_agents, next.restart_claude_code));
      setCheckFailing(next.update_check_failing ?? null);
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
  /**
   * Per thread, the looks this tab has sent (the open look, seen on sight) and
   * the list read after each, until they land. Mark read waits for them, so it
   * decides on the state the look gives the thread whenever it is pressed
   * (markRead.ts `seenHeldInNew`).
   */
  const looksInFlight = useRef(new Map<string, Set<Promise<unknown>>>());
  const trackLook = useCallback((threadId: string, look: Promise<unknown>) => {
    const looks = looksInFlight.current;
    const mine = looks.get(threadId) ?? new Set<Promise<unknown>>();
    looks.set(threadId, mine);
    mine.add(look);
    const done = () => {
      mine.delete(look);
      if (mine.size === 0 && looks.get(threadId) === mine) looks.delete(threadId);
    };
    look.then(done, done);
  }, []);
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
        const look = inboxApi
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
        trackLook(threadId, look);
      };
      attempt(0);
    },
    [refreshList, trackLook],
  );

  const refreshThread = useCallback(async (threadId: string) => {
    const mine = ++threadReadSeq.current;
    try {
      const next = await inboxApi.thread(threadId, THREAD_READ_TIMEOUT_MS);
      if (routeRef.current.thread === threadId && mine > threadReadApplied.current) {
        threadReadApplied.current = mine;
        threadLoaded.current = next.thread;
        wakeThreadRetry.current?.();
        setThread(next.thread);
        setThreadRow(next.row ?? null);
        setThreadLoad(null);
        // What is new since the last look, from the first read of this thread:
        // it lands before the window records the look, and is kept until the person leaves the thread.
        setLook((current) => (current?.threadId === threadId ? current : { threadId, seq: lookBoundary(next.thread), through: latestAgentSeq(next.thread) }));
      }
      return next.thread;
    } catch (cause) {
      if (routeRef.current.thread === threadId && mine > threadReadApplied.current) {
        const missing = cause instanceof InboxApiError && cause.status === 404;
        if (missing) setThread(null);
        setThreadLoad({ threadId, state: missing ? 'missing' : 'failed', error: cause instanceof Error ? cause.message : String(cause) });
      }
      return null;
    }
  }, [setThreadLoad]);

  const refreshSettings = useCallback(async () => {
    try {
      const next = await inboxApi.settings();
      adoptSavedTheme(next.theme);
      adoptSavedTextSize(next.text_size);
      adoptSavedDiffStyle(next.diff_style);
      setSettings(next);
      setSettingsReadFailed(false);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
      setSettingsReadFailed(true);
    }
  }, []);

  const refreshDrafts = useCallback(async () => {
    try {
      const next = await inboxApi.drafts();
      setDrafts(next.drafts);
      setReplyDrafts(next.replies ?? []);
      setDraftsError(null);
    } catch (cause) {
      setDraftsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);
  /**
   * The Board's cards (approval "inbox-board", step 2): read only while the
   * person has the Board on, once it is known to be on and again when a card
   * line arrives on the event stream, so the Board updates in place. With the
   * Board off nothing reads them (a card line on the stream is skipped too).
   */
  const [cards, setCards] = useState<CardsModel | null>(null);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const cardsSeq = useRef(0);
  /** Whether the Board is on (`boardEnabled` below), for the reads that run outside a render. */
  const boardOnRef = useRef(false);
  const refreshCards = useCallback(async (): Promise<CardsModel | null> => {
    if (!boardOnRef.current) return null;
    const mine = ++cardsSeq.current;
    try {
      const next = await inboxApi.cards();
      // An older read never replaces a newer one that landed first.
      if (mine === cardsSeq.current) {
        setCards(next);
        setCardsError(null);
      }
      return next;
    } catch (cause) {
      if (mine === cardsSeq.current) setCardsError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);
  /**
   * A visit to the Board: the person's look as it stood when the visit began
   * (cards an agent wrote to after it are bold for the whole visit, as a
   * thread keeps "New since you looked"), and the cards they opened or moved
   * since (no longer bold). Opening the Board records a new look through the
   * newest card it read, so the next visit is bold only for what came after.
   */
  const [boardVisit, setBoardVisit] = useState<{ look: number | null; handled: ReadonlySet<string> } | null>(null);
  /**
   * The Board is something the person turns on (config.json `inboxBoard`,
   * approval "inbox-board" 2026-10-26): null until the settings are read; an
   * Inbox that predates the switch always has it.
   */
  const boardEnabled = settings ? (settings.board ? settings.board.on : true) : null;
  boardOnRef.current = boardEnabled === true;
  useEffect(() => {
    if (boardEnabled !== true) {
      // Off (or not known yet): no card is read, and none kept from before it was turned off.
      cardsSeq.current++;
      setCards(null);
      return;
    }
    void refreshCards();
  }, [boardEnabled, refreshCards]);
  const onBoard = route.page === 'board' && boardEnabled === true;
  /**
   * The project the Board is filtered to (`#board&project=prj_…`). A project the Inbox does not
   * know (a stale or hand-edited link) is no filter once the projects have loaded; before that the
   * id filters as it stands, so a filtered link never flashes every card.
   */
  const boardFilter =
    route.page === 'board' && route.project && (latest === null || latest.projects.some((p) => p.id === route.project)) ? route.project : null;
  useEffect(() => {
    if (!onBoard) {
      setBoardVisit(null);
      return;
    }
    let live = true;
    void refreshCards().then((model) => {
      if (!live || !model) return;
      setBoardVisit({ look: model.seen_seq ?? null, handled: new Set() });
    });
    return () => {
      live = false;
    };
  }, [onBoard, refreshCards]);
  /**
   * The look is recorded once per visit, and only while the Board shows every project: a visit
   * filtered to one project never had the others' cards on screen, so their news stays bold (review
   * of #2284). A visit that starts filtered and then shows every project records it then, through
   * the latest read's cursor (every line up to it is on the page). An Inbox before step 2 has no
   * look to record (no `seen_seq`): nothing is bold beyond this visit there.
   */
  const lookRecorded = useRef(false);
  const boardShowsAll = onBoard && boardFilter === null;
  useEffect(() => {
    if (!boardVisit) {
      lookRecorded.current = false;
      return;
    }
    if (lookRecorded.current || !boardShowsAll || !cards || cards.seen_seq === undefined) return;
    lookRecorded.current = true;
    void inboxApi.seeBoard(cards.cursor).catch(() => {});
  }, [boardVisit, boardShowsAll, cards]);
  const handleCard = (id: string) =>
    setBoardVisit((visit) => (visit && !visit.handled.has(id) ? { ...visit, handled: new Set([...visit.handled, id]) } : visit));
  const moveCard = async (card: InboxCardWire, change: BoardMove): Promise<InboxCardWire | null> => {
    handleCard(card.id);
    try {
      const { card: moved } = await inboxApi.moveCard(card.id, change);
      setCards((model) => (model ? { ...model, cards: model.cards.map((c) => (c.id === moved.id ? moved : c)) } : model));
      void refreshCards();
      return moved;
    } catch {
      void refreshCards();
      return null;
    }
  };
  const seeDrops = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    void inboxApi
      .seeDrops(ids)
      .then(() => refreshCards())
      .catch(() => {});
  }, [refreshCards]);

  // The Drafts page follows each draft's session (live, ended) while it is open.
  useEffect(() => {
    if (route.page !== 'drafts') return;
    void refreshDrafts();
    const timer = setInterval(() => void refreshDrafts(), DRAFTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [route.page, refreshDrafts]);

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
    let draftsTimer: ReturnType<typeof setTimeout> | null = null;
    let pinsTimer: ReturnType<typeof setTimeout> | null = null;
    let runsTimer: ReturnType<typeof setTimeout> | null = null;
    let cardsTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Listen to the tabs' shared stream before the first read, so nothing passed on between the read and the subscription is lost (sharedEvents.ts).
    prepareInboxEvents();
    void (async () => {
      const first = await refreshList(true);
      void refreshSettings();
      if (cancelled || !first) {
        // No subscription follows (the effect ended, or the first read failed): close the early channel.
        discardPreparedInboxEvents();
        return;
      }
      // The threads already here: a later line of one of their roots is never a new thread (notify.ts).
      flushNotifications(first);
      unsubscribe = subscribeInboxEvents(first.cursor, {
        onRecord: (event) => {
          // A Board card (approval "inbox-board"): only the Board reads it; it never changes the list or a thread.
          if (event?.kind === 'card') {
            if (cardsTimer) clearTimeout(cardsTimer);
            cardsTimer = setTimeout(() => void refreshCards(), 60);
            return;
          }
          const now = routeRef.current;
          if (now.page === 'tour' && event?.kind === 'message' && event.first && event.message.author.kind === 'agent') {
            const threadId = event.message.thread_id;
            setTourArrivals((current) => ({ count: current.count + 1, thread: threadId }));
          }
          // The replay (steps 1 to 9) in front: the chip says it, nothing rings. Everywhere else, step 10
          // included (it sends the person to get their first question), and with the tab in the background,
          // notifications and the sound work as always, so nothing is ever passed over unseen.
          if (!(now.page === 'tour' && (now.step ?? 1) < TOUR_STEPS && tourPageInFront())) observeEvent(event);
          if (event?.kind === 'question') for (const listener of questionListeners.current) listener(event.question);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void refreshList(false).then((next) => next && flushNotifications(next));
            void refreshDecisions();
            const open = routeRef.current.thread;
            if (open) void refreshThread(open);
            // Picks and comments are unsent work too: the Drafts row follows them.
            void refreshDrafts();
          }, 80);
        },
        // A reply draft was saved or discarded (here or in another window): the rows' `unsent` and the Drafts row.
        // Its own timer: sharing the record timer let a draft save cancel a record's pending reads (the open thread's).
        onDrafts: (threadId) => {
          // The open thread's own copy of its draft follows at once (the foot's Send carries those words).
          if (threadId === routeRef.current.thread) setDraftChanged((n) => n + 1);
          if (draftsTimer) clearTimeout(draftsTimer);
          draftsTimer = setTimeout(() => {
            void refreshList(false);
            void refreshDrafts();
          }, 80);
        },
        // A session the Inbox runs changed (the ACP runner): its row ("Grok Build is working", a permission in
        // Stopped on you, with its notice) and the open thread's run line.
        onRuns: (change) => {
          if (routeRef.current.thread && change.thread_ids.includes(routeRef.current.thread)) setRunsTick((n) => n + 1);
          if (runsTimer) clearTimeout(runsTimer);
          runsTimer = setTimeout(() => void refreshList(false).then((next) => next && flushNotifications(next)), 120);
        },
        // The sidebar's pins changed (here, in another window, or a deleted thread left them): read `pins` again.
        onPins: () => {
          if (pinsTimer) clearTimeout(pinsTimer);
          pinsTimer = setTimeout(() => void refreshList(false), 60);
        },
        onStatus: (next, nextUpdated, nextRestart, nextAgents, nextFailing) => {
          setUpdate(next);
          if (nextUpdated !== undefined) setUpdated(nextUpdated);
          if (nextAgents !== undefined || nextRestart !== undefined) setRestartAgents(restartAgentsOf(nextAgents, nextRestart));
          if (nextFailing !== undefined) setCheckFailing(nextFailing);
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
      discardPreparedInboxEvents();
      unsubscribe();
      if (timer) clearTimeout(timer);
      if (deliveriesTimer) clearTimeout(deliveriesTimer);
      if (draftsTimer) clearTimeout(draftsTimer);
      if (cardsTimer) clearTimeout(cardsTimer);
      if (pinsTimer) clearTimeout(pinsTimer);
      if (runsTimer) clearTimeout(runsTimer);
    };
  }, [refreshList, refreshSettings, refreshThread, refreshDrafts, refreshCards, refreshDecisions, observeEvent, flushNotifications, setNotifyReach, windowReport, reportWindow]);

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
      setThreadLoad(null);
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    threadLoaded.current = null;
    // The thread's place, if it held focus, gives it to this thread's subject (ThreadWait's onFocusLeaving).
    focusThreadSubject.current = false;
    /** Another read (the event stream's) already put this thread on screen. */
    const landed = () => (threadLoaded.current?.thread_id === threadId ? threadLoaded.current : null);
    void (async () => {
      let opened: InboxThread | null = null;
      // A read that fails (or has no answer in THREAD_READ_TIMEOUT_MS) is read again (THREAD_READ_RETRY_MS)
      // while the thread stays open; a 404 is not.
      for (let attempt = 0; !opened; attempt++) {
        opened = (await refreshThread(threadId)) ?? landed();
        if (cancelled) return;
        if (opened) break;
        // Another thread opened meanwhile, or the server said this one is not there.
        if (routeRef.current.thread !== threadId || (threadLoadRef.current?.threadId === threadId && threadLoadRef.current.state === 'missing')) return;
        const waitMs = THREAD_READ_RETRY_MS[Math.min(attempt, THREAD_READ_RETRY_MS.length - 1)]!;
        await new Promise<void>((done) => {
          retry = setTimeout(done, waitMs);
          wakeThreadRetry.current = done;
        });
        retry = null;
        wakeThreadRetry.current = null;
        if (cancelled) return;
        opened = landed();
      }
      closing.current = null;
      // The thread opening settles as it now is too: an agent message the list
      // held there is the person's to read now, not news for "N new". Held,
      // its row kept the state the list showed (Quiet, say) and Back, which
      // settles nothing when every message is seen, left it there with its
      // questions open.
      if (listCovered() && COVERED_LIST_SETTLES === 'while-covered') settleList('own', false, { threadId });
      // The look covers what this read showed, not a message that lands before the server takes it.
      const look = (async () => {
        await inboxApi.seen(threadId, latestAgentSeq(opened)).catch(() => {});
        if (!cancelled) await refreshList(false);
      })();
      trackLook(threadId, look);
      await look;
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      wakeThreadRetry.current = null;
    };
  }, [route.thread, threadRetry, refreshThread, refreshList, settleList, trackLook]);
  // The thread landed while focus was in its place: focus goes to its subject, never to the page.
  useLayoutEffect(() => {
    if (!focusThreadSubject.current || !thread || thread.thread_id !== route.thread) return;
    focusThreadSubject.current = false;
    rootRef.current?.querySelector<HTMLElement>(`section.ib-pane[data-thread-id="${CSS.escape(thread.thread_id)}"] .ib-subject`)?.focus();
  }, [thread, route.thread]);

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
      // when a message arrived there that they did not see, or when it now
      // waits on them and is drawn in another group (an agent asked while it
      // was open): it takes the section its state gives it (held.ts
      // settlesOnBack, settleThread).
      closing.current = null;
      const next = latestRef.current?.sections.flatMap((section) => section.threads).find((row) => row.thread_id === closed);
      if (next && shownRef.current && settlesOnBack(shownRef.current, next)) {
        // Back put focus on the row; the settle redraws it in another group, so focus goes with it ([shown] layout effect):
        // after a key, and after a stacked window's Back by mouse (#1866 hands that focus to the row too); never after a phone's tap.
        if (lastInput === 'keyboard' || !isPhone()) refocusRow.current = closed;
        setShown((current) => (current ? settleThread(current, latestRef.current!.sections, closed) : current));
      }
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
  // While Settings shows, General's and About's version rows follow the update control as it moves
  // (available, installing, failed, checking failing), not only what they read when Settings opened.
  // Only when the key changes: opening Settings already reads them (the effect above).
  const updateKey = `${update?.state ?? ''}:${update?.version ?? ''}:${checkFailing?.since ?? ''}`;
  const seenUpdateKey = useRef(updateKey);
  useEffect(() => {
    if (seenUpdateKey.current === updateKey) return;
    seenUpdateKey.current = updateKey;
    if (route.page === 'settings') void loadUpdateDetails();
  }, [route.page, updateKey, loadUpdateDetails]);

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
  // The tour is never a place to come back to (every way out of it replaces its entry), so a tour step
  // is never recorded here or in whatsNewReturn: both keep the screen from before the tour.
  const settingsReturn = useRef('');
  if (route.page !== 'settings' && route.page !== 'tour') settingsReturn.current = hashOf(route);
  // What's new's "‹ Inbox" returns to the last Inbox screen (not Settings, not another What's new page):
  // the browser's Back when the page was opened from there (history.ts), a new entry otherwise.
  const whatsNewReturn = useRef('');
  if (route.page !== 'settings' && route.page !== 'whats-new' && route.page !== 'tour') whatsNewReturn.current = hashOf(route);

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
      // An open guided review closes first, back to its thread; then the Artifacts view, back to the messages
      // (approval "inbox-thread-artifacts": one more rung before Escape closes the thread).
      const now = routeRef.current;
      closeTo(now.guide ? { ...now, guide: null } : now.artifacts ? { ...now, artifacts: false } : { ...now, thread: null });
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
  // Not during the tour: one-time dialogs never open over it (they wait for its end).
  const soundDialogBlocked = updateDialog !== null || restarting || route.page === 'tour';
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
    agentsSettled && latest !== null && soundSettled && soundDialog === 'none' && updateDialog === null && !restarting && route.page !== 'settings' && route.page !== 'tour';
  useEffect(() => {
    if (!agentNoteReady || agentNoteDecided.current) return;
    let cancelled = false;
    const decide = () => {
      if (cancelled || agentNoteDecided.current || replyInProgress()) return false;
      agentNoteDecided.current = true;
      const model = agentsRef.current;
      const rows = model ? noteQuestionRows(model) : [];
      if (rows.length > 0 && model) setAgentNote({ rows, report: cardReport(model) });
      setAgentNoteSettled(true);
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
  // The notification lines (the ask, "tab slept") wait until this load's
  // one-time dialogs are decided (the sound claim settled, the note dialog
  // shown or not), so a dialog never opens over a line the person may be
  // pressing (Turn on would stack the browser's prompt on the dialog), and
  // stand down while one is open. After the agent-note dialog closes they come
  // back on the same load: the first question usually lands on the load that
  // showed the note dialog, and waiting for a reload meant it could never
  // notify. A load that showed the sound dialog keeps them for the next load:
  // that dialog already said what notifications need (and the note dialog is
  // never decided on that load).
  const askLinesFree = soundSettled && agentNoteSettled && soundDialog === 'none' && !agentNoteOpen;


  // The list on screen catches up as the route changes (the layout effect above), not here.
  const go = (next: Route) => writeRoute(next);
  /** Back to the screen under this one (closeTo): a thread's list, a file's thread. */
  const close = (next: Route) => closeTo(next);

  const openSearch = (opener?: HTMLElement | null) => {
    // Not over the tour’s replay (steps 1 to 9): search shows the person's own threads, which the tour keeps out of sight.
    if (routeRef.current.page === 'tour' && (routeRef.current.step ?? 1) < TOUR_STEPS) return;
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
          // Everything the draft kept: its typed thread name and the Board card it was started for (Create thread).
          .saveDraft(draft.id, {
            body: draft.body,
            to: draft.to,
            project: draft.project,
            files: draft.files.map((f) => f.upload_id),
            base: null,
            ...(draft.thread_name ? { thread_name: draft.thread_name } : {}),
            ...(draft.card ? { card: draft.card } : {}),
          })
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
    decideLanding.current = null;
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

  /**
   * Send now from a list row (approval "inbox-busy-agent-reply"): the reply
   * waiting on a busy agent goes into its running turn now, as the thread's
   * Send now does. No toast: the row's tick and badge say it.
   */
  const sendNowFromRow = async (row: InboxListRow) => {
    const id = row.delivery?.message_id;
    if (!id) return;
    try {
      await inboxApi.sendNow(id);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite();
    say('Sending it now.');
  };

  /**
   * Mark read, or move it back (the pressed button, `E` again, Undo). The
   * thread leaves the top for Quiet with its waiting questions closed; Undo
   * reopens them as they were. An agent stopped or held up on it makes the
   * toast a warning with Reply.
   */
  const markRead = async (threadId: string, read: boolean) => {
    // A look this tab sent and the server has not taken yet: decide on what it gives (a seen update held in New
    // moves locally), whether Mark read came before the look landed or after. Never longer than
    // MARK_READ_LOOK_WAIT_MS: a look that stalls leaves the thread New on the server, so Mark read writes.
    const looks = read ? looksInFlight.current.get(threadId) : undefined;
    if (looks) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(looks), new Promise<void>((done) => (timer = setTimeout(done, MARK_READ_LOOK_WAIT_MS)))]);
      clearTimeout(timer);
    }
    const before = rowOf(threadId);
    if (read && before) {
      const drawn = drawnSection(shownRef.current, threadId);
      if (seenHeldInNew(before, drawn)) return moveSeenToQuiet(threadId, before);
      // Once the look landed nothing waits here any more (the thread closed and the list settled, say).
      if (looks && !canToggleRead(before, drawn)) return;
    }
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
   * Mark read on a seen update the list still holds in New (markRead.ts
   * `seenHeldInNew`): the thread is already Quiet on the server, so nothing is
   * written; its row moves to Quiet now, sliding as the row's hover Mark read
   * does. Undo puts it back where it was drawn.
   */
  const moveSeenToQuiet = (threadId: string, row: InboxListRow) => {
    const before = shownRef.current;
    const sections = latestRef.current?.sections;
    if (!before || !sections) return;
    armSlide();
    setShown((current) => (current ? settleThread(current, sections, threadId) : current));
    // "Moved to Quiet · “<subject>”": the row has moved, wherever focus is.
    const { lead, detail } = markReadToast(row, 'list');
    showToast({
      lead,
      detail,
      icon: 'check',
      onUndo: () => {
        dismissToast();
        armSlide();
        setShown((current) => (current ? putRowBack(current, before, threadId) : current));
        say('Moved back.');
      },
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

  /**
   * An action item's Done or Can't do it (approval "inbox-action-items-in-reply"):
   * into the reply draft, like a pick, sent only with the person's Send. No
   * toast and no timer; `null` takes it back out of the draft. A note typed
   * under the marked row saves quietly. Resolves the message's action items as
   * saved, or null when it was refused.
   */
  const markAction = async (messageId: string, key: string, mark: ActionMark | null): Promise<InboxQuestion[] | null> => {
    let actions: InboxQuestion[];
    try {
      ({ actions } = await inboxApi.markAction(messageId, key, mark, true));
    } catch (cause) {
      // A note typed while the item was sent elsewhere or replaced: the thread redraws it as it is now.
      if (!isMootNoteRefusal(mark, cause)) showError(cause);
      await afterWrite();
      return null;
    }
    await afterWrite();
    if (!mark) say('Taken out of your draft.');
    else if (!mark.quiet) say(mark.outcome === 'done' ? 'Done. It goes with your reply.' : "Can't do it. It goes with your reply.");
    return actions;
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
   * Pin a thread to the sidebar, or unpin it (approval "inbox-pinned-threads"),
   * from the row menu, the thread header or the pinned row's menu. A pin is the
   * person's own write and moves no row. Pin says so in the live region only
   * (the row appears in Pinned); Unpin shows the toast "Unpinned · Still in
   * <section>" with Undo, which puts the pin back at its old place.
   */
  const setPin = async (row: Pick<InboxListRow, 'thread_id' | 'subject'>, pinned: boolean) => {
    // Unpin's Undo puts this one thread back where it was, with the time it was first pinned.
    const pinsNow = latestRef.current?.pins ?? [];
    const index = pinsNow.findIndex((pin) => pin.thread_id === row.thread_id);
    const pinnedAt = index >= 0 ? (pinsNow[index]!.pinned_at ?? null) : null;
    // Where it still is, from the pinned row (an archived thread has none in the list) or the list.
    const listed = (latestRef.current?.pins ?? []).find((pin) => pin.thread_id === row.thread_id) ?? rowOf(row.thread_id) ?? (threadRow?.thread_id === row.thread_id ? threadRow : null);
    try {
      await inboxApi.pin(row.thread_id, pinned);
    } catch (cause) {
      showError(cause);
      return;
    }
    await refreshList(false);
    const subject = row.subject ?? '(no subject)';
    if (pinned) {
      say(`Pinned “${subject}”`);
      return;
    }
    const canUndo = index >= 0 && pinnedAt !== null;
    showToast({
      icon: 'unpin',
      lead: 'Unpinned',
      detail: unpinnedWhere(listed),
      speech: `Unpinned “${subject}”. ${unpinnedWhere(listed)}.`,
      onUndo: canUndo ? () => void restorePin({ thread_id: row.thread_id, index, pinned_at: pinnedAt! }, subject) : undefined,
    });
  };
  /**
   * Unpin's Undo: that one thread pinned again at its old place with its
   * original `pinned_at`. Never a whole remembered order, which would bring
   * back a pin another tab removed meanwhile.
   */
  const restorePin = async (restore: { thread_id: string; index: number; pinned_at: string }, subject: string) => {
    try {
      await inboxApi.pinRestore(restore);
    } catch (cause) {
      showError(cause);
      return;
    }
    await refreshList(false);
    dismissToast();
    say(`Pinned “${subject}” again.`);
  };
  /** A pinned row's menu: Unpin, Move up, Move down, Copy link. */
  const pinAction = async (row: InboxListRow, action: PinnedAction) => {
    if (action === 'unpin') return void setPin(row, false);
    if (action === 'copy-link') return void rowAction(row, 'copy-link');
    const order = (latestRef.current?.pins ?? []).map((pin) => pin.thread_id);
    const next = movePin(order, row.thread_id, action === 'up' ? -1 : 1);
    if (next.every((id, i) => id === order[i])) return;
    try {
      await inboxApi.pinOrder(next);
    } catch (cause) {
      showError(cause);
      return;
    }
    await refreshList(false);
    say(action === 'up' ? 'Moved up.' : 'Moved down.');
  };
  /**
   * A pinned row opens its thread and leaves the list as it is (the project
   * filter and the sections), as a search result does; an archived thread
   * opens as a deep link to it does. The open thread's pinned row does nothing.
   */
  const openPinned = (row: InboxListRow) => {
    const now = routeRef.current;
    if (now.page === 'inbox' && now.thread === row.thread_id) return;
    go({ page: 'inbox', project: now.page === 'inbox' ? now.project : null, thread: row.thread_id });
  };

  /**
   * A thread row's right-click menu. Copy link and Copy thread ID say so in
   * the window's one toast; Mark read, Move back and Archive are the row's
   * hover action and the header's, with their toasts.
   */
  const rowAction = (row: InboxListRow, action: RowMenuAction) => {
    if (action === 'pin' || action === 'unpin') return void setPin(row, action === 'pin');
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
  const keysRef = useRef({ markRead, toast, thread, soundDialog, agentNoteOpen: false, feedbackOpen: false });
  keysRef.current = { markRead, toast, thread, soundDialog, agentNoteOpen: typeof agentNote === 'object', feedbackOpen };
  /**
   * What E or Z does now, or null when it stands down (the rules: guards.ts
   * for typing, composition and repeat; the rest is the thread's own).
   */
  const threadKeyAction = (event: KeyboardEvent, key: 'e' | 'z'): (() => void) | null => {
    if (event.defaultPrevented || isRepeatKey(event) || isComposingKey(event)) return null;
    if (keysRef.current.soundDialog === 'open' || keysRef.current.agentNoteOpen || keysRef.current.feedbackOpen || routeRef.current.guide) return null;
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
    // Never over the tour: its screens are a replay, and an undo would write to the Inbox underneath.
    if (key === 'z') return routeRef.current.page === 'tour' ? null : (current?.onUndo ?? null);
    if (routeRef.current.page !== 'inbox') return null;
    // A row the keyboard is on wins over the thread open beside the list; a
    // row that merely holds focus (clicked, or put there after a mouse close) does not.
    const rowEl = target?.closest('.ib-listcol [data-row]') ?? null;
    const rowId = rowEl && target && keyboardFocused(target) ? rowEl.getAttribute('data-row') : null;
    const threadId = rowId ?? (open && open.thread_id === routeRef.current.thread ? open.thread_id : null);
    if (!threadId) return null;
    const row = rowOf(threadId);
    if (!row || !canToggleRead(row, drawnSection(shownRef.current, threadId))) return null;
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
          // The person already chose to restart (asked first when a reply would be lost): no second question.
          leaveOnPurpose();
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
      if (!result.checked.ok) setSettingsError(`Couldn't check for updates: ${result.checked.error ?? 'the check failed'}.`);
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

  // Settings → Capabilities → Experimental: decision mode, saved to config.json and applied at once.
  // The Board's switch: saved to config.json; the page and the sidebar row follow at once, agents at their next session.
  const toggleBoard = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, board: { on: next } } : current));
    try {
      const saved = await inboxApi.saveBoard(next);
      setSettings((current) => (current ? { ...current, board: saved.board } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  const toggleExperimental = async (next: boolean) => {
    setSettingsError(null);
    setSettings((current) => (current ? { ...current, experimental: { decision_mode: { on: next, env: current.experimental?.decision_mode.env ?? null } } } : current));
    try {
      const saved = await inboxApi.saveExperimental({ decision_mode: next });
      setSettings((current) => (current ? { ...current, experimental: saved.experimental } : current));
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
  const latestRows = useMemo(() => new Map((latest?.sections ?? []).flatMap((section) => section.threads).map((row) => [row.thread_id, row] as const)), [latest]);
  // Decision mode is on only while settings say so; with it off, nothing of it renders and nothing is read.
  const decisionModeOn = settings?.experimental?.decision_mode.on === true;
  decisionModeOnRef.current = decisionModeOn;
  useEffect(() => {
    if (decisionModeOn) void refreshDecisions();
    else {
      setDecisions(null);
      setDecide(null);
    }
  }, [decisionModeOn, refreshDecisions]);
  /** A thread's "Decide these N": decision mode on, no sitting going, and two or more of its decisions waiting. */
  const decideInThread = (threadId: string) => {
    if (!decisionModeOn || !decisions || decide) return null;
    const count = threadDecisions(decisions, threadId).length;
    return decideEntryShown(count) ? { count, onDecide: () => openDecide(threadId) } : null;
  };
  /** The sitting's queue: its thread's decisions only. */
  const sittingDecisions = useMemo(() => (decisions && decide ? threadDecisions(decisions, decide.thread) : null), [decisions, decide?.thread]);
  const openDecide = (threadId: string) => {
    // Opened from the open-questions list, whose row goes with the list: focus comes back to its button.
    decideOpener.current = document.querySelector<HTMLElement>('section.ib-pane [data-open-questions]');
    const first = decisions ? threadDecisions(decisions, threadId)[0] : undefined;
    setDecide((current) => ({ thread: threadId, title: first ? (first.thread.subject ?? first.thread.thread_name) : null, tucked: false, start: null, startNonce: (current?.startNonce ?? 0) + 1 }));
    void refreshDecisions();
  };
  /** The sitting ended: focus back on what opened it, else on the thread's open-questions button. */
  const closeDecide = () => {
    setDecide(null);
    void refreshList(true);
    const opener = decideOpener.current;
    decideOpener.current = null;
    requestAnimationFrame(() => {
      const target = (opener?.isConnected ? opener : null) ?? document.querySelector<HTMLElement>('section.ib-pane [data-open-questions]');
      target?.focus({ preventScroll: true });
    });
  };
  // Pins (approval "inbox-pinned-threads"): an older Inbox sends no `pins`, so no Pinned section and no pin anywhere.
  const pinsOn = latest?.pins !== undefined;
  const pinRows = latest?.pins;
  const pinnedIds = useMemo(() => new Set((pinRows ?? []).map((pin) => pin.thread_id)), [pinRows]);
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
  // ── The onboarding tour (approval "inbox-onboarding-tour") ──────────────
  // A replay of a real thread from building Plannotator, drawn with the
  // window's own list, thread and question card over the tour's fixture
  // (tour/model.ts). Steps 1 to 9 never touch the person's store; step 10 is
  // their own first-run screen. The person's Inbox stays loaded underneath
  // and comes back as it was.
  const tourOn = route.page === 'tour';
  const reducedMotion = useReducedMotion();
  const [tourState, dispatchTourRaw] = useReducer(tourReducer, TOUR_START);
  const tourContent = useTourFixture(tourOn);
  const tourFixture = tourContent.fixture;
  /**
   * The tour's content cannot be had on this load (the fixture did not come, three tries): the tour is never
   * shown, and never an error (the owner: the tour is all positive). The entry screen and the first-run screen's
   * tour line stand down, so the first-run screen shows; Settings → Getting started keeps the tour for later.
   */
  const [tourUnavailable, setTourUnavailable] = useState(false);
  /**
   * The tour's first card (the owner, for 0.28.31: "a fresh reminder"): how the Inbox fits with your agents,
   * then Show me. Shown when the tour is started from a screen, over step 1; never on a reload or a link to a step.
   */
  const [tourIntro, setTourIntro] = useState(false);
  const tourReal = tourFixture?.threads.find((t) => t.id === TOUR_THREAD)?.real_answer ?? '';
  /** Raised when the person acted and the coach card changed: focus goes to its title. */
  const [coachFocus, setCoachFocus] = useState(0);
  const dispatchTour = useCallback((action: TourAction, options?: { focusCoach?: boolean }) => {
    dispatchTourRaw(action);
    if (options?.focusCoach) setCoachFocus((n) => n + 1);
  }, []);
  useTourReplay(tourState, dispatchTour, reducedMotion, say);
  const saveTour = (change: Parameters<typeof inboxApi.saveTour>[0]) => {
    // Kept here at once, so the entry screen leaves without waiting; the server's answer replaces it.
    const now = new Date().toISOString();
    setSettings((current) =>
      current?.tour
        ? {
            ...current,
            tour: {
              ...current.tour,
              seen_at: change.seen ? now : current.tour.seen_at,
              finished_at: change.finished ? now : current.tour.finished_at,
              skipped_at: change.skipped ? now : current.tour.skipped_at,
              notify_again: change.notify_again ?? current.tour.notify_again,
            },
          }
        : current,
    );
    // The server's answer replaces the local state, a stamp never going back to null: an earlier save's answer
    // that lands after a later one (seen, then skipped) never brings Two paths back.
    const adopt = (tour: InboxTourState) =>
      setSettings((current) => {
        if (!current) return current;
        const local = current.tour;
        return {
          ...current,
          tour: local
            ? { ...tour, seen_at: tour.seen_at ?? local.seen_at, finished_at: tour.finished_at ?? local.finished_at, skipped_at: tour.skipped_at ?? local.skipped_at }
            : tour,
        };
      });
    const decision = change.finished ? 'finished' : change.skipped ? 'skipped' : null;
    // A failed save is tried again (the server restarting, a busy moment); one the server refuses for good
    // (a 4xx) is not. A decision that still did not reach config.json is remembered in this browser and said,
    // quietly: the tour never pretends it was saved, and Two paths does not come back here.
    const attempt = (tries: number) => {
      void inboxApi.saveTour(change).then(
        ({ tour }) => adopt(tour),
        (cause: unknown) => {
          const status = cause instanceof InboxApiError ? cause.status : 0;
          if (tries < TOUR_SAVE_RETRY_MS.length && !(status >= 400 && status < 500)) {
            setTimeout(() => attempt(tries + 1), TOUR_SAVE_RETRY_MS[tries]);
            return;
          }
          if (!decision) return;
          storage.setItem(TOUR_DECIDED_COOKIE, decision);
          const why = cause instanceof Error ? cause.message : String(cause);
          showToast(
            {
              icon: 'warn',
              lead: 'Not saved',
              detail: 'This browser remembers the tour',
              speech: `The tour could not be saved: ${why} This browser remembers that you ${decision === 'finished' ? 'finished' : 'left'} it, so it will not offer itself again here.`,
            },
            6000,
          );
        },
      );
    };
    attempt(0);
  };
  // The step rides the address (`#tour=N`): a reload or a link opens that step with the walk's state up to it,
  // and each step the person reaches replaces the entry, so one Back leaves the tour.
  const tourSynced = useRef<number | null>(null);
  useEffect(() => {
    if (!tourOn || !tourFixture) return;
    const want = route.step ?? 1;
    if (want !== tourSynced.current) {
      tourSynced.current = want;
      if (want !== tourState.step) dispatchTourRaw({ type: 'goto', step: want, realAnswer: tourReal, fixture: tourFixture });
      return;
    }
    if (tourState.step !== want) {
      tourSynced.current = tourState.step;
      writeRoute({ page: 'tour', project: null, thread: null, step: tourState.step }, { replace: true });
    }
  }, [tourOn, tourFixture, route.step, tourState.step, tourReal]);
  /** The tour is ending through its own controls (Exit, Finish, the chip), not the browser's Back. */
  const tourEnding = useRef(false);
  /** The screen the tour was started from: Exit and Finish go back to it (the browser's Back when it is the entry under this one). */
  const tourReturn = useRef('');
  /** The tour was started from a screen of this page (Start, Take the tour); not set for a link or a reload. */
  const tourStartedHere = useRef(false);
  const tourWasOn = useRef(false);
  useEffect(() => {
    if (tourOn) {
      tourWasOn.current = true;
      // Reached by a link or a reload, not from a screen: no start point to go back to (never an earlier tour's).
      if (!tourStartedHere.current) tourReturn.current = '';
      // A toast from the Inbox underneath (its Undo writes there) never stays over the tour.
      dismissToast();
      return;
    }
    if (!tourWasOn.current) return;
    tourWasOn.current = false;
    // The tour ended: its start point is forgotten with it.
    tourReturn.current = '';
    tourStartedHere.current = false;
    // Left by the browser's Back (or anything else not through endTour): the same as Exit there, finished on
    // step 10 (the entry screen does not come back).
    if (!tourEnding.current) {
      saveTour(tourEndRecord(tourState.step === TOUR_STEPS));
      // The browser's Back took the tour's screen with the focus in it: focus lands on the Inbox, never the page.
      landFocusAfterTour();
    }
    tourEnding.current = false;
    tourSynced.current = null;
    setTourIntro(false);
    dispatchTourRaw({ type: 'goto', step: 1, realAnswer: tourReal });
    setTourArrivals({ count: 0, thread: null });
    // Notifications resume: the list the tour hid is read again, and what it brings is known, not news.
    void refreshList(false).then((next) => next && flushNotifications(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourOn]);
  const startTour = () => {
    // A toast's Undo (and Z) belongs to the Inbox under the tour: it never acts while the tour is up.
    dismissToast();
    tourReturn.current = routeRef.current.page === 'tour' ? '' : hashOf(routeRef.current);
    tourStartedHere.current = true;
    dispatchTourRaw({ type: 'goto', step: 1, realAnswer: tourReal });
    tourSynced.current = 1;
    setTourArrivals({ count: 0, thread: null });
    setCoachFocus((n) => n + 1);
    setTourIntro(true);
    saveTour({ seen: true });
    go({ page: 'tour', project: null, thread: null, step: 1 });
  };
  /** What ending the tour records: finished once the person reached step 10, skipped before. */
  const tourEndRecord = (finished: boolean): InboxTourChange =>
    finished
      ? { finished: true, notify_again: !(notifications.permission === 'granted' && settings?.notifications.enabled === true) }
      : { skipped: true };
  /**
   * Ends the tour: `kind` is what it records, `to` where it goes. A place named (the chip's thread, Settings, a
   * sidebar row on step 10) takes the tour's own entry. Without one it goes back to where the tour was started, as
   * the browser's Back when that is the entry under the tour's own; else (a link or a reload) to that place, again
   * in the tour's entry. Either way a later Back never reopens #tour=N.
   */
  const endTour = (kind: 'exit' | 'finish', to?: Route) => {
    tourEnding.current = true;
    saveTour(tourEndRecord(kind === 'finish'));
    if (to) writeRoute(to, { replace: true });
    else {
      const back = tourReturn.current;
      const state = window.history.state as { ibFrom?: unknown } | null;
      // Going back leaves the tour's entry ahead in history: marked, so Forward (or a reload of it) settles it
      // to where the tour went back to instead of reopening the tour (settleTourEntry).
      if (state && state.ibFrom === back) window.history.replaceState({ ...state, [TOUR_ENDED_STATE]: back }, '', window.location.href);
      if (!backTo(back)) writeRoute(routeOf(back), { replace: true });
    }
    showToast(
      kind === 'finish'
        ? { icon: 'check', lead: 'Tour finished', detail: 'Your Inbox is as you left it', speech: 'Tour finished. Your Inbox is as you left it.' }
        : { icon: 'check', lead: 'You left the tour', detail: 'Your Inbox is as it was', speech: 'You left the tour. Your Inbox is back as it was.' },
      4200,
    );
    landFocusAfterTour();
  };
  /**
   * Focus never drops to the page once the Inbox is back. The browser's Back lands, and the screen redraws, some
   * frames later on a slow machine; until the tour's own screen is gone the control that was pressed still holds
   * focus and is about to go, so nothing counts as landed before then. Tried for up to 3 s.
   */
  function landFocusAfterTour() {
    const until = performance.now() + 3000;
    let settled = 0;
    const land = () => {
      if (performance.now() > until) return;
      if (document.querySelector('[data-tour-bar]')) {
        requestAnimationFrame(land);
        return;
      }
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        // Back where it was started: its own Take the tour (Settings, What's new); else the thread, the first-run heading, the list.
        focusFirst(['[data-settings-take-tour]', '[data-whats-new-tour] button', 'section.ib-pane h2.ib-subject', '.ib-main .ib-empty h2', '.ib-main .ib-lbody [data-thread-id]', '.ib-main h1']);
      }
      const now = document.activeElement;
      // Landed: focus held over a few frames (a screen that is still drawing can take the element away again).
      settled = now && now !== document.body && now.isConnected ? settled + 1 : 0;
      if (settled < 5) requestAnimationFrame(land);
    };
    requestAnimationFrame(land);
  }
  // During the tour, focus that a control took with it (a screen redrawn by a step, a hash change, Try again)
  // lands on the tour's own place: the coach card, the loading screen, step 10's heading, else Exit. Only focus
  // that was LOST (the last focused element left the page): a click on empty space is left alone.
  useEffect(() => {
    if (!tourOn) return;
    let last: Element | null = document.activeElement;
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element) last = event.target;
    };
    const check = () => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (last && last.isConnected && last !== document.body) return;
      focusFirst(['[data-tour-viewer] [data-tour-viewer-close]', '[data-tour-intro] h2', '[data-tour-coach] h2', '[data-tour-loading] h2', '[data-tour-file-problem] h2', '.ib-main .ib-empty h2', '[data-tour-exit]']);
      last = document.activeElement;
    };
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('hashchange', check);
    const timer = setInterval(check, 250);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('hashchange', check);
      clearInterval(timer);
    };
  }, [tourOn]);
  /** What did not load in the tour (pictures, the mock): the coach says only what is on screen. */
  const [tourDegraded, setTourDegraded] = useState<TourDegraded>({});
  /** What is on screen in the tour that its state does not hold (a comment box open, a drawing, a moment pinned): the coach follows it. */
  const [tourUi, setTourUi] = useState<TourUi>({});
  const degradeTour = useCallback((change: TourDegraded) => setTourDegraded((current) => ({ ...current, ...change })), []);
  const tourIntroShown = tourOn && !!tourFixture && tourIntro && tourState.step === 1;
  useEffect(() => {
    if (tourOn && tourState.step !== 1) setTourIntro(false);
  }, [tourOn, tourState.step]);
  useEffect(() => {
    if (!tourIntroShown) return;
    say(`${TOUR_FIT_TITLE}. ${TOUR_FIT_LINES.join(' ')}`);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-tour-intro] h2')?.focus({ preventScroll: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourIntroShown]);
  /** Step 8's compose, opened from the tour's sidebar or list header: the real dialog over the tour's transport. */
  const tourComposeOpener = useRef<HTMLElement | null>(null);
  const openTourCompose = useCallback((opener: HTMLElement) => {
    tourComposeOpener.current = opener;
    dispatchTourRaw({ type: 'compose', open: true });
  }, []);
  const tourTransport = useMemo(() => (tourFixture ? tourComposeTransport(tourFixture, () => {}) : null), [tourFixture]);
  /**
   * The tour's answer to a click it cannot use (the owner, 2026-10-25: a card or button is never dead): one short
   * line on the coach card for a few seconds, said in the live region.
   */
  const [tourNudge, setTourNudge] = useState<string | null>(null);
  const tourNudgeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nudgeTour = useCallback(
    (text: string) => {
      setTourNudge(text);
      say(text);
      if (tourNudgeTimer.current) clearTimeout(tourNudgeTimer.current);
      tourNudgeTimer.current = setTimeout(() => setTourNudge(null), 4500);
    },
    [say],
  );
  useEffect(() => () => void (tourNudgeTimer.current && clearTimeout(tourNudgeTimer.current)), []);
  /** A Fast-forward just happened: the next card's announcement starts with it. */
  const tourForwarded = useRef(false);
  /** Fast-forward (the owner, 2026-10-25): the end of this step, said once. */
  const forwardTour = useCallback(() => {
    if (!tourFixture) return;
    setTourNudge(null);
    // Said with the card it lands on (the next announcement), never apart from it, which the card would cut off.
    tourForwarded.current = true;
    dispatchTour({ type: 'forward', realAnswer: tourReal, fixture: tourFixture }, { focusCoach: true });
  }, [tourFixture, tourReal, dispatchTour]);
  /** New message in the tour's sidebar: live on step 9 until its Send; before it the coach says when, after it where the thread is. */
  const openTourComposeOrNudge = useCallback(
    (opener: HTMLElement) => {
      if (tourState.step === TOUR_STEPS - 1 && tourState.compose === 'sent') nudgeTour('Your thread is started; it’s in the list.');
      else if (tourState.step === TOUR_STEPS - 1) openTourCompose(opener);
      else nudgeTour('New message comes later in the tour, at step 9.');
    },
    [tourState.step, tourState.compose, openTourCompose, nudgeTour],
  );
  const tourCoachCard =
    tourOn && tourFixture && tourState.step < TOUR_STEPS && !tourIntroShown
      ? tourCoach(tourState, { developer: tourFixture.developer, agent: 'Claude Code' }, tourDegraded, tourUi)
      : null;
  const tourCoachKey = tourCoachCard ? `${tourState.step}:${tourCoachCard.key}:${tourCoachCard.title}` : null;
  const lastTourCoach = useRef<string | null>(null);
  useEffect(() => {
    if (tourCoachKey === lastTourCoach.current) return;
    lastTourCoach.current = tourCoachKey;
    // A new card: the last one's answer to a click goes with it.
    setTourNudge(null);
    if (!tourCoachCard) return;
    // Each change is said once. The replay's own lines say Sending and Delivered; the second arrival leads the next card.
    const forwarded = tourForwarded.current ? 'Fast-forwarded. ' : '';
    tourForwarded.current = false;
    if (!tourCoachCard.wait) say(`${forwarded}${tourCoachSpeech(tourCoachCard, tourState.step)}`);
    else if (forwarded) say(forwarded.trim());
    // Focus never drops to the page: a card that changed under a control that went away takes it.
    requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body || !active.isConnected) setCoachFocus((n) => n + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourCoachKey]);
  // The last step (10) is real: Back in the tour bar has no step to go to, and Finish ends it.
  const tourRealStep = tourOn && tourState.step === TOUR_STEPS;
  /** A sidebar row: on step 10 (the real sidebar shows there) it ends the tour, finished, in the tour's own entry. */
  const leave = (to: Route) => (tourRealStep ? endTour('finish', to) : go(to));
  /** The last step’s notifications line: asked on the click only; hidden for the step by Not now (the first real thread asks once more). */
  const [tourAskHidden, setTourAskHidden] = useState(false);
  // The last step is the person’s own screen: its heading takes focus (the coach card is gone) and the change is said.
  const wasRealStep = useRef(false);
  useEffect(() => {
    if (tourRealStep && !wasRealStep.current) {
      // The tour's own toast (Sent to Claude Code) belongs to the replay: the person's own screen starts clean.
      dismissToast();
      say(`Step ${TOUR_STEPS} of ${TOUR_STEPS}: connect your agents. This is your own Inbox; what you connect here stays connected.`);
      requestAnimationFrame(() => requestAnimationFrame(() => focusFirst(['.ib-main .ib-empty h2'])));
    }
    if (!tourRealStep) setTourAskHidden(false);
    wasRealStep.current = tourRealStep;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourRealStep]);
  // The first real thread offers notifications once more, inline, when the tour ended without them (choice 6).
  // Like the ask above the list (askKind): never when notifications are off or the ask was dismissed.
  const notifyAgain = !tourOn && settings?.tour?.notify_again === true && notifications.ask !== null;
  const [notifyAgainThread, setNotifyAgainThread] = useState<string | null>(null);
  useEffect(() => {
    if (!notifyAgain) return;
    if (route.thread && notifyAgainThread === null) setNotifyAgainThread(route.thread);
    // Shown once: leaving the thread it showed in ends it.
    else if (notifyAgainThread !== null && route.thread !== notifyAgainThread) {
      setNotifyAgainThread(null);
      saveTour({ notify_again: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifyAgain, route.thread, notifyAgainThread]);
  // The first-run screen opens on the entry screen until the tour was started, finished or left (Two paths).
  const tourDecided =
    !!settings?.tour && (settings.tour.finished_at !== null || settings.tour.skipped_at !== null || storage.getItem(TOUR_DECIDED_COOKIE) !== null);
  // The first-run screen drew without the settings (their read failed or was late): it stays, and once the
  // settings come it gains its quiet "Take the tour" line rather than turning into the entry screen under the person.
  const firstRunDrawnBare = useRef(false);
  const showTourEntry = firstRun && !!settings?.tour && !tourDecided && !firstRunDrawnBare.current && !tourUnavailable;
  // The entry screen loads the tour while it shows, so Start is at once; content that cannot be had takes the
  // entry screen away before anyone presses Start (the first-run screen shows instead).
  useEffect(() => {
    if (!showTourEntry) return;
    let gone = false;
    void loadTour().then((fixture) => !gone && fixture === null && setTourUnavailable(true));
    return () => {
      gone = true;
    };
  }, [showTourEntry]);
  // Started, and the content cannot be had: the tour leaves without a word, back where it was started (the
  // first-run screen, Settings), recording nothing.
  useEffect(() => {
    if (!tourOn || !tourContent.unavailable) return;
    setTourUnavailable(true);
    tourEnding.current = true;
    writeRoute(routeOf(tourReturn.current), { replace: true });
    landFocusAfterTour();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourOn, tourContent.unavailable]);
  // While there are no settings, they are read again (1 s, then doubling to 15 s): one failed or hung read
  // never leaves the window without them. A read late by 1.5 s draws the first-run screen anyway.
  const settingsMissing = settings === null && latest !== null;
  useEffect(() => {
    if (!settingsMissing) return;
    let gone = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout>;
    const late = setTimeout(() => !gone && setSettingsLate(true), SETTINGS_LATE_MS);
    const again = () => {
      timer = setTimeout(async () => {
        if (gone) return;
        await refreshSettings();
        delay = Math.min(delay * 2, 15000);
        if (!gone) again();
      }, delay);
    };
    again();
    return () => {
      gone = true;
      clearTimeout(timer);
      clearTimeout(late);
    };
  }, [settingsMissing, refreshSettings]);

  // A file beside the thread takes the list's and the sidebar's room (record 2.2).
  const fileOpen = route.page === 'inbox' && !!route.thread && !!route.file;
  // A thread opened from a Board card (`#thread=…&card=crd_…`): it takes the list's place, led by
  // "‹ Board" and a chip naming the card; both go back to the opened card.
  const fromCard = route.page === 'inbox' && route.thread && route.card ? route.card : null;
  const backToCard = () => close({ page: 'board', project: route.boardProject ?? null, thread: null, board: route.board ?? 'lanes', card: fromCard });
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
  /** The row Back over a covered list focused (a key, or a stacked window's mouse Back), which its settle redraws in another group. */
  const refocusRow = useRef<string | null>(null);
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
    const refocus = refocusRow.current;
    refocusRow.current = null;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    const moved = body && refocus ? rowElement(body, refocus) : null;
    if (moved && lost) {
      moved.focus({ preventScroll: true });
    } else if (body && lost && shownAll) {
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

  // The last step’s notifications line (choice 6): asked on the click, in the screen's "Try it".
  const tourAskKind = tourRealStep && !tourAskHidden && !overTailnet && notifications.permission !== 'unsupported'
    ? notifications.permission === 'denied'
      ? 'blocked'
      : notifications.permission === 'granted' && settings?.notifications.enabled
        ? null
        : 'ask'
    : null;
  const firstRunScreen = (opts: { tour: boolean }) => (
    <EmptyState
      context={context}
      agents={agents}
      agentsUnavailable={overTailnet ? 'tailnet' : agentsSettled && agents === null ? 'failed' : null}
      onRetry={() => void refreshAgents()}
      sessions={firstRunSessions}
      onAgents={setAgents}
      onMessage={(session, opener) => openCompose({ session }, opener)}
      heading={opts.tour ? 'Now, let’s connect your agents' : undefined}
      lead={opts.tour ? 'Back in your own Inbox. Nothing from the tour was kept.' : undefined}
      onTakeTour={opts.tour || !settings?.tour || tourUnavailable ? undefined : startTour}
      tryPrompt={opts.tour ? TOUR_FIRST_QUESTION_PROMPT : undefined}
      ask={
        opts.tour ? (
          tourAskKind ? (
            <NotificationAsk
              kind={tourAskKind}
              firstRun
              soundOn={sound.settings.enabled}
              movedFrom={null}
              onTurnOn={() => void notifications.turnOn()}
              onNotNow={() => setTourAskHidden(true)}
              // The last step: Settings → General, where notifications are, and the tour counts as finished.
              onSettings={() => endTour('finish', { page: 'settings', project: null, thread: null, section: 'general' })}
            />
          ) : notifications.permission === 'granted' && settings?.notifications.enabled ? (
            <div className="ib-tour-notified" data-tour-notified="">
              <Icon name="check" size={15} />
              <span>Notifications are on for this address.</span>
              <button type="button" className="ib-btn ib-ghost ib-sm" onClick={() => notifications.sendTest()}>
                Send a test notification
              </button>
            </div>
          ) : null
        ) : // Not over the tailnet: that page is another device, and the first run is set up on this computer.
        notifications.firstRunAsk && askLinesFree && !overTailnet ? (
          <NotificationAsk
            kind={notifications.firstRunAsk}
            firstRun
            soundOn={sound.settings.enabled}
            movedFrom={settings?.notifications.allowed_origin ?? null}
            onTurnOn={() => void notifications.turnOn()}
            onNotNow={notifications.notNow}
            onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'general' })}
          />
        ) : null
      }
    />
  );

  let main: ReactNode;
  if (tourOn && !tourFixture) {
    main = <TourLoading />;
  } else if (tourOn && tourFixture && tourState.step < TOUR_STEPS) {
    main = (
      <TourMain
        fixture={tourFixture}
        state={tourState}
        dispatch={dispatchTour}
        phone={phone}
        stacked={stack}
        reduced={reducedMotion}
        say={say}
        onDegraded={degradeTour}
        onUi={setTourUi}
        onCompose={openTourComposeOrNudge}
        onNudge={nudgeTour}
      />
    );
  } else if (tourOn) {
    main = firstRunScreen({ tour: true });
  } else if (route.page === 'settings') {
    main = (
      <SettingsPage
        settings={settings}
        onTakeTour={settings?.tour ? startTour : undefined}
        context={context}
        error={settingsError}
        onToggleTool={toggleTool}
        onToggleExperimental={(next) => void toggleExperimental(next)}
        landOnExperimental={route.experimental === true}
        onToggleBoard={(next) => void toggleBoard(next)}
        agents={agents}
        onAgents={setAgents}
        onPrompts={(prompts) => setSettings((current) => (current ? { ...current, prompts } : current))}
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
        aboutDot={pageUpdate ? true : pageCheckFailing ? 'check-failing' : false}
        updateRow={
          settings && pageOffersUpdates(settings) ? (
            <GeneralUpdateRow
              version={latest?.version ?? settings.version ?? 'dev'}
              details={updateDetails}
              update={pageUpdate}
              restarting={restarting}
              checking={checking}
              failing={updateDetails?.check.failing ?? pageCheckFailing}
              onCheckNow={() => void checkNow()}
              onUpdate={pressUpdate}
              onWhatsNew={openWhatsNew}
            />
          ) : undefined
        }
        about={
          <AboutBlock
            version={latest?.version ?? settings?.version ?? 'dev'}
            details={updateDetails}
            switches={settings?.updates}
            checking={checking}
            error={null}
            onCheckNow={() => void checkNow()}
            onToggle={(change) => void saveUpdateSwitches(change)}
            update={pageUpdate}
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
        onTakeTour={
          settings?.tour && !tourUnavailable && settings.tour.seen_at === null && settings.tour.skipped_at === null && settings.tour.finished_at === null ? startTour : undefined
        }
      />
    );
  } else if (route.page === 'board' && boardEnabled === false) {
    // The Board is off: a #board link says so, with the one way to turn it on (nothing else of it shows).
    main = <BoardOff via={settings?.via ?? 'local'} onTurnOn={() => void toggleBoard(true)} error={settingsError} />;
  } else if (route.page === 'board' && boardEnabled === null) {
    main = <section className="ib-bpage" aria-busy="true" data-board-page="" />;
  } else if (route.page === 'board') {
    // The opened card's threads and a sent card's ticks read the list's rows (pins included).
    const rowById = new Map<string, InboxListRow>();
    for (const section of latestSections) for (const row of section.threads) rowById.set(row.thread_id, row);
    for (const row of latest?.pins ?? []) if (!rowById.has(row.thread_id)) rowById.set(row.thread_id, row);
    // The cards' own answer names threads the list leaves out (archived): the opened card still names them.
    for (const [id, row] of Object.entries(cards?.threads ?? {})) if (row && !rowById.has(id)) rowById.set(id, row);
    main = (
      <BoardPage
        view={route.board ?? 'lanes'}
        model={cards}
        error={cardsError}
        visitLook={boardVisit ? boardVisit.look : (cards?.seen_seq ?? null)}
        handled={boardVisit?.handled ?? EMPTY_SET}
        projects={projects}
        // The filtered project, else the project of the card heard from last, else the first.
        defaultProject={newCardProject(boardFilter, projects, cards?.cards ?? [])}
        home={settings?.home ?? null}
        mcpCommand={settings?.mcp_command ?? null}
        phone={phone}
        openCard={route.card ?? null}
        onOpenCard={(id) => {
          if (id) handleCard(id);
          const next: Route = { page: 'board', project: route.project, thread: null, board: route.board ?? 'lanes', card: id };
          // Another card replaces the open one's entry; opening the first and closing are entries of their own (a phone's Back closes it).
          if (id === null && route.card) close(next);
          else writeRoute(next, { replace: !!route.card && id !== null });
        }}
        rowOf={(threadId) => rowById.get(threadId) ?? null}
        onView={(next) => go({ page: 'board', project: route.project, thread: null, board: next })}
        project={boardFilter}
        // The filter is a place, like the list's project: each pick is a history entry, and Back undoes it.
        onProject={(project) => {
          // An opened card stays open while the Board still shows it.
          const open = route.card ? cards?.cards.find((c) => c.id === route.card) : undefined;
          go({ page: 'board', project, thread: null, board: route.board ?? 'lanes', card: open && (project === null || open.project_id === project) ? open.id : null });
        }}
        onMove={moveCard}
        onChanged={(card) => {
          if (card) {
            handleCard(card.id);
            setCards((model) => (model ? { ...model, cards: [card, ...model.cards.filter((c) => c.id !== card.id)] } : model));
          }
          void refreshCards();
          void refreshList(false);
        }}
        onSeeDrops={seeDrops}
        onOpenThread={(card, threadId) => go({ page: 'inbox', project: null, thread: threadId, card: card.id, board: route.board ?? 'lanes', boardProject: boardFilter })}
        onCreateThread={(card, session, opener) => openCompose({ session, card: { id: card.id, title: card.title } }, opener)}
        // The lane marks run this computer's gh / glab: never asked from a page opened over the tailnet.
        marks={settings !== null && settings.via !== 'tailnet'}
      />
    );
  } else if (route.page === 'drafts') {
    main = (
      <DraftsPage
        replies={replyDrafts}
        onOpenReply={(row) => go({ page: 'inbox', project: null, thread: row.thread_id })}
        drafts={drafts}
        error={draftsError}
        phone={phone}
        onOpen={(draft, opener) => openCompose({ draft }, opener)}
        onDelete={(draft) => void deleteDraft(draft)}
        onCompose={(opener) => openCompose({}, opener)}
      />
    );
  } else if (!latest || !shown) {
    main = <div className="ib-listcol">{loadError && <div className="ib-error" style={{ padding: 22 }}>{loadError}</div>}</div>;
  } else if (showTourEntry) {
    main = (
      <TourEntry
        model={tourEntryModel(agents, overTailnet ? 'tailnet' : agentsSettled && agents === null ? 'failed' : null, new Set(firstRunSessions?.projects.flatMap((g) => g.sessions.map((x) => x.host)) ?? []))}
        onStart={startTour}
        onConnect={() => {
          saveTour({ skipped: true });
          // The real first-run screen takes the place of the entry screen: focus goes to its heading.
          requestAnimationFrame(() => requestAnimationFrame(() => focusFirst(['.ib-main .ib-empty h2'])));
        }}
      />
    );
  } else if (firstRun && settings === null && !settingsReadFailed && !settingsLate) {
    // The settings say whether the entry screen shows: a moment's wait, never a flash of the wrong screen.
    main = <div className="ib-listcol" aria-busy="true" />;
  } else if (firstRun) {
    if (settings === null) firstRunDrawnBare.current = true;
    main = firstRunScreen({ tour: false });
  } else {
    main = (
      <>
        {!fileOpen && !fromCard && (
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
            // The first real thread's inline ask (the tour's, once) stands in for this line while it shows.
            notifications.ask && askLinesFree && !(notifyAgain && notifyAgainThread !== null) ? (
              <NotificationAsk
                kind={notifications.ask}
                soundOn={sound.settings.enabled}
                movedFrom={settings?.notifications.allowed_origin ?? null}
                onTurnOn={() => void notifications.turnOn()}
                onNotNow={notifications.notNow}
                onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'general' })}
              />
            ) : notifications.slept && notifications.permission === 'granted' && askLinesFree ? (
              <TabSleptLine slept={notifications.slept} onDismiss={notifications.dismissSlept} />
            ) : null
          }
          // The title refreshes the list it names, the thread beside it staying open (the list adopts, as Show does).
          onRefresh={() => void refreshInbox(route.project, false)}
          // A phone's pull down from the list's top does the same, its ↻ spinning until the read lands (pullRefresh.ts).
          onPullRefresh={() => refreshInbox(route.project, false)}
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
          onSendNow={(row) => void sendNowFromRow(row)}
          onRowAction={rowAction}
          pinned={pinsOn ? pinnedIds : undefined}
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
        {/* Beside the list, the thread's place says it is opening (or why not) until its read lands; a phone
            and a stacked window keep the list until there is a thread to show. */}
        {route.thread && !(thread && thread.thread_id === route.thread) && !phone && !stack.thread && (
          <ThreadWait
            key={route.thread}
            load={threadLoad?.threadId === route.thread ? threadLoad : null}
            onFocusLeaving={() => {
              focusThreadSubject.current = true;
            }}
            onRetry={() => setThreadRetry((n) => n + 1)}
            onClose={fromCard ? backToCard : () => close({ ...route, thread: null, file: null })}
          />
        )}
        {route.thread && thread && thread.thread_id === route.thread && (
          <ThreadPane
            notice={
              notifyAgain && notifyAgainThread === thread.thread_id ? (
                <div className="ib-tour-notify-again" data-tour-notify-again="">
                  <NotificationAsk
                    kind={notifications.ask!}
                    soundOn={sound.settings.enabled}
                    movedFrom={settings?.notifications.allowed_origin ?? null}
                    onTurnOn={() => {
                      saveTour({ notify_again: false });
                      void notifications.turnOn();
                    }}
                    onNotNow={() => saveTour({ notify_again: false })}
                    onSettings={() => go({ page: 'settings', project: null, thread: null, section: 'general' })}
                  />
                </div>
              ) : null
            }
            thread={thread}
            sent={openThreadRow?.sent ?? null}
            row={openThreadRow}
            drawn={drawnSection(shown, thread.thread_id)}
            onMarkRead={(read) => void markRead(thread.thread_id, read)}
            onAck={(messageId, on, agent) => void acknowledge(thread.thread_id, messageId, on, agent)}
            onAction={(messageId, key, mark) => markAction(messageId, key, mark)}
            onArchive={(next) => void archive(thread.thread_id, thread.messages[0]!.id, next)}
            pinned={pinnedIds.has(thread.thread_id)}
            onPin={pinsOn ? (next) => setPin(thread, next) : undefined}
            replyRequest={replyFor}
            draftChanged={draftChanged}
            runsVersion={runsTick}
            onReplyOpened={() => setReplyFor(null)}
            onQuestions={patchQuestions}
            onChanged={afterWrite}
            onClose={fromCard ? backToCard : () => close({ ...route, thread: null, file: null })}
            file={route.file ?? null}
            onOpenFile={(file, options) => {
              if (!file) return closeTo({ ...routeRef.current, file });
              // A call that names no view keeps the one in the address (the pane names it for a step, a version, a linked page).
              const keepView = file.view === undefined ? (routeRef.current.file?.view ?? null) : file.view;
              const next = { ...routeRef.current, file: { ...file, view: keepView } };
              /** Show `next` the way fullScreenOrigin.ts names (the history is the stack of frames). */
              const show = (request: { move?: FrameMove; replace?: boolean }) => {
                const op = fileEntryOp({ hash: currentHash(), state: window.history.state }, hashOf(next), request);
                if (op.kind === 'back') {
                  // Back onto the entry beside the thread; where asked, it then shows the file on screen now (a step inside full screen kept).
                  const land = op.land;
                  const landThere =
                    land === null
                      ? undefined
                      : () => {
                          if (currentHash() !== land && readRoute().thread === next.thread) writeRoute(next, { replace: true });
                        };
                  if (backBy(op.steps, window.history, landThere)) return;
                  return writeRoute(next, { replace: true, fullMark: null });
                }
                if (op.kind === 'replace') writeRoute(next, op.keep ? { replace: true } : { replace: true, fullMark: op.mark });
                else writeRoute(next, { fullMark: op.mark });
              };
              if (options?.back) {
                // A linked page's Back in a full screen the switch entered on that page: back past the switch's entry and the
                // page beside the thread, then full screen again with the switch, so × and Back still come back beside the thread.
                if (
                  pageBackPastSwitch({ hash: currentHash(), state: window.history.state }, hashOf(next), sameScreenAnyView) &&
                  backBy(2, window.history, () => {
                    if (readRoute().thread === next.thread) show({ move: 'switch-full' });
                  })
                ) {
                  return;
                }
                // Back through a linked page's stack: the browser's Back when this entry was opened from there,
                // whatever view that entry names (a pick swapped only the entry on screen); once it lands,
                // the view the person is in now replaces the one it named.
                const view = next.file.view;
                const viewThere = view
                  ? () => {
                      const now = readRoute();
                      if (now.file && now.file.view !== view) writeRoute({ ...now, file: { ...now.file, view } }, { replace: true });
                    }
                  : undefined;
                if (backTo(hashOf(next), window.history, sameScreenAnyView, viewThere)) return;
              }
              show({ move: options?.move, replace: options?.replace });
            }}
            fullFromSide={fullFromSide(window.history.state)}
            fullExitFile={fullExitFile(window.history.state)}
            onOpenGuide={(messageId) => go({ ...route, guide: messageId })}
            artifacts={route.artifacts === true}
            onArtifacts={(open) => (open ? go({ ...routeRef.current, artifacts: true, msg: null }) : close({ ...routeRef.current, artifacts: false }))}
            // Decision mode's one way in (thread only): from two of this thread's decisions up, and not while a
            // sitting is tucked into its pill (the pill's Resume is the way back to it).
            decide={decideInThread(thread.thread_id)}
            landing={
              route.msg && decideLanding.current?.messageId === route.msg
                ? { messageId: route.msg, terms: [], questionKey: decideLanding.current.questionKey, focus: 'prompt' }
                : route.msg
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
            covered={!!route.guide || updateDialog !== null || soundDialog === 'open' || agentNoteOpen || feedbackOpen || compose !== null}
            onScreenChange={(state) => {
              threadOnScreenRef.current = state;
            }}
            backLabel={fromCard ? 'Board' : (filterProject?.name ?? 'Inbox')}
            cardChip={fromCard ? <CardChip card={cards?.cards.find((c) => c.id === fromCard) ?? null} onOpen={backToCard} /> : undefined}
            phone={phone}
            stacked={stack.thread || !!fromCard}
            fileStacked={stack.file}
            remote={settings ? (settings.via ?? 'local') === 'tailnet' : null}
            onToast={(t) => showToast(t)}
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
      data-view={tourOn ? (tourFixture && tourState.step < TOUR_STEPS ? tourView(tourState) : 'list') : view}
      data-enter={tourOn ? undefined : (entered.current ?? undefined)}
      // The tour draws its stacked layouts itself (tour/Tour.tsx): the window's stacking rules stay out of it.
      data-stack={!tourOn && (stack.thread || stack.file) ? [stack.thread && 'thread', stack.file && 'file'].filter(Boolean).join(' ') : undefined}
      data-tour={tourOn ? String(tourState.step) : undefined}
    >
      {tourOn && (
        <TourBar
          step={tourFixture ? tourState.step : (route.step ?? 1)}
          phone={phone}
          arrivals={tourArrivals.count}
          onArrivals={() => endTour(tourRealStep ? 'finish' : 'exit', { page: 'inbox', project: null, thread: tourArrivals.thread })}
          onExit={() => endTour(tourRealStep ? 'finish' : 'exit')}
        />
      )}
      {/* A file beside the thread takes the sidebar's room (record 2.2): it closes on the same spring, and the person's choice stays as it was. */}
      <SidebarShell
        className="ib-shell"
        toggleNotice={sidebarToggleNotice}
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
          tourOn && !tourRealStep ? (
            <TourNavigation
              fixture={tourFixture}
              state={tourState}
              dispatch={dispatchTour}
              say={nudgeTour}
              onCompose={openTourComposeOrNudge}
              onSettings={() => endTour('exit', { page: 'settings', project: null, thread: null })}
            />
          ) : (
          <Sidebar
            page={route.page === 'tour' ? 'inbox' : fromCard ? 'board' : route.page}
            projectId={route.project}
            inboxCount={waitingCount(latestSections)}
            projects={projects}
            projectCounts={projectCounts}
            projectsReadable={projectsReadable}
            onProjectAction={(projectId, action) => void projectAction(projectId, action)}
            // Not on a page opened over the tailnet: the update routes answer 403 local_only there.
            update={pageUpdate}
            restarting={restarting}
            updated={updated}
            onSearch={(opener) => openSearch(opener)}
            onCompose={(opener) => openCompose({}, opener)}
            pins={pinRows}
            openThreadId={route.thread}
            onOpenPin={(row) => (tourRealStep ? endTour('finish', { page: 'inbox', project: null, thread: row.thread_id }) : openPinned(row))}
            onPinAction={(row, action) => void pinAction(row, action)}
            draftsCount={(drafts?.length ?? 0) + replyDrafts.length}
            onDrafts={() => leave({ page: 'drafts', project: null, thread: null })}
            // The Board (approval "inbox-board"): a row only while the person has it on; no count (the header has it).
            onBoard={boardEnabled ? () => leave({ page: 'board', project: null, thread: null }) : undefined}
            // On the list it shows, Inbox (or a project) refreshes; with a thread open it closes it as before, and refreshes.
            onInbox={() => (route.page === 'inbox' && route.project === null ? void refreshInbox(null, route.thread !== null) : leave({ page: 'inbox', project: null, thread: null }))}
            onProject={(projectId) =>
              route.page === 'inbox' && route.project === projectId ? void refreshInbox(projectId, route.thread !== null) : leave({ page: 'inbox', project: projectId, thread: null })
            }
            refreshes={route.page === 'inbox' && route.thread === null}
            refreshSpin={refreshSpin}
            onSettings={() => leave({ page: 'settings', project: null, thread: null })}
            onUpdate={pressUpdate}
            onWhatsNew={(version) => (tourRealStep ? endTour('finish', { page: 'whats-new', project: null, thread: null, version }) : openWhatsNew(version))}
            // Not on a page opened over the tailnet: Settings → Agents is local only there.
            restartAgents={settings && settings.via !== 'tailnet' ? restartAgents : NO_RESTART_AGENTS}
            checkFailing={pageCheckFailing}
            onCheckFailing={() => leave({ page: 'settings', project: null, thread: null, section: 'about' })}
            onRestartSessions={() => leave({ page: 'settings', project: null, thread: null, section: 'agents' })}
            mcpCommand={settings?.mcp_command ?? null}
            onFeedback={() => setFeedbackOpen(true)}
          />
          )
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
      {feedbackOpen && (
        <FeedbackDialog
          version={latest?.version ?? settings?.version ?? 'dev'}
          phone={phone}
          onSend={async (input) => {
            await inboxApi.sendFeedback(input);
          }}
          onCopyPrompt={(draft) => {
            // The copy starts inside the click (the clipboard needs it); the dialog closes so the toast is in view.
            const copied = copyTextToClipboard(feedbackPrompt(settings?.mcp_command ?? null, draft));
            setFeedbackOpen(false);
            void copied.then((ok) => showToast(feedbackCopiedToast(ok), ok ? 6000 : 4200));
          }}
          onClose={() => setFeedbackOpen(false)}
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
      {tourIntroShown && (
        <div className="ib-tour-layer">
          <TourIntro
            onGo={() => {
              setTourIntro(false);
              setCoachFocus((n) => n + 1);
            }}
          />
        </div>
      )}
      {tourOn && tourFixture && tourTransport && tourState.compose === 'open' && (
        <ComposeDialog
          request={{ body: tourComposeBody(tourFixture) }}
          phone={phone}
          current={{ id: TOUR_PROJECT_ID, root: '', name: tourFixture.project }}
          lastSent={null}
          home={null}
          transport={tourTransport}
          onSent={(sent) => {
            dispatchTour({ type: 'composeSend' }, { focusCoach: true });
            showToast(
              {
                icon: 'check',
                lead: `Sent to ${hostLabel(sent.host)}`,
                detail: `in ${sent.projectName}`,
                speech: `Sent to ${hostLabel(sent.host)} in ${sent.projectName}. It takes it as its next turn.`,
                action: {
                  label: 'Open',
                  onPress: () => {
                    dismissToast();
                    dispatchTour({ type: 'open', thread: sent.threadId }, { focusCoach: true });
                  },
                },
              },
              7000,
            );
          }}
          onSaved={() => {}}
          onDeleted={() => {}}
          onClose={() => {
            dispatchTourRaw({ type: 'compose', open: false });
            const opener = tourComposeOpener.current;
            requestAnimationFrame(() => (opener?.isConnected ? opener.focus() : setCoachFocus((n) => n + 1)));
          }}
          aside={
            <>
              {/* Compose is a modal dialog: the page under it, the tour bar included, is inert. Its own copy keeps Exit in reach. */}
              <TourBar
                over
                step={tourState.step}
                phone={phone}
                arrivals={tourArrivals.count}
                onArrivals={() => endTour('exit', { page: 'inbox', project: null, thread: tourArrivals.thread })}
                onExit={() => endTour('exit')}
              />
              {tourCoachCard ? (
                <div className="ib-tour-layer ib-tour-in-dialog">
                  <TourCoach
                    fixture={tourFixture}
                    coach={tourCoachCard}
                    step={tourState.step}
                    canBack={false}
                    phone={phone}
                    reduced={reducedMotion}
                    focusTick={0}
                    onBack={() => {}}
                    onNext={() => dispatchTour({ type: 'next' }, { focusCoach: true })}
                    canForward={tourCanForward(tourState, tourCoachCard)}
                    onForward={forwardTour}
                    nudge={tourNudge}
                  />
                </div>
              ) : null}
            </>
          }
        />
      )}
      {tourCoachCard && !(tourOn && tourState.compose === 'open') && (
        <div className="ib-tour-layer">
          <TourCoach
            fixture={tourFixture}
            coach={tourCoachCard}
            step={tourState.step}
            canBack={tourCanBack(tourState)}
            phone={phone}
            reduced={reducedMotion}
            focusTick={coachFocus}
            onBack={() => dispatchTour({ type: 'back' }, { focusCoach: true })}
            onNext={() => dispatchTour({ type: 'next' }, { focusCoach: true })}
            canForward={tourCanForward(tourState, tourCoachCard)}
            onForward={forwardTour}
            nudge={tourNudge}
          />
        </div>
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
          board={boardEnabled === true}
          onSent={(sent) => {
            rememberSent(sent.session);
            composeSent(sent);
            // Create thread from a Board card: the new thread is linked to the card, so its Open thread goes there.
            if (sent.cardId) {
              void inboxApi
                .editCard(sent.cardId, { op: 'link', thread_id: sent.threadId })
                .then(() => refreshCards())
                .catch(() => showToast({ icon: 'warn', lead: 'Sent, but not linked to the card', detail: 'Open the thread from the Inbox.' }, 7000));
            }
          }}
          onSaved={composeSaved}
          onDeleted={(draft) => {
            closeCompose(draftNeighbour(draft.id));
            void deleteDraft(draft, true);
          }}
          onClose={() => closeCompose()}
        />
      )}
      {decisionModeOn && decide && (
        <DecisionMode
          open={!decide.tucked}
          decisions={sittingDecisions}
          scope={decide.title}
          rows={latestRows}
          start={decide.start}
          startNonce={decide.startNonce}
          phone={phone}
          refresh={refreshDecisions}
          subscribeQuestions={subscribeQuestions}
          onLeft={setDecideLeft}
          onPaused={setDecidePaused}
          onTuck={(threadId, fileId, question) => {
            setDecide((current) => (current ? { ...current, tucked: true } : current));
            if (question && !fileId) {
              // A card's "Open the thread" (approval "inbox-decide-thread-only"): the dialog closes into its pill and
              // the thread (already behind it) lands on that question, its prompt focused. The same thread replaces
              // the entry, as a search result's landing does, so Back never stops on the same thread twice.
              decideLanding.current = { messageId: question.messageId, questionKey: question.key };
              searchLanding.current = null;
              const now = routeRef.current;
              const same = now.page === 'inbox' && now.thread === threadId && !now.file && !now.guide;
              writeRoute({ page: 'inbox', project: same ? now.project : null, thread: threadId, msg: question.messageId }, same ? { replace: true } : {});
              return;
            }
            writeRoute({ page: 'inbox', project: null, thread: threadId, file: fileId ? { id: fileId, version: 'current', focus: null } : null });
          }}
          onClose={closeDecide}
        />
      )}
      {decisionModeOn && decide?.tucked && <DecisionPill left={decideLeft} paused={decidePaused} thread={route.page === 'inbox' && route.thread === decide.thread ? null : decide.title} onResume={() => setDecide((current) => (current ? { ...current, tucked: false } : current))} />}
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
      <TooltipProvider delayDuration={TIP_DELAY_MS} skipDelayDuration={TOOLTIP_SKIP_DELAY_MS} disableHoverableContent>
        <Inbox />
      </TooltipProvider>
    </ThemeProvider>
  );
}
