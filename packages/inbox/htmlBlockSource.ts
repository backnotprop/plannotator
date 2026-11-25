/**
 * An html block's still picture on the Artifacts wall (the owner, 2026-11-25, of the Wall's html tiles: "I'm sorry
 * what's with the empty titles?"). The Wall's rows carry no source (a page of tiles would carry every block), so a
 * tile reads its own block once it nears the screen: `GET /api/inbox/artifacts/html?key=` on the Inbox that holds
 * the thread (a linked computer's through the window's forward, `/api/inbox/m/<machine>/…`). Each read is kept in
 * the window, so scrolling back never reads again; a failed one for 30 s. A linked computer the Wall's read marks
 * away is not asked (its tiles show the mark), and at most 2 reads go to linked computers at once.
 *
 * The picture itself is the grid's (`htmlBlockPicture`): the block's markup in ArtifactsView's `PageFrame`, a frame
 * that runs no script under the window's policy, told first not to prefetch. A page that draws nothing with no
 * script (a chart its script draws) has no picture: its tile shows the quiet HTML mark.
 */
import { useEffect, useState } from 'react';
import { inboxHtmlBlockDrawsStill } from '@plannotator/core/inbox-html-blocks';
import { inboxUrl } from './inboxUrl';

/** A dns-prefetch hint is not covered by the policy, so the page is told first not to prefetch (as plans/planContent.tsx). */
export const NO_PREFETCH = '<meta http-equiv="x-dns-prefetch-control" content="off">';

/** The still picture's document for a block's source, or null when it would draw nothing (the HTML mark instead). */
export function htmlBlockPicture(source: string | null): string | null {
  return source !== null && inboxHtmlBlockDrawsStill(source) ? `${NO_PREFETCH}${source}` : null;
}

/** A block larger than this keeps its mark on the Wall (its source is not read for a tile), as a large file's text. */
export const WALL_HTML_SOURCE_MAX = 256 * 1024;
/** How many sources the window keeps (the newest used). */
const KEPT_MAX = 48;
/**
 * A read that failed is kept this long (a machine asleep, a request that hung): scrolling back over its tile shows
 * the mark again without asking again; after it, the next time the tile nears the screen it reads again.
 */
export const HTML_SOURCE_FAILED_KEPT_MS = 30_000;
/**
 * At most this many reads from linked computers at once: each goes through this window's own origin, whose few
 * HTTP/1.1 connections the rest of the window needs, and one to a machine that stopped answering can hang.
 */
export const FAR_HTML_READS_MAX = 2;
/** A read from a linked computer that has not answered in this long is given up (a failed read). */
export const FAR_HTML_READ_TIMEOUT_MS = 15_000;

const kept = new Map<string, { read: Promise<string | null>; failedAt: number | null }>();
let farReading = 0;
const farWaiting: Array<() => void> = [];
/** The linked computers the Wall's last read marked away (`machines[id].away`): their tiles are not read. */
const away = new Set<string>();

/** What the Wall's read says of its linked computers (`machines: { <id>: { away } }`); any other shape says nothing. */
export function noteWallMachines(answer: unknown): void {
  const machines = (answer as { machines?: unknown } | null)?.machines;
  if (!machines || typeof machines !== 'object') return;
  for (const [machine, state] of Object.entries(machines as Record<string, unknown>)) {
    if ((state as { away?: unknown } | null)?.away === true) away.add(machine);
    else away.delete(machine);
  }
}

/** Whether the Wall's last read marked this linked computer away. */
export function wallMachineAway(machine: string | null | undefined): boolean {
  return !!machine && away.has(machine);
}

/** Wait for a far read's turn; the release it resolves to hands the turn on. */
function farTurn(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      farReading += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        farReading -= 1;
        farWaiting.shift()?.();
      });
    };
    if (farReading < FAR_HTML_READS_MAX) grant();
    else farWaiting.push(grant);
  });
}

async function fetchSource(key: string, machine: string | null | undefined): Promise<string | null> {
  const release = machine ? await farTurn() : null;
  const stop = machine ? new AbortController() : null;
  const timer = stop ? setTimeout(() => stop.abort(), FAR_HTML_READ_TIMEOUT_MS) : null;
  try {
    const response = await fetch(inboxUrl('/artifacts/html', `key=${encodeURIComponent(key)}`, machine), { headers: { Accept: 'application/json' }, cache: 'no-store', signal: stop?.signal });
    const body = response.ok ? ((await response.json()) as { html?: unknown }) : null;
    return typeof body?.html === 'string' ? body.html : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    release?.();
  }
}

/** One block's source by its key, on the machine that holds its thread (null: this Inbox); null when it cannot be read. */
export function readHtmlBlockSource(key: string, machine: string | null | undefined): Promise<string | null> {
  const id = `${machine ?? ''}|${key}`;
  const was = kept.get(id);
  if (was && (was.failedAt === null || Date.now() - was.failedAt < HTML_SOURCE_FAILED_KEPT_MS)) {
    kept.delete(id);
    kept.set(id, was);
    return was.read;
  }
  kept.delete(id);
  const entry: { read: Promise<string | null>; failedAt: number | null } = { read: fetchSource(key, machine), failedAt: null };
  kept.set(id, entry);
  void entry.read.then((source) => {
    if (source === null) entry.failedAt = Date.now();
  });
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
  return entry.read;
}

/**
 * A Wall tile's block source, read once the tile is near (null until then, when too large, when unreadable, or
 * while its linked computer is marked away: its tile shows the mark and asks nothing).
 */
export function useHtmlBlockSource(row: { key: string; machine?: string; html?: { size: number } | null }, near: boolean): string | null {
  // The read is the row's: a tile drawn for another row never shows this one's source.
  const id = `${row.machine ?? ''}|${row.key}`;
  const [read, setRead] = useState<{ id: string; source: string | null } | null>(null);
  const block = !!row.html;
  const small = (row.html?.size ?? 0) <= WALL_HTML_SOURCE_MAX;
  const asleep = wallMachineAway(row.machine);
  useEffect(() => {
    if (!near || !small || !block || asleep) return;
    let cancelled = false;
    void readHtmlBlockSource(row.key, row.machine).then((source) => !cancelled && setRead({ id, source }));
    return () => {
      cancelled = true;
    };
  }, [near, small, block, asleep, id, row.key, row.machine]);
  return small && block && read?.id === id ? read.source : null;
}

/** Tests only. */
export function resetHtmlBlockSourcesForTest(): void {
  kept.clear();
  away.clear();
  farReading = 0;
  farWaiting.length = 0;
}
