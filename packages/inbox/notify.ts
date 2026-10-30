/**
 * Browser notifications from the open Inbox page (record 6.x; owner Q8: the
 * page first on every platform, the Mac helper later; approval
 * "inbox-notify-every-thread", 2026-10-15).
 *
 * Two things notify: a new thread an agent starts (always, the tab in front
 * or not), and a new question in an agent's message (a `Stopped:` line, a
 * `Holds up:` line or any other question), unless it is in the thread the
 * person has open and visible. Plain news in an existing thread never
 * notifies. Every Inbox notification shares one tag, so the browser shows one
 * at a time. The page keeps the threads of the current burst: with one, the
 * banner names the project, the agent and the subject, and a click opens that
 * thread; with more, the burst becomes one notice, "3 waiting in 2 projects",
 * and a click opens the list. Away, a burst lasts until the tab comes to the
 * front; in front, notices within `FRONT_BURST_MS` of each other are one.
 * Several Inbox tabs raise each item once: a tab in front raises it, else
 * the first tab to claim it (`claimNotices`). A notice is silent only when
 * the Inbox's bell owns its sound (a question, every tab away, the bell on).
 *
 * The settings live on the Inbox server (config.json), not in localStorage:
 * the permission is per origin and the Inbox can move to another port, so
 * "Not now" and "on" must not depend on the origin.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxAuthor, InboxListRow, InboxMessage, InboxNotifyReach, InboxSectionId } from '@plannotator/core/inbox-types';
import { inboxQuestionWaitsForList } from '@plannotator/core/inbox-questions';
import { inboxApi, type InboxEvent, type ListModel, type NotificationSettings } from './api';
import { agentName, plural } from './format';
import { pageInFront } from './sound';
import { inboxEventsServedBy } from './sharedEvents';

/** The one tag every Inbox notification carries: a new one replaces the last. */
export const NOTIFICATION_TAG = 'plannotator-inbox';

/**
 * `renotify` is in the Notifications API but not in TypeScript's DOM lib
 * (5.8), so the options type is widened here rather than cast.
 */
export interface InboxNotificationOptions extends NotificationOptions {
  renotify?: boolean;
}

/**
 * The options every Inbox notification is raised with. One tag keeps one
 * notice at a time; `renotify` makes the replacement alert again. Without it
 * Chrome swaps the content of a notice that still carries the tag (one macOS
 * never displayed, say) with no banner and no sound, so a new question would
 * arrive silently.
 */
export function inboxNotificationOptions(text: { body: string }, options: { silent?: boolean } = {}): InboxNotificationOptions {
  const base: InboxNotificationOptions = { body: text.body, tag: NOTIFICATION_TAG, renotify: true };
  // The Inbox's own sound is on (sound.ts): the system's chime (Windows, Linux) would make it two.
  return options.silent ? { ...base, silent: true } : base;
}

/**
 * One thread's banner (record 6.2): "billing-svc: Claude Code stopped on you",
 * "… is waiting on you" while it asks, "… started a thread" for a new thread
 * that asks nothing; the subject is the body.
 */
export function threadNotificationText(input: {
  project: string;
  agent: string;
  subject: string;
  section: InboxSectionId | null;
  /** The notice is about a question (else a new thread that may ask nothing). Absent: a question. */
  asks?: boolean;
}): {
  title: string;
  body: string;
} {
  const asks = input.asks ?? true;
  const what =
    input.section === 'stopped'
      ? 'stopped on you'
      : asks || input.section === 'holding' || input.section === 'waiting'
        ? 'is waiting on you'
        : 'started a thread';
  return { title: `${input.project}: ${input.agent} ${what}`, body: input.subject };
}

/**
 * A burst (record 6.2): "3 waiting in 2 projects", or "2 waiting in
 * billing-svc"; "3 new in …" when a thread in it asks nothing. The body names
 * the projects.
 */
export function burstNotificationText(projects: readonly string[], options: { waiting?: boolean } = {}): { title: string; body: string } {
  const distinct = [...new Set(projects)];
  const where = distinct.length === 1 ? distinct[0]! : plural(distinct.length, 'project');
  const what = options.waiting === false ? 'new' : 'waiting';
  return { title: `${projects.length} ${what} in ${where}`, body: distinct.join(', ') };
}

/** In front, notices this close together are one burst; away, a burst lasts until the tab is back. */
export const FRONT_BURST_MS = 30_000;

/**
 * A message line that is a new thread an agent started: the root's FIRST
 * line (`first` on the event; a look, an archive or an Unarchive rewrites the
 * root and is never first), an agent's, open, and not a thread this page
 * already knew. An Inbox without `first` notifies no new thread.
 */
export function isNewAgentThread(message: InboxMessage, first: boolean | undefined, known: ReadonlySet<string>): boolean {
  return (
    first === true &&
    message.id === message.thread_id &&
    message.author.kind === 'agent' &&
    message.started_by_person !== true &&
    message.resolved_at === null &&
    (message.person_seen_seq ?? null) === null &&
    (message.person_read_seq ?? null) === null &&
    (message.agent_checked_seq ?? null) === null &&
    !known.has(message.thread_id)
  );
}

/** One thread a list read may notify about. */
export interface NotifyItem {
  threadId: string;
  author: InboxAuthor;
  /** A new question in it. */
  asks: boolean;
  /** The thread itself is new. */
  fresh: boolean;
  /** What brought it (`thread:<id>`, `<message id>/<question key>`): what tabs claim, so one tab raises each. */
  keys: string[];
}

/** Several Inbox tabs: each item is raised by the first tab to claim it (`claimNotices`). */
export const NOTICE_CLAIMS_KEY = 'plannotator-inbox-notified';
/** A claim is kept this long: longer than a hidden tab's timers may lag behind the event. */
export const NOTICE_CLAIM_MS = 10 * 60_000;

/**
 * Claim `keys` for this tab: answers the ones no other tab claimed first.
 * The claims live in localStorage (one origin, every tab), read and written
 * under one Web Lock where there is one; without it the check is close
 * enough. Without storage this tab raises everything.
 */
export async function claimNotices(keys: readonly string[], now: number = Date.now()): Promise<string[]> {
  const claim = (): string[] => {
    let claims: Record<string, number> = {};
    try {
      claims = JSON.parse(window.localStorage.getItem(NOTICE_CLAIMS_KEY) ?? '{}') as Record<string, number>;
      if (!claims || typeof claims !== 'object') claims = {};
    } catch {
      claims = {};
    }
    const kept: Record<string, number> = {};
    for (const [key, at] of Object.entries(claims)) if (typeof at === 'number' && now - at < NOTICE_CLAIM_MS) kept[key] = at;
    const mine = keys.filter((key) => !(key in kept));
    for (const key of mine) kept[key] = now;
    try {
      window.localStorage.setItem(NOTICE_CLAIMS_KEY, JSON.stringify(kept));
    } catch {
      // No storage: this tab raises what it has.
    }
    return mine;
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks?.request) {
    try {
      return await locks.request(NOTICE_CLAIMS_KEY, async () => claim());
    } catch {
      // Fall through.
    }
  }
  return claim();
}

/**
 * Which items raise a notice: a new thread always; a question unless its
 * thread is the one open and visible (`onScreen`, false whenever the tab is
 * not in front).
 */
export function notifiableItems(items: readonly NotifyItem[], onScreen: (threadId: string) => boolean): NotifyItem[] {
  return items.filter((item) => item.fresh || !onScreen(item.threadId));
}

/**
 * Whether a notice starts a new burst: the tab went from away to in front or
 * back since the last one, or, in front, the last one is older than
 * `FRONT_BURST_MS`.
 */
export function startsNewBurst(last: { front: boolean; at: number } | null, front: boolean, now: number): boolean {
  if (!last || last.front !== front) return true;
  return front && now - last.at > FRONT_BURST_MS;
}

export type AskKind = 'ask' | 'moved' | 'blocked';

/**
 * Which line the list shows, if any. It stays on every load until it is
 * resolved (the browser allows this address, or the person says "Not now" /
 * turns notifications off), because a line shown once is easy to miss and a
 * missing permission fails silently:
 * - `moved`: the person allowed notifications at another address of this
 *   computer (the Inbox changed port, or was opened at 127.0.0.1) and this one
 *   has no permission. Shown as soon as the page knows, with the one-click
 *   Allow: they already chose notifications once.
 * - `ask`: the browser has not been asked here. Only once the Inbox holds a
 *   thread (`hasThreads`), never on an empty first run.
 * - `blocked`: the browser blocked this address. A quiet line pointing at
 *   Settings, also only once there is something to notify about.
 */
export function askKind(
  settings: NotificationSettings,
  permission: NotificationPermission,
  origin: string,
  hasThreads = true,
): AskKind | null {
  if (permission === 'granted' || !settings.enabled || settings.dismissed) return null;
  if (permission === 'denied') return hasThreads ? 'blocked' : null;
  if (settings.allowed_origin && settings.allowed_origin !== origin && sameHost(settings.allowed_origin, origin)) return 'moved';
  return hasThreads ? 'ask' : null;
}

/**
 * "Moved" is the Inbox's port changing under the same name. Another name
 * (the tailnet address on another device, or localhost after the tailnet)
 * is another place the Inbox is open, with its own permission: the plain ask.
 * A `.localhost` name (`plannotator.localhost`, the cookie switch, #2184) is
 * this computer, so moving there from localhost is "moved" too.
 */
function sameHost(a: string, b: string): boolean {
  const loopback = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host);
  try {
    const left = new URL(a).hostname;
    const right = new URL(b).hostname;
    return left === right || (loopback(left) && loopback(right));
  } catch {
    return false;
  }
}

function supported(): boolean {
  // The constructor itself, not the name: a Notification property left undefined is no support.
  return typeof window !== 'undefined' && typeof (window as { Notification?: unknown }).Notification === 'function';
}

function currentPermission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

/** This page, for the server's count of open windows (inbox-windows.ts). */
export interface InboxWindowReport {
  id: string;
  permission: NotificationPermission | 'unsupported';
  origin: string;
}

/**
 * The browser put this tab to sleep while it was in the background, so it
 * could not notify: `discarded` (Chrome's Memory Saver closed it and this is
 * the reload) or `frozen` (Chrome froze it for a while). Null otherwise.
 */
export type TabSlept = 'discarded' | 'frozen' | null;

/** A freeze shorter than this is not worth a line (the page catches up as it wakes). */
export const FROZEN_NOTICE_MS = 60_000;

/** A new window id (`crypto.randomUUID`, else random hex). */
function newWindowId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Fall through.
  }
  return `w${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

/** The test notice's tag: its own, so it never replaces a real notice. */
export const TEST_NOTIFICATION_TAG = 'plannotator-inbox-test';

export type TestResult = 'sent' | 'not-allowed' | 'failed';

export interface InboxNotifications {
  /** The browser's answer for this origin, kept live (site settings, focus). */
  permission: NotificationPermission | 'unsupported';
  /** The line to draw above the list, or null. */
  ask: AskKind | null;
  /**
   * The line to draw on the first-run screen ("No agent has written yet"),
   * or null. The moment before the first question arrives, so it does not
   * wait for a thread as `ask` does; every other rule (dismissed, off,
   * per-origin, moved, blocked) is the same.
   */
  firstRunAsk: AskKind | null;
  /** Whether any open Inbox tab can show a notification (the server's report; null until known). */
  reach: InboxNotifyReach | null;
  setReach: (reach: InboxNotifyReach) => void;
  /** This window as the event stream reports it. */
  windowReport: () => InboxWindowReport;
  /** Tell the server this window's permission now (the event stream's hello calls it: a reconnect's URL may be stale). */
  reportWindow: () => void;
  /** The browser put this tab to sleep in the background (see `TabSlept`). */
  slept: TabSlept;
  dismissSlept: () => void;
  /** Raise a test notice now (Settings): the browser may accept it while the system hides it. */
  sendTest: () => Promise<TestResult>;
  /** Every event-stream line, before the debounced list read. */
  observe: (event: InboxEvent | null) => void;
  /** After a list read: raise what the lines brought (and remember the threads it shows). */
  flush: (list: ListModel) => void;
  turnOn: () => Promise<void>;
  notNow: () => void;
  setEnabled: (next: boolean) => Promise<void>;
}

export function useInboxNotifications(options: {
  settings: NotificationSettings | null;
  onSettings: (next: NotificationSettings) => void;
  /** `questionId`: the question it notified about (`<message id>/<key>`), absent for a new thread. */
  openThread: (threadId: string, questionId?: string) => void;
  openList: () => void;
  /** New questions arrived (before any notification rule): the sound decides for itself (sound.ts). */
  onQuestions?: () => void;
  /**
   * The Inbox's bell owns a question's sound (on, armed, no other Inbox tab in
   * front). A notice about a question raised while this tab is away is then
   * silent, so there is one sound on every OS; every other notice (a new
   * thread that asks nothing, anything raised in front) keeps the system's.
   */
  bellCovers?: () => boolean;
  /** Another Inbox tab is in front: it raises what arrives, so this one does not. */
  otherTabInFront?: () => boolean;
  /** The thread is open and visible (its pane mounted and not covered): a question in it raises nothing while in front. */
  threadOnScreen?: (threadId: string) => boolean;
}): InboxNotifications {
  const [permission, setPermission] = useState(currentPermission);
  /** The Inbox holds a thread (a list read showed one): the plain ask and the blocked line wait for it. */
  const [hasThreads, setHasThreads] = useState(false);
  const [reach, setReach] = useState<InboxNotifyReach | null>(null);
  const [slept, setSlept] = useState<TabSlept>(() =>
    typeof document !== 'undefined' && (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true ? 'discarded' : null,
  );
  const windowId = useRef<string>('');
  if (!windowId.current) windowId.current = newWindowId();
  const permissionRef = useRef(permission);
  permissionRef.current = permission;
  const settingsRef = useRef(options.settings);
  settingsRef.current = options.settings;
  const openRef = useRef({ thread: options.openThread, list: options.openList });
  openRef.current = { thread: options.openThread, list: options.openList };
  const onSettingsRef = useRef(options.onSettings);
  onSettingsRef.current = options.onSettings;
  const soundRef = useRef({ questions: options.onQuestions, bellCovers: options.bellCovers });
  soundRef.current = { questions: options.onQuestions, bellCovers: options.bellCovers };
  const tabsRef = useRef({ onScreen: options.threadOnScreen, otherInFront: options.otherTabInFront });
  tabsRef.current = { onScreen: options.threadOnScreen, otherInFront: options.otherTabInFront };
  const messages = useRef(new Map<string, { threadId: string; author: InboxAuthor }>());
  const counted = useRef(new Set<string>());
  /** Every thread a list read showed this page: a later line of one of those roots is never a new thread. */
  const known = useRef(new Set<string>());
  /** New questions (message id and claim key), waiting for the list read. */
  const pending = useRef<{ messageId: string; key: string }[]>([]);
  /** New threads an agent started, waiting for the list read. */
  const pendingThreads = useRef<string[]>([]);
  /** The threads of the current burst, with their project names and whether they ask. */
  const burst = useRef(new Map<string, { project: string; asks: boolean }>());
  /** When the last notice was raised, and whether the tab was in front then. */
  const lastNotice = useRef<{ front: boolean; at: number } | null>(null);

  // A grant or block made in the browser's site settings shows without a
  // reload: the permission's `change` event where there is one, and a fresh
  // read whenever the tab comes back (a browser without the event, or one
  // that fires it late).
  useEffect(() => {
    if (!supported()) return;
    let status: PermissionStatus | null = null;
    let gone = false;
    const sync = () => setPermission(currentPermission());
    navigator.permissions
      ?.query?.({ name: 'notifications' })
      .then((s) => {
        if (gone) return;
        status = s;
        s.addEventListener('change', sync);
      })
      .catch(() => {});
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      gone = true;
      status?.removeEventListener('change', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  // Tell the server what this window may do, whenever it changes and every
  // time the event stream (re)connects (`reportWindow`, called on the
  // stream's hello), so "Notifications reach you" is true across tabs, past
  // a long disconnect and across an Inbox restart (inbox-windows.ts). An
  // older Inbox answers 404: nothing to tell.
  const reportWindow = useCallback(() => {
    void inboxApi
      // A tab listening to another tab's stream names it, so the server counts this tab under it (sharedEvents.ts).
      .reportWindow({ window: windowId.current, permission: permissionRef.current, origin: window.location.origin, served_by: inboxEventsServedBy() })
      .then((answer) => setReach(answer.notify_reach))
      .catch(() => {});
  }, []);
  useEffect(() => {
    reportWindow();
  }, [permission, reportWindow]);

  // Chrome may freeze a background tab (Energy Saver) and discard one
  // (Memory Saver). A frozen tab runs nothing, so a notice can only come late,
  // as it wakes and the event stream catches up; a discarded tab is gone until
  // the person comes back and it reloads. Either way the page says so once.
  useEffect(() => {
    let frozenAt: number | null = null;
    const freeze = () => {
      frozenAt = Date.now();
    };
    const resume = () => {
      if (frozenAt !== null && Date.now() - frozenAt >= FROZEN_NOTICE_MS) setSlept((current) => current ?? 'frozen');
      frozenAt = null;
    };
    document.addEventListener('freeze', freeze);
    document.addEventListener('resume', resume);
    return () => {
      document.removeEventListener('freeze', freeze);
      document.removeEventListener('resume', resume);
    };
  }, []);

  // Back in front: the person sees the list, so the next notice starts a new burst.
  useEffect(() => {
    const back = () => {
      if (pageInFront()) burst.current.clear();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  const save = useCallback(async (change: Partial<NotificationSettings>) => {
    const current = settingsRef.current;
    if (current) onSettingsRef.current({ ...current, ...change });
    try {
      onSettingsRef.current((await inboxApi.saveNotifications(change)).notifications);
    } catch {
      if (current) onSettingsRef.current(current);
    }
  }, []);

  const observe = useCallback((event: InboxEvent | null) => {
    if (!event) return;
    if (event.kind === 'message' && event.message.author.kind === 'agent') {
      const message = event.message;
      messages.current.set(message.id, { threadId: message.thread_id, author: message.author });
      const id = `thread:${message.thread_id}`;
      if (!counted.current.has(id) && isNewAgentThread(message, event.first, known.current)) {
        counted.current.add(id);
        pendingThreads.current.push(message.thread_id);
      }
    } else if (event.kind === 'question') {
      const q = event.question;
      const id = `${q.message_id}/${q.key}`;
      // A new question is open at revision 0; a pick or a Send of an old one is not an item. What
      // waits is the list's own rule (core inboxQuestionWaitsForList), so a notice, the list and the
      // Decide count agree: an orphaned record never notifies.
      if (!inboxQuestionWaitsForList(q) || q.state !== 'open' || q.revision !== 0 || counted.current.has(id)) return;
      counted.current.add(id);
      pending.current.push({ messageId: q.message_id, key: id });
    }
  }, []);

  /** Raise one notice for `items` (this tab claimed them), folding them into the burst. */
  const raise = useCallback((items: NotifyItem[], rows: Map<string, InboxListRow>, front: boolean) => {
    const at = Date.now();
    if (startsNewBurst(lastNotice.current, front, at)) burst.current.clear();
    lastNotice.current = { front, at };
    // A thread the person has open on screen has been seen: it leaves the burst.
    if (front) {
      for (const threadId of [...burst.current.keys()]) if (tabsRef.current.onScreen?.(threadId) === true) burst.current.delete(threadId);
    }
    for (const item of items) {
      const earlier = burst.current.get(item.threadId);
      burst.current.delete(item.threadId);
      burst.current.set(item.threadId, {
        project: rows.get(item.threadId)?.project.name ?? 'Plannotator Inbox',
        asks: item.asks || (earlier?.asks ?? false),
      });
    }
    let text: { title: string; body: string };
    let open: () => void;
    if (burst.current.size <= 1) {
      const item = items.at(-1)!;
      const row = rows.get(item.threadId);
      text = threadNotificationText({
        project: row?.project.name ?? 'Plannotator Inbox',
        agent: agentName(item.author),
        subject: row?.subject ?? '(no subject)',
        section: row?.section ?? null,
        asks: burst.current.get(item.threadId)?.asks ?? item.asks,
      });
      // The question it notified about (`<message id>/<key>`). Unused since decision mode went thread only (2026-10-27).
      const question = item.keys.filter((key) => !key.startsWith('thread:')).at(-1);
      open = () => openRef.current.thread(item.threadId, question);
    } else {
      const entries = [...burst.current.values()];
      text = burstNotificationText(
        entries.map((entry) => entry.project),
        { waiting: entries.every((entry) => entry.asks) },
      );
      open = () => openRef.current.list();
    }
    // Silent only when the bell owns this notice's sound: a question, this tab away, the bell on and armed.
    const silent = !front && items.some((item) => item.asks) && soundRef.current.bellCovers?.() === true;
    try {
      const notification = new Notification(text.title, inboxNotificationOptions(text, { silent }));
      notification.onclick = () => {
        window.focus();
        notification.close();
        burst.current.clear();
        lastNotice.current = null;
        open();
      };
    } catch {
      // A browser that only notifies through a service worker: nothing to show.
    }
  }, []);

  const flush = useCallback(
    (list: ListModel) => {
      const questions = pending.current;
      const fresh = pendingThreads.current;
      pending.current = [];
      pendingThreads.current = [];
      const rowList = list.sections.flatMap((section) => section.threads);
      for (const row of rowList) known.current.add(row.thread_id);
      if (rowList.length > 0 || (list.projects ?? []).some((project) => project.threads > 0)) setHasThreads(true);
      if (questions.length === 0 && fresh.length === 0) return;
      // The threads these items landed in, newest last, with the agent that wrote.
      const threads = new Map<string, NotifyItem>();
      for (const threadId of fresh) {
        const root = messages.current.get(threadId);
        if (root) threads.set(threadId, { threadId, author: root.author, asks: false, fresh: true, keys: [`thread:${threadId}`] });
      }
      for (const { messageId, key } of questions) {
        const message = messages.current.get(messageId);
        if (!message) continue;
        const before = threads.get(message.threadId);
        threads.delete(message.threadId);
        threads.set(message.threadId, {
          threadId: message.threadId,
          author: message.author,
          asks: true,
          fresh: before?.fresh ?? false,
          keys: [...(before?.keys ?? []), key],
        });
      }
      if (threads.size === 0) return;
      const asks = [...threads.values()].some((item) => item.asks);
      // The sound does not depend on notifications (off, not allowed or blocked, it still rings), and rings for questions only.
      if (asks) soundRef.current.questions?.();
      const settings = settingsRef.current;
      if (!settings || !settings.enabled || !supported()) return;
      const now = Notification.permission;
      setPermission(now);
      // No permission here: nothing is raised, and this tab claims nothing, so a
      // tab that may not notify (an old address, a blocked one) never takes an
      // item another tab would have shown (claimNotices). The line above the
      // list says what to do (askKind).
      if (now !== 'granted') return;
      const front = pageInFront();
      // Another Inbox tab in front raises it (and knows what it has on screen).
      if (!front && tabsRef.current.otherInFront?.() === true) return;
      const items = notifiableItems([...threads.values()], (threadId) => front && tabsRef.current.onScreen?.(threadId) === true);
      if (items.length === 0) return;
      const rows = new Map(rowList.map((row) => [row.thread_id, row]));
      // Several tabs: each item goes to the first tab that claims it.
      void claimNotices(items.flatMap((item) => item.keys)).then((claimed) => {
        const mine = new Set(claimed);
        const raised = items.filter((item) => item.keys.some((key) => mine.has(key)));
        if (raised.length > 0) raise(raised, rows, front);
      });
    },
    [raise],
  );

  const turnOn = useCallback(async () => {
    if (!supported()) return;
    const answer = await Notification.requestPermission();
    setPermission(answer);
    // Allow: on, here. Block in the browser's prompt is an answer too (no line
    // nags about it after). Closing the prompt answers nothing: the line stays.
    if (answer === 'granted') await save({ enabled: true, dismissed: false, allowed_origin: window.location.origin });
    else if (answer === 'denied') await save({ dismissed: true });
  }, [save]);

  const notNow = useCallback(() => {
    void save({ dismissed: true });
  }, [save]);

  // Allowed here (the prompt, or the browser's site settings while the page
  // is open): this address is where notifications work now, so a later move
  // to another port is told as "moved". Once per page, so two tabs at two
  // allowed addresses do not write back and forth.
  const recordedOrigin = useRef(false);
  useEffect(() => {
    const settings = options.settings;
    if (recordedOrigin.current || permission !== 'granted' || !settings?.enabled) return;
    if (settings.allowed_origin === window.location.origin) return;
    recordedOrigin.current = true;
    void save({ allowed_origin: window.location.origin });
  }, [permission, options.settings, save]);

  const sendTest = useCallback(async (): Promise<TestResult> => {
    if (!supported() || Notification.permission !== 'granted') {
      setPermission(currentPermission());
      return 'not-allowed';
    }
    try {
      const notification = new Notification('Plannotator Inbox: test notification', {
        ...inboxNotificationOptions({ body: `Notifications from ${window.location.host} reach you.` }),
        tag: TEST_NOTIFICATION_TAG,
      } as InboxNotificationOptions);
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      return 'sent';
    } catch {
      return 'failed';
    }
  }, []);

  const windowReport = useCallback((): InboxWindowReport => ({ id: windowId.current, permission: permissionRef.current, origin: window.location.origin }), []);
  const dismissSlept = useCallback(() => setSlept(null), []);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (!next) return save({ enabled: false });
      if (!supported()) return;
      let answer = Notification.permission;
      if (answer === 'default') answer = await Notification.requestPermission();
      setPermission(answer);
      // Turning them on here is an answer too: an earlier "Not now" no longer stands.
      if (answer === 'granted') await save({ enabled: true, dismissed: false, allowed_origin: window.location.origin });
    },
    [save],
  );

  const ask = options.settings && permission !== 'unsupported' ? askKind(options.settings, permission, window.location.origin, hasThreads) : null;
  const firstRunAsk = options.settings && permission !== 'unsupported' ? askKind(options.settings, permission, window.location.origin, true) : null;

  return { permission, ask, firstRunAsk, reach, setReach, windowReport, reportWindow, slept, dismissSlept, sendTest, observe, flush, turnOn, notNow, setEnabled };
}
