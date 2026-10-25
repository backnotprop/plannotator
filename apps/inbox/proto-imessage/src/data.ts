/**
 * The prototype's data: the real Inbox API (packages/inbox/api.ts), the real
 * event stream for live updates, and the person's saved theme. Nothing here is
 * mocked; a thread is read as the window reads it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi, setPageSession, type ListModel, type SettingsModel } from '@inbox/api';
import { foldSnippet, snippetText } from '@inbox/folding';
import { isInboxNote, type InboxListRow, type InboxMessageWire, type InboxThread } from '@plannotator/core/inbox-types';

export type Row = InboxListRow;

/** Every row once, in the list's own section order. */
export function flatRows(list: ListModel | null): Row[] {
  if (!list) return [];
  return list.sections.flatMap((s) => s.threads);
}

/** The last message that is not one of the Inbox's own notes. */
export function lastReal(messages: readonly InboxMessageWire[]): InboxMessageWire | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (!isInboxNote(messages[i]!)) return messages[i];
  return messages[messages.length - 1];
}

export interface Preview {
  who: 'agent' | 'person';
  text: string;
  pictures: number;
  files: number;
}

/** A Messages-style preview: the latest message, as plain words. */
export function previewOf(thread: InboxThread): Preview | null {
  const last = lastReal(thread.messages);
  if (!last) return null;
  const words = snippetText(foldSnippet(last, thread.messages)).trim();
  return {
    who: last.author.kind === 'person' ? 'person' : 'agent',
    text: words,
    pictures: last.inline_images?.length ?? 0,
    files: last.attachments?.length ?? 0,
  };
}

export function useInbox() {
  const [list, setList] = useState<ListModel | null>(null);
  const [settings, setSettings] = useState<SettingsModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const cursor = useRef(0);

  const reload = useCallback(async () => {
    try {
      const model = await inboxApi.list();
      setPageSession(model.serverSession);
      cursor.current = model.cursor;
      setList(model);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    inboxApi.settings().then(setSettings, () => {});
  }, [reload]);

  // The real event stream: any store line re-reads the list and the open thread.
  useEffect(() => {
    if (!list) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const source = new EventSource(`/api/inbox/events?cursor=${cursor.current}`);
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void reload();
        setTick((t) => t + 1);
      }, 150);
    };
    for (const name of ['record', 'deliveries', 'drafts', 'status']) source.addEventListener(name, bump);
    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
    // Subscribe once the first list landed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list === null]);

  return { list, settings, error, reload, tick };
}

/** Threads read once each for their previews (the list row carries no latest message). */
export function useThreads(rows: Row[], tick: number) {
  const [threads, setThreads] = useState<Record<string, InboxThread>>({});
  const seen = useRef<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    for (const row of rows) {
      const stamp = `${row.last_at}|${row.message_count}|${tick}`;
      if (seen.current[row.thread_id] === stamp) continue;
      seen.current[row.thread_id] = stamp;
      inboxApi.thread(row.thread_id).then(
        (model) => alive && setThreads((all) => ({ ...all, [row.thread_id]: model.thread })),
        () => {},
      );
    }
    return () => {
      alive = false;
    };
  }, [rows, tick]);
  return threads;
}

/** Halftone reads the palette from `.theme-<id>` and the mode from `.light` / `.dark` on <html>. */
export function useTheme(settings: SettingsModel | null) {
  const query = new URLSearchParams(location.search).get('mode');
  const [mode, setMode] = useState<'light' | 'dark' | 'system'>(
    query === 'light' || query === 'dark' ? query : 'system',
  );
  const saved = settings?.theme;
  useEffect(() => {
    if (query !== 'light' && query !== 'dark' && saved?.mode) setMode(saved.mode);
  }, [saved?.mode, query]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches);
      const palette = (dark ? saved?.dark : saved?.light) ?? 'plannotator';
      const html = document.documentElement;
      html.className = '';
      html.classList.add(`theme-${palette}`, dark ? 'dark' : 'light');
      html.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode, saved?.light, saved?.dark]);
  return { mode, setMode };
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const on = () => setMatch(media.matches);
    media.addEventListener('change', on);
    return () => media.removeEventListener('change', on);
  }, [query]);
  return match;
}
