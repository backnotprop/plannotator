/**
 * Browser notifications from the open Inbox page (record 6.x; owner Q8: the
 * page first on every platform, the Mac helper later).
 *
 * An item is a new question in an agent's message (a `Stopped:` line, a
 * `Holds up:` line or any other question); news never notifies. Every Inbox
 * notification shares one tag, so the browser shows one at a time. While the
 * tab is away, the page keeps the threads it notified about: with one, the
 * banner names the project, the agent and the subject, and a click opens that
 * thread; with more, a burst becomes one notice, "3 waiting in 2 projects",
 * and a click opens the list. The set clears when the tab comes to the front,
 * where nothing is raised: the "N new" notice and the counts are enough.
 *
 * The settings live on the Inbox server (config.json), not in localStorage:
 * the permission is per origin and the Inbox can move to another port, so
 * "Not now" and "on" must not depend on the origin.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxAuthor, InboxSectionId } from '@plannotator/core/inbox-types';
import { inboxApi, type InboxEvent, type ListModel, type NotificationSettings } from './api';
import { agentName, plural } from './format';

/** The one tag every Inbox notification carries: a new one replaces the last. */
export const NOTIFICATION_TAG = 'plannotator-inbox';

/** One thread's banner (record 6.2): "billing-svc: Claude Code stopped on you", then the subject. */
export function threadNotificationText(input: { project: string; agent: string; subject: string; section: InboxSectionId | null }): {
  title: string;
  body: string;
} {
  const what = input.section === 'stopped' ? 'stopped on you' : 'is waiting on you';
  return { title: `${input.project}: ${input.agent} ${what}`, body: input.subject };
}

/** A burst (record 6.2): "3 waiting in 2 projects", or "2 waiting in billing-svc"; the body names the projects. */
export function burstNotificationText(projects: readonly string[]): { title: string; body: string } {
  const distinct = [...new Set(projects)];
  const where = distinct.length === 1 ? distinct[0]! : plural(distinct.length, 'project');
  return { title: `${projects.length} waiting in ${where}`, body: distinct.join(', ') };
}

export type AskKind = 'ask' | 'moved';

/**
 * Which one-time line the list shows, if any: the ask, or, when the person
 * turned notifications on at another origin (the Inbox moved port), "The
 * Inbox moved to a new address". Never once they said "Not now", turned
 * notifications off, or the browser already decided.
 */
export function askKind(settings: NotificationSettings, permission: NotificationPermission, origin: string): AskKind | null {
  if (permission !== 'default' || !settings.enabled || settings.dismissed) return null;
  return settings.allowed_origin && settings.allowed_origin !== origin && sameHost(settings.allowed_origin, origin) ? 'moved' : 'ask';
}

/**
 * "Moved" is the Inbox's port changing under the same name. Another name
 * (the tailnet address on another device, or localhost after the tailnet)
 * is another place the Inbox is open, with its own permission: the plain ask.
 */
function sameHost(a: string, b: string): boolean {
  const loopback = (host: string) => host === 'localhost' || host === '[::1]' || /^127\./.test(host);
  try {
    const left = new URL(a).hostname;
    const right = new URL(b).hostname;
    return left === right || (loopback(left) && loopback(right));
  } catch {
    return false;
  }
}

/** The Inbox tab is in front (record 6.3). */
function pageInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function currentPermission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

export interface InboxNotifications {
  /** The browser's answer for this origin. */
  permission: NotificationPermission | 'unsupported';
  /** The one-time line to draw above the list, or null. */
  ask: AskKind | null;
  /** Every event-stream line, before the debounced list read. */
  observe: (event: InboxEvent | null) => void;
  /** After the list read that the lines triggered: raise what they brought. */
  flush: (list: ListModel) => void;
  turnOn: () => Promise<void>;
  notNow: () => void;
  setEnabled: (next: boolean) => Promise<void>;
}

export function useInboxNotifications(options: {
  settings: NotificationSettings | null;
  onSettings: (next: NotificationSettings) => void;
  openThread: (threadId: string) => void;
  openList: () => void;
}): InboxNotifications {
  const [permission, setPermission] = useState(currentPermission);
  const [askRaised, setAskRaised] = useState(false);
  const settingsRef = useRef(options.settings);
  settingsRef.current = options.settings;
  const openRef = useRef({ thread: options.openThread, list: options.openList });
  openRef.current = { thread: options.openThread, list: options.openList };
  const onSettingsRef = useRef(options.onSettings);
  onSettingsRef.current = options.onSettings;
  const messages = useRef(new Map<string, { threadId: string; author: InboxAuthor }>());
  const counted = useRef(new Set<string>());
  /** Message ids with a new question, waiting for the list read. */
  const pending = useRef<string[]>([]);
  /** The threads notified since the tab was last in front, with their project names. */
  const away = useRef(new Map<string, string>());

  // A grant or block made in the browser's site settings shows without a reload.
  useEffect(() => {
    if (!supported() || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    const sync = () => setPermission(currentPermission());
    navigator.permissions
      .query({ name: 'notifications' })
      .then((s) => {
        status = s;
        s.addEventListener('change', sync);
      })
      .catch(() => {});
    return () => status?.removeEventListener('change', sync);
  }, []);

  // Back in front: the person sees the list, so the next notice starts a new burst.
  useEffect(() => {
    const back = () => {
      if (pageInFront()) away.current.clear();
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
      messages.current.set(event.message.id, { threadId: event.message.thread_id, author: event.message.author });
    } else if (event.kind === 'question') {
      const q = event.question;
      const id = `${q.message_id}/${q.key}`;
      // A new question is open at revision 0; a pick or a Send of an old one is not an item.
      if (q.state !== 'open' || q.revision !== 0 || counted.current.has(id)) return;
      counted.current.add(id);
      pending.current.push(q.message_id);
    }
  }, []);

  const flush = useCallback((list: ListModel) => {
    const items = pending.current;
    pending.current = [];
    const settings = settingsRef.current;
    if (items.length === 0 || !settings || !settings.enabled || !supported()) return;
    // The threads these items landed in, newest last, with the agent that wrote.
    const threads = new Map<string, InboxAuthor>();
    for (const messageId of items) {
      const message = messages.current.get(messageId);
      if (message) threads.set(message.threadId, message.author);
    }
    if (threads.size === 0) return;
    const now = Notification.permission;
    setPermission(now);
    if (now === 'default') {
      setAskRaised(true);
      return;
    }
    if (now !== 'granted' || pageInFront()) return;
    const rows = new Map(list.sections.flatMap((section) => section.threads).map((row) => [row.thread_id, row]));
    for (const threadId of threads.keys()) away.current.set(threadId, rows.get(threadId)?.project.name ?? 'Plannotator Inbox');
    let text: { title: string; body: string };
    let open: () => void;
    if (away.current.size === 1) {
      const [threadId, author] = [...threads][0]!;
      const row = rows.get(threadId);
      text = threadNotificationText({
        project: row?.project.name ?? 'Plannotator Inbox',
        agent: agentName(author),
        subject: row?.subject ?? '(no subject)',
        section: row?.section ?? null,
      });
      open = () => openRef.current.thread(threadId);
    } else {
      text = burstNotificationText([...away.current.values()]);
      open = () => openRef.current.list();
    }
    try {
      const notification = new Notification(text.title, { body: text.body, tag: NOTIFICATION_TAG });
      notification.onclick = () => {
        window.focus();
        notification.close();
        away.current.clear();
        open();
      };
    } catch {
      // A browser that only notifies through a service worker: nothing to show.
    }
  }, []);

  const turnOn = useCallback(async () => {
    if (!supported()) return;
    const answer = await Notification.requestPermission();
    setPermission(answer);
    setAskRaised(false);
    await save(answer === 'granted' ? { enabled: true, dismissed: false, allowed_origin: window.location.origin } : { dismissed: true });
  }, [save]);

  const notNow = useCallback(() => {
    setAskRaised(false);
    void save({ dismissed: true });
  }, [save]);

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

  const ask =
    askRaised && options.settings && permission !== 'unsupported' ? askKind(options.settings, permission, window.location.origin) : null;

  return { permission, ask, observe, flush, turnOn, notNow, setEnabled };
}
