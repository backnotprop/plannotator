/**
 * Browser notifications from the open Inbox page (record 6.x; owner Q8: the
 * page first on every platform, the Mac helper later). One notification per
 * thread, tagged by the thread id, so a second item in the same thread
 * replaces the first; nothing while the Inbox tab is in front; a click
 * focuses the tab and opens the thread.
 *
 * An item is a new question in an agent's message, placed as the list places
 * it: a `Stopped:` line is Stopped on you, a `Holds up:` line Holding up work,
 * any other question Waiting on you. News never notifies.
 *
 * The settings live on the Inbox server (config.json), not in localStorage:
 * the permission is per origin and the Inbox can move to another port, so
 * "Not now" and "on" must not depend on the origin.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxAuthor, InboxQuestion } from '@plannotator/core/inbox-types';
import { inboxApi, type InboxEvent, type ListModel, type NotificationSettings, type NotifySection } from './api';
import { agentName } from './format';

/** Strongest first, as the list orders its sections. */
export const NOTIFY_SECTIONS: readonly { id: NotifySection; label: string }[] = [
  { id: 'stopped', label: 'Stopped on you' },
  { id: 'holding', label: 'Holding up work' },
  { id: 'waiting', label: 'Waiting on you' },
];

const RANK: Record<NotifySection, number> = { stopped: 0, holding: 1, waiting: 2 };

/** Where the list puts a thread for this question. */
export function sectionOfQuestion(question: Pick<InboxQuestion, 'stopped' | 'holds_up'>): NotifySection {
  if (question.stopped) return 'stopped';
  if (question.holds_up.length > 0) return 'holding';
  return 'waiting';
}

/** The banner: "billing-svc: Claude Code stopped on you", then the thread's subject (record 6.2). */
export function notificationText(input: { project: string; agent: string; subject: string; section: NotifySection }): {
  title: string;
  body: string;
} {
  const what =
    input.section === 'stopped' ? 'stopped on you' : input.section === 'holding' ? 'is holding up work on you' : 'is waiting on you';
  return { title: `${input.project}: ${input.agent} ${what}`, body: input.subject };
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
  return settings.allowed_origin && settings.allowed_origin !== origin ? 'moved' : 'ask';
}

/** The Inbox tab is in front: the "N new" notice and the counts are enough (record 6.3). */
function pageInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function currentPermission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

interface PendingItem {
  messageId: string;
  section: NotifySection;
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
  setSection: (section: NotifySection, next: boolean) => void;
}

export function useInboxNotifications(options: {
  settings: NotificationSettings | null;
  onSettings: (next: NotificationSettings) => void;
  openThread: (threadId: string) => void;
}): InboxNotifications {
  const [permission, setPermission] = useState(currentPermission);
  const [askRaised, setAskRaised] = useState(false);
  const settingsRef = useRef(options.settings);
  settingsRef.current = options.settings;
  const openRef = useRef(options.openThread);
  openRef.current = options.openThread;
  const onSettingsRef = useRef(options.onSettings);
  onSettingsRef.current = options.onSettings;
  const messages = useRef(new Map<string, { threadId: string; author: InboxAuthor }>());
  const counted = useRef(new Set<string>());
  const pending = useRef<PendingItem[]>([]);

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
      pending.current.push({ messageId: q.message_id, section: sectionOfQuestion(q) });
    }
  }, []);

  const flush = useCallback((list: ListModel) => {
    const items = pending.current;
    pending.current = [];
    const settings = settingsRef.current;
    if (items.length === 0 || !settings || !settings.enabled || !supported()) return;
    // One per thread: its strongest item, in a section the person kept on.
    const byThread = new Map<string, { section: NotifySection; author: InboxAuthor }>();
    for (const item of items) {
      if (!settings.sections.includes(item.section)) continue;
      const message = messages.current.get(item.messageId);
      if (!message) continue;
      const held = byThread.get(message.threadId);
      if (!held || RANK[item.section] < RANK[held.section]) byThread.set(message.threadId, { section: item.section, author: message.author });
    }
    if (byThread.size === 0) return;
    const now = Notification.permission;
    setPermission(now);
    if (now === 'default') {
      setAskRaised(true);
      return;
    }
    if (now !== 'granted' || pageInFront()) return;
    const rows = new Map(list.sections.flatMap((section) => section.threads).map((row) => [row.thread_id, row]));
    for (const [threadId, { section, author }] of byThread) {
      const row = rows.get(threadId);
      const { title, body } = notificationText({
        project: row?.project.name ?? 'Plannotator Inbox',
        agent: agentName(author),
        subject: row?.subject ?? '(no subject)',
        section,
      });
      try {
        const notification = new Notification(title, { body, tag: threadId });
        notification.onclick = () => {
          window.focus();
          notification.close();
          openRef.current(threadId);
        };
      } catch {
        // A browser that only notifies through a service worker: nothing to show.
      }
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

  const setSection = useCallback(
    (section: NotifySection, next: boolean) => {
      const current = settingsRef.current?.sections ?? [];
      const sections = NOTIFY_SECTIONS.map((s) => s.id).filter((id) => (id === section ? next : current.includes(id)));
      void save({ sections });
    },
    [save],
  );

  const ask =
    askRaised && options.settings && permission !== 'unsupported' ? askKind(options.settings, permission, window.location.origin) : null;

  return { permission, ask, observe, flush, turnOn, notNow, setEnabled, setSection };
}
