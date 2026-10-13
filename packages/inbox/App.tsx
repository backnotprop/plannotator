/**
 * The Plannotator Inbox window (`plannotator inbox`), built to its design of
 * record (kept privately, not in this repo). A mail client for
 * what agents send: the list in the approved sections (a row is a thread),
 * the thread read as an email with Plannotator's question cards, pick then
 * Send, the project's decisions, and Settings.
 *
 * Routing is the URL hash (`#thread=msg_…`, `#project=prj_…`, `#settings`,
 * `#decisions=prj_…&decision=dec_…`), the same `#thread=` the MCP tools hand
 * agents.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { storage } from '@plannotator/ui/utils/storage';
import type { InboxDecision, InboxHealth, InboxListRow, InboxListSection, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import {
  InboxApiError,
  inboxApi,
  setPageSession,
  subscribeInboxEvents,
  type AgentToolHost,
  type DecisionsModel,
  type ListModel,
  type SettingsModel,
  type UpdateDetails,
  type WhatsNewModel,
} from './api';
import { filterSections, heldNotice, markHeldRowArchived, refreshHeldRows, settleOwn, settleThread, waitingCount, type OpenThread } from './held';
import {
  captureSettle,
  COVERED_LIST_SETTLES,
  listBody,
  playSettle,
  prefersReducedMotion,
  rowInSlot,
  SETTLE_AFTER_SIDEBAR_MS,
  SETTLE_BEAT_MS,
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
import { EmptyState } from './components/EmptyState';
import { AgentNoteDialog } from './components/AgentNoteDialog';
import { cardReport, noteQuestionRows } from './agents';
import type { InboxAgentRow, InboxAgentsModel, InboxConnectReport } from '@plannotator/core/inbox-types';
import { SettingsPage } from './components/Settings';
import { ArchivedBlock } from './components/Archived';
import { NotificationAsk } from './components/NotificationAsk';
import { useInboxNotifications } from './notify';
import { useInboxSound } from './sound';
import { notificationLine, SoundIntroDialog } from './components/SoundIntro';
import { DecisionsPage } from './components/Decisions';
import { GuidePane } from './components/GuidePane';
import { AboutBlock, FailedDialog, RestartDialog, UpdateDialog, WhatsNewPage } from './components/Updates';
import { unsentReply } from './unsent';
import { InboxToast, type InboxToastModel } from './components/Toast';
import { canToggleRead, MARK_READ_UNDO_MS, markReadToast } from './markRead';
import { lookBoundary } from './folding';
import { latestAgentSeq } from './seenOnSight';
import { isPhone, trackKeyboard, usePhone } from './phone';
import { LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, useStack } from './stack';
import { backTo, pushScreen } from './history';
import { adoptSavedTheme, inboxThemeSync } from './theme';
import { parseSettingsHash, settingsHash, type SettingsSection } from './settingsRoute';

// The Inbox has no /api/config and no browser-agent tools: settings stay in
// the page's own cookies, except the theme, which goes to config.json `theme`
// through the Inbox's settings route so plan review follows it (theme.ts).
// WebMCP is off.
// No image uploads and no skill catalog either: a comment's image would need
// an upload route the Inbox does not have, so the composer says so instead of
// posting nowhere.
configurePlannotatorUI({
  serverSync: inboxThemeSync,
  // Images in a message load from the Inbox's per-message route (#1813).
  imageSrcResolver: inboxImageSrcResolver,
  webmcp: { enabled: false, namePrefix: 'plannotator.' },
  // Skill references in comments read the host's skills; the Inbox has none to offer.
  skillCatalogTransport: async () => [],
  uploadTransport: {
    upload: async () => {
      throw new Error('Images cannot be added to a comment in the Inbox.');
    },
  },
});

const SIDEBAR_OPEN_COOKIE = 'plannotator-inbox-sidebar-open';
/** A look seen on sight that the server did not take is sent again this many times, 1 s, 2 s, 4 s… apart. */
const SEEN_RETRIES = 5;
const SEEN_RETRY_MS = 1000;

interface Route {
  page: 'inbox' | 'settings' | 'decisions' | 'whats-new';
  /** The release whose notes the What's new page shows (`#whats-new=0.28.12`). */
  version?: string | null;
  project: string | null;
  thread: string | null;
  /** The decision open beside the Decisions list. */
  decision?: string | null;
  /** An attachment open beside the thread: `file=att_…`, `v=sent` for the version the agent sent, `at=` an annotation to show. */
  file?: { id: string; version: 'current' | 'sent'; focus: string | null } | null;
  /** The message whose guided review is open over the window (`#thread=…&guide=msg_…`). */
  guide?: string | null;
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
  if (params.has('decisions')) {
    return { page: 'decisions', project: params.get('decisions') || null, thread: null, decision: params.get('decision') };
  }
  const thread = params.get('thread');
  const fileId = thread ? params.get('file') : null;
  return {
    page: 'inbox',
    project: params.get('project'),
    thread,
    file: fileId ? { id: fileId, version: params.get('v') === 'sent' ? 'sent' : 'current', focus: params.get('at') } : null,
    guide: thread ? params.get('guide') : null,
  };
}

/** The route's hash, `#thread=…` (empty for the list at rest). */
function hashOf(route: Route): string {
  let hash = '';
  if (route.page === 'settings') hash = settingsHash({ section: route.section ?? null, pair: route.pair });
  else if (route.page === 'whats-new') hash = new URLSearchParams({ 'whats-new': route.version ?? '' }).toString();
  else if (route.page === 'decisions') {
    const params = new URLSearchParams();
    params.set('decisions', route.project ?? '');
    if (route.decision) params.set('decision', route.decision);
    hash = params.toString();
  } else {
    const params = new URLSearchParams();
    if (route.project) params.set('project', route.project);
    if (route.thread) params.set('thread', route.thread);
    if (route.thread && route.file) {
      params.set('file', route.file.id);
      if (route.file.version === 'sent') params.set('v', 'sent');
      if (route.file.focus) params.set('at', route.file.focus);
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
 * kept in step by the window. Closing a covering thread back to the list, or a
 * covering decision back to the Decisions list, is then the browser's Back, as
 * on a phone, so an iPad's swipe back and `‹ Inbox` / `‹ Decisions` agree.
 * Every other close, and every close beside the list, stays a new entry, as on
 * a desktop.
 */
const covering = { thread: false, decision: false };

function leavesCoveringPane(route: Route): boolean {
  const from = readRoute();
  if (covering.thread && route.page === 'inbox' && !route.thread) {
    return from.page === 'inbox' && !!from.thread && !from.file && !from.guide;
  }
  if (covering.decision && route.page === 'decisions' && !route.decision) {
    return from.page === 'decisions' && !!from.decision;
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
  /** The list on screen: held until the person acts (the "N new" notice). */
  const [shown, setShown] = useState<InboxListSection[] | null>(null);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [threadDecisions, setThreadDecisions] = useState<InboxDecision[]>([]);
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
  const [decisions, setDecisions] = useState<DecisionsModel | null>(null);
  const [decisionsError, setDecisionsError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsModel | null>(null);
  /** The agents on this computer (GET /api/inbox/agents): the agent-note dialog and Settings → Agents. Null on an older Inbox. */
  const [agents, setAgents] = useState<InboxAgentsModel | null>(null);
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
  /** The one toast (Mark read, Archive) with its Undo, and what the live region last said. */
  const [toast, setToast] = useState<InboxToastModel | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [said, setSaid] = useState('');
  /** The thread whose reply box opens once it is on screen (the warning toast's Reply). */
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const notifications = useInboxNotifications({
    settings: settings?.notifications ?? null,
    // New questions ring the doorbell on their own rules (sound.ts), whatever notifications say.
    onQuestions: sound.questionsArrived,
    // Silent only when the bell can ring: on, and armed by a click in this tab.
    silent: () => sound.settings.enabled && sound.armed,
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
  const { observe: observeEvent, flush: flushNotifications } = notifications;

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
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
  const refreshList = useCallback(async (adopt: boolean, slide = false) => {
    try {
      const next = await inboxApi.list();
      setPageSession(next.serverSession);
      setLatest(next);
      if (adopt && slide) armSlide();
      setUpdate(next.update);
      setUpdated(next.updated ?? null);
      // Held: the order waits for an action, but each row's own state (a delivery, an agent's read) follows at once.
      setShown((current) => (adopt || current === null || !hasRows(current) ? next.sections : refreshHeldRows(current, next.sections, heldOpen())));
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
        setThreadDecisions(next.decisions);
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

  /** The Decisions page's project: the route's, else the one with the newest activity. */
  const decisionsProjectOf = useCallback((route: Route, model: ListModel | null): string | null => {
    if (route.project) return route.project;
    const rows = (model?.sections ?? []).flatMap((s) => s.threads).sort((a, b) => b.last_at.localeCompare(a.last_at));
    return rows[0]?.project.id ?? model?.projects[0]?.id ?? null;
  }, []);

  const refreshDecisions = useCallback(async (projectId: string | null) => {
    if (!projectId) return;
    try {
      const next = await inboxApi.decisions(projectId);
      setDecisions(next);
      setDecisionsError(null);
    } catch (cause) {
      setDecisionsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const next = await inboxApi.settings();
      adoptSavedTheme(next.theme);
      setSettings(next);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  /** Read the agents; while `plannotator inbox` is still connecting them, read again until it is done. */
  const refreshAgents = useCallback(async () => {
    try {
      const next = await inboxApi.agents();
      setAgents(next);
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
  useEffect(() => {
    if (agentsSection) void refreshAgents();
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
    let cancelled = false;
    void (async () => {
      const first = await refreshList(true);
      void refreshSettings();
      if (cancelled || !first) return;
      unsubscribe = subscribeInboxEvents(first.cursor, {
        onRecord: (event) => {
          observeEvent(event);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void refreshList(false).then((next) => next && flushNotifications(next));
            const open = routeRef.current.thread;
            if (open) void refreshThread(open);
            if (routeRef.current.page === 'decisions') void refreshDecisions(decisionsProjectOf(routeRef.current, latestRef.current));
          }, 80);
        },
        onStatus: (next) => setUpdate(next),
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [refreshList, refreshSettings, refreshThread, observeEvent, flushNotifications, refreshDecisions, decisionsProjectOf]);

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

  // Settings is a focused page (design of record inbox-settings-tabs): the sidebar slides away while it
  // is open and comes back on leaving, without writing the person's stored choice. ⌘B there opens it
  // for this visit only.
  const [settingsSidebar, setSettingsSidebar] = useState(false);
  useEffect(() => {
    if (route.page !== 'settings') setSettingsSidebar(false);
  }, [route.page]);

  const decisionsProject = route.page === 'decisions' ? decisionsProjectOf(route, latest) : null;
  useEffect(() => {
    if (decisionsProject) void refreshDecisions(decisionsProject);
  }, [decisionsProject, refreshDecisions]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An open file owns Escape (the HTML viewer's ladder, the composers).
      if (event.key !== 'Escape' || !routeRef.current.thread || routeRef.current.file) return;
      // Something inside the thread already used this Escape (the reply's choice at Send goes back to the reply).
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
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

  // A phone shows one screen at a time (phone.ts, inbox.css), and its keyboard shrinks the window.
  const phone = usePhone();
  useEffect(() => (phone ? trackKeyboard() : undefined), [phone]);
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
      if (root.getBoundingClientRect().width - sidebar >= LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH) setSidebarHeld(false);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [sidebarHeld, route]);
  useLayoutEffect(() => {
    covering.thread = stack.thread;
    covering.decision = stack.decision;
  }, [stack.thread, stack.decision]);

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
  const dismissToast = useCallback(() => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = null;
    setToast(null);
  }, []);
  /** The window's one toast: a new one replaces the last, so two never stack. */
  const showToast = (next: Omit<InboxToastModel, 'id'>, ms = MARK_READ_UNDO_MS) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ ...next, id: Date.now() });
    say(next.text);
    toastTimer.current = setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, ms);
  };
  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  /**
   * Mark read, or move it back (the pressed button, `E` again, Undo). The
   * thread leaves the top for Quiet with its waiting questions closed; Undo
   * reopens them as they were. An agent stopped or held up on it makes the
   * toast a warning with Reply.
   */
  const markRead = async (threadId: string, read: boolean) => {
    const before = rowOf(threadId);
    // With a thread open the list holds still: the row moves to Quiet when the list next settles.
    const deferred = routeRef.current.thread !== null;
    try {
      await inboxApi.markRead(threadId, read);
    } catch (cause) {
      showToast({ text: cause instanceof Error ? cause.message : 'The thread did not change.', warn: true });
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
    const closed = before.questions.open + before.questions.picked;
    const copy = markReadToast(before, closed, deferred);
    showToast({
      ...copy,
      onUndo: () => void markRead(threadId, false),
      ...(copy.warn
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
    // The toast's own words (Quiet or Archived, moved or still to move).
    say(copy.text);
  };

  /** Archive (the MCP's resolve) or Unarchive, with Undo. */
  const archive = async (threadId: string, rootId: string, next: boolean) => {
    try {
      await inboxApi.resolve(rootId, next);
    } catch (cause) {
      showToast({ text: cause instanceof Error ? cause.message : 'The thread did not change.', warn: true });
      return;
    }
    // The list leaves archived threads out (Settings lists them). While the
    // thread is open its row stays where it is, shown archived; it goes when
    // the person leaves the thread.
    if (next && routeRef.current.thread === threadId) {
      const at = new Date().toISOString();
      setShown((current) => (current ? markHeldRowArchived(current, threadId, at) : current));
    }
    await afterWrite();
    if (next) {
      showToast({ text: 'Archived. The next message starts a new thread.', short: 'Archived.', onUndo: () => void archive(threadId, rootId, false) });
      say('Archived.');
    } else {
      dismissToast();
      say('Unarchived.');
    }
  };

  /**
   * Settings' Unarchive: the thread goes back to the list, in whatever
   * section its state puts it, and opens there (owner ruling 2026-10-12).
   */
  const unarchiveFromSettings = async (row: InboxListRow): Promise<boolean> => {
    try {
      await inboxApi.resolve(row.thread_id, false);
    } catch (cause) {
      showToast({ text: cause instanceof Error ? cause.message : 'The thread did not change.', warn: true });
      return false;
    }
    go({ page: 'inbox', project: null, thread: row.thread_id });
    await refreshList(true);
    const subject = row.subject ?? 'The thread';
    showToast({
      text: `Moved back to your Inbox: “${subject}”.`,
      short: 'Unarchived.',
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.repeat) return;
      const key = event.key.toLowerCase();
      if (key !== 'e' && key !== 'z') return;
      if (keysRef.current.soundDialog === 'open' || keysRef.current.agentNoteOpen || routeRef.current.guide) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target) {
        if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
        if (target.tagName === 'INPUT' && !['radio', 'checkbox'].includes((target as HTMLInputElement).type)) return;
        if (target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], iframe, .ib-view, [data-step-guard]')) return;
      }
      // With a file open beside the thread, only a key aimed at the thread or the list counts.
      if (routeRef.current.file && !target?.closest('section.ib-pane, .ib-listcol')) return;
      const { markRead: toggle, toast: current, thread: open } = keysRef.current;
      if (key === 'z') {
        if (!current?.onUndo) return;
        event.preventDefault();
        current.onUndo();
        return;
      }
      if (routeRef.current.page !== 'inbox') return;
      // A row the keyboard is on wins over the thread open beside the list; a
      // row that merely holds focus (clicked, or put there after a mouse close) does not.
      const rowEl = target?.closest('.ib-listcol [data-row]') ?? null;
      const rowId = rowEl && target && keyboardFocused(target) ? rowEl.getAttribute('data-row') : null;
      const threadId = rowId ?? (open && open.thread_id === routeRef.current.thread ? open.thread_id : null);
      if (!threadId) return;
      const row = rowOf(threadId);
      if (!row || !canToggleRead(row)) return;
      event.preventDefault();
      void toggle(threadId, !(row.read_at ?? null));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // rowOf reads a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setWhatsNew(null);
    setWhatsNewError(null);
    inboxApi
      .whatsNew(whatsNewVersion)
      .then((model) => !cancelled && setWhatsNew(model))
      .catch((cause) => !cancelled && setWhatsNewError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      cancelled = true;
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
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) counts.set(project.id, waitingCount(latestSections, project.id));
    return counts;
  }, [projects, latestSections]);
  // The Decisions switch's counts: every project's, from the last Decisions read of any project,
  // so they stay on screen while another project's decisions load.
  const decisionCounts = useMemo(() => {
    const list = decisions?.project_counts;
    return list ? new Map(list.map((c) => [c.project_id, c])) : null;
  }, [decisions]);

  const context: ConnectContext | null = settings
    ? { command: settings.mcp_command, mcpUrl: settings.mcp_url, platform: platformOf() }
    : null;

  const retireDecision = async (decision: InboxDecision) => {
    await inboxApi.retireDecision(decision.id, decision.version);
    await refreshDecisions(decision.project_id);
  };

  const replaceDecision = async (decision: InboxDecision, text: string, reason: string) => {
    const result = await inboxApi.replaceDecision(decision.id, { version: decision.version, text, reason });
    await refreshDecisions(decision.project_id);
    go({ page: 'decisions', project: decision.project_id, thread: null, decision: result.decision.id });
  };

  const filterProject = route.page === 'inbox' && route.project ? projects.find((p) => p.id === route.project) ?? null : null;
  const notice = shown && latest ? heldNotice(filterSections(shown, route.project), filterSections(latest.sections, route.project), openedHere.current, heldOpen()).text : null;
  const firstRun = latest !== null && projects.length === 0;
  // A file beside the thread takes the list's and the sidebar's room (record 2.2).
  const fileOpen = route.page === 'inbox' && !!route.thread && !!route.file;
  const guideMessage =
    route.guide && thread && thread.thread_id === route.thread ? (thread.messages.find((m) => m.id === route.guide && m.guide) ?? null) : null;
  // The screen on top, which a phone shows alone (inbox.css): the list, a thread, a file, a decision.
  // A thread is on top once it has loaded, so a phone keeps the list until there is a thread to show.
  const view =
    route.page === 'inbox'
      ? fileOpen
        ? 'file'
        : route.thread && thread?.thread_id === route.thread
          ? 'thread'
          : 'list'
      : route.page === 'decisions' && route.decision
        ? 'decision'
        : route.page;
  // A screen pushed over a shallower one slides in on a phone (inbox.css `data-enter`); one uncovered by
  // closing what was over it (a file back to its thread) does not slide again.
  const viewDepth = (v: string) => (v === 'file' ? 2 : v === 'thread' || v === 'decision' ? 1 : 0);
  const lastView = useRef(view);
  const entered = useRef<string | null>(null);
  if (lastView.current !== view) {
    entered.current = viewDepth(view) > viewDepth(lastView.current) ? view : null;
    lastView.current = view;
  }

  // A thread or a decision that covers its list (stack.ts) takes the focus with it, and gives it back to
  // its row: the list is hidden under it, so focus left on the row clicked (or on the pane's Back) would
  // sit on something nobody can see.
  // The list row that last had focus, and the one to return to on Back (see the resize effect below).
  const listFocus = useRef<string | null>(null);
  const returnRow = useRef<string | null>(null);
  // The same for the Decisions list's rows.
  const decisionFocus = useRef<string | null>(null);
  const returnDecision = useRef<string | null>(null);
  const focusFrom = useRef<{ view: string; thread: string | null; decision: string | null }>({ view, thread: null, decision: null });
  // `‹ Inbox` in the thread's header with a file beside it: the thread whose row takes focus once the file
  // has closed and the list is back (the list is not drawn while the file is open, so it waits for the view).
  const backFromFile = useRef<{ thread: string; name: string | null; label: string } | null>(null);
  useEffect(() => {
    const before = focusFrom.current;
    focusFrom.current = { view, thread: view === 'thread' ? route.thread : null, decision: view === 'decision' ? (route.decision ?? null) : null };
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
    } else if (stack.decision && view === 'decision' && before.view === 'decisions') {
      focusFirst(['section.ib-dpane [data-stack-back]']);
    } else if (stack.decision && view === 'decisions' && before.view === 'decision' && before.decision) {
      const row = returnDecision.current ?? before.decision;
      returnDecision.current = null;
      focusFirst([`.ib-dpage [data-decision-id="${CSS.escape(row)}"]`, `.ib-dpage [data-decision-id="${CSS.escape(before.decision)}"]`]);
    }
  }, [view, route.thread, route.decision, stack.thread, stack.decision, phone]);

  // The window resized across the stacking width with a thread or a decision open. Into it: a list row that
  // had focus is now hidden under the pane (and redrawn), so focus would drop to the page; it goes to the
  // pane's `‹ Inbox` / `‹ Decisions` instead, and Back returns it to that row. Out of it: the pane's Back is
  // gone, so focus goes to the row the person came from, now beside the pane.
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      // A row, or its hover action beside it (`.ib-rw[data-row]`).
      const row = target?.closest?.('.ib-listcol [data-thread-id], .ib-listcol [data-row]');
      listFocus.current = row ? (row.getAttribute('data-thread-id') ?? row.getAttribute('data-row')) : null;
      const decisionRow = target?.closest?.('.ib-dpage [data-decision-id]');
      decisionFocus.current = decisionRow ? decisionRow.getAttribute('data-decision-id') : null;
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
  const stackedBefore = useRef({ thread: stack.thread, decision: stack.decision });
  useEffect(() => {
    const was = stackedBefore.current;
    stackedBefore.current = { thread: stack.thread, decision: stack.decision };
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
    } else if (view === 'decision' && was.decision !== stack.decision) {
      if (stack.decision) {
        if (decisionFocus.current && (lost || active?.closest('.ib-dpage'))) {
          returnDecision.current = decisionFocus.current;
          focusFirst(['section.ib-dpane [data-stack-back]']);
        }
      } else if (lost) {
        const row = returnDecision.current ?? route.decision ?? null;
        returnDecision.current = null;
        if (row) focusFirst([`.ib-dpage [data-decision-id="${CSS.escape(row)}"]`]);
      }
    }
  }, [stack.thread, stack.decision, view, route.thread, route.decision, phone]);

  let main: ReactNode;
  const decisionsFolder = decisionsProject ? projects.find((p) => p.id === decisionsProject) ?? null : null;
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
        onBack={() => go({ page: 'inbox', project: null, thread: null })}
        onUpdate={pressUpdate}
      />
    );
  } else if (route.page === 'decisions' && decisionsFolder) {
    main = (
      <DecisionsPage
        projects={projects}
        project={decisionsFolder}
        model={decisions && decisions.project_id === decisionsFolder.id ? decisions : null}
        error={decisionsError}
        openId={route.decision ?? null}
        onProject={(projectId) => go({ page: 'decisions', project: projectId, thread: null })}
        onOpen={(decisionId) => (decisionId ? go : close)({ page: 'decisions', project: decisionsFolder.id, thread: null, decision: decisionId })}
        onOpenThread={(threadId) => go({ page: 'inbox', project: null, thread: threadId })}
        onRetire={retireDecision}
        onReplace={replaceDecision}
        phone={phone}
        stacked={stack.decision}
        counts={decisionCounts}
        home={settings?.home ?? null}
      />
    );
  } else if (route.page === 'decisions') {
    main = <div className="ib-listcol" />;
  } else if (!latest || !shown) {
    main = <div className="ib-listcol">{loadError && <div className="ib-error" style={{ padding: 22 }}>{loadError}</div>}</div>;
  } else if (firstRun) {
    main = (
      <EmptyState context={context} />
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
          notice={notice}
          ask={
            notifications.ask && soundDialog === 'none' && agentNote === 'none' ? (
              <NotificationAsk
                kind={notifications.ask}
                soundOn={sound.settings.enabled}
                onTurnOn={() => void notifications.turnOn()}
                onNotNow={notifications.notNow}
              />
            ) : null
          }
          onShowNew={() => {
            // Show's line goes away with the press: after a key, focus goes to the first row it brought in.
            focusAfterShow.current = lastInput === 'keyboard';
            listOrder.current = [...(listBody(rootRef.current)?.querySelectorAll('[data-thread-id]') ?? [])].map((el) => el.getAttribute('data-thread-id')!);
            settleList('all', true);
          }}
          onOpen={openRow}
          onMarkRead={(row) => void markRead(row.thread_id, true)}
          phone={phone}
        />
        )}
        {route.thread && thread && thread.thread_id === route.thread && (
          <ThreadPane
            thread={thread}
            sent={openThreadRow?.sent ?? null}
            row={openThreadRow}
            onMarkRead={(read) => void markRead(thread.thread_id, read)}
            onArchive={(next) => void archive(thread.thread_id, thread.messages[0]!.id, next)}
            replyRequest={replyFor}
            onReplyOpened={() => setReplyFor(null)}
            onQuestions={patchQuestions}
            onChanged={afterWrite}
            onClose={() => close({ ...route, thread: null, file: null })}
            decisions={threadDecisions}
            onOpenDecisionPage={(decision) => go({ page: 'decisions', project: decision.project_id, thread: null, decision: decision.id })}
            file={route.file ?? null}
            onOpenFile={(file, options) => (file ? writeRoute({ ...routeRef.current, file }, options) : closeTo({ ...routeRef.current, file }))}
            onOpenGuide={(messageId) => go({ ...route, guide: messageId })}
            lookSeq={look?.threadId === thread.thread_id ? look.seq : undefined}
            seenThrough={look?.threadId === thread.thread_id ? look.through : null}
            onSeen={(through) => seenOnSight(thread.thread_id, through)}
            covered={!!route.guide || updateDialog !== null || soundDialog === 'open' || agentNoteOpen}
            backLabel={filterProject?.name ?? 'Inbox'}
            phone={phone}
            stacked={stack.thread}
            fileStacked={stack.file}
            onBackToList={(fileName) => {
              // The file's own close (its ×), then focus on this thread's row and one line for a screen reader.
              const root = rootRef.current;
              if (root && sidebarOpen) {
                const width = root.getBoundingClientRect().width;
                const sidebar = root.querySelector('.ib-sb-inner')?.getBoundingClientRect().width ?? 0;
                const room = LIST_MIN_WIDTH + THREAD_BESIDE_FILE_WIDTH;
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
      data-view={view}
      data-enter={entered.current ?? undefined}
      data-stack={stack.thread || stack.file || stack.decision ? [stack.thread && 'thread', stack.file && 'file', stack.decision && 'decision'].filter(Boolean).join(' ') : undefined}
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
            decisionsCount={latest?.decisions_waiting ?? 0}
            projects={projects}
            projectCounts={projectCounts}
            update={update}
            restarting={restarting}
            updated={updated}
            onInbox={() => go({ page: 'inbox', project: null, thread: null })}
            onProject={(projectId) => go({ page: 'inbox', project: projectId, thread: null })}
            onSettings={() => go({ page: 'settings', project: null, thread: null })}
            onDecisions={() => go({ page: 'decisions', project: null, thread: null })}
            onUpdate={pressUpdate}
            onWhatsNew={openWhatsNew}
            soundNeedsClick={!!settings?.sound && sound.settings.enabled && !sound.armed}
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
            void sound.setEnabled(false).then((saved) => showToast({ text: saved ? 'Sound off.' : 'The sound setting was not saved.', warn: !saved }, 4200));
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
      {toast && soundDialog !== 'open' && !agentNoteOpen && <InboxToast toast={toast} onDismiss={dismissToast} phone={phone} />}
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
      <Inbox />
    </ThemeProvider>
  );
}
