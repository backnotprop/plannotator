/**
 * An html block's still picture on the Artifacts wall (the owner, 2026-11-25, of the Wall's html tiles: "I'm sorry
 * what's with the empty titles?"). The Wall's rows carry no source (a page of tiles would carry every block), so a
 * tile reads its own block once it nears the screen: `GET /api/inbox/artifacts/html?key=` on the Inbox that holds
 * the thread (a linked computer's through the window's forward, `/api/inbox/m/<machine>/…`). Each read is kept in
 * the window, so scrolling back never reads again; a failed read is not kept.
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
const kept = new Map<string, Promise<string | null>>();

/** One block's source by its key, on the machine that holds its thread (null: this Inbox); null when it cannot be read. */
export function readHtmlBlockSource(key: string, machine: string | null | undefined): Promise<string | null> {
  const id = `${machine ?? ''}|${key}`;
  const was = kept.get(id);
  if (was) {
    kept.delete(id);
    kept.set(id, was);
    return was;
  }
  const read = fetch(inboxUrl('/artifacts/html', `key=${encodeURIComponent(key)}`, machine), { headers: { Accept: 'application/json' }, cache: 'no-store' })
    .then((response) => (response.ok ? (response.json() as Promise<{ html?: unknown }>) : null))
    .then((body) => (typeof body?.html === 'string' ? body.html : null))
    .catch(() => null);
  kept.set(id, read);
  // Not kept when it could not be read: the next time the tile nears the screen, it reads again.
  void read.then((source) => {
    if (source === null && kept.get(id) === read) kept.delete(id);
  });
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
  return read;
}

/** A Wall tile's block source, read once the tile is near (null until then, when too large, or when unreadable). */
export function useHtmlBlockSource(row: { key: string; machine?: string; html?: { size: number } | null }, near: boolean): string | null {
  // The read is the row's: a tile drawn for another row never shows this one's source.
  const id = `${row.machine ?? ''}|${row.key}`;
  const [read, setRead] = useState<{ id: string; source: string | null } | null>(null);
  const block = !!row.html;
  const small = (row.html?.size ?? 0) <= WALL_HTML_SOURCE_MAX;
  useEffect(() => {
    if (!near || !small || !block) return;
    let cancelled = false;
    void readHtmlBlockSource(row.key, row.machine).then((source) => !cancelled && setRead({ id, source }));
    return () => {
      cancelled = true;
    };
  }, [near, small, block, id, row.key, row.machine]);
  return small && block && read?.id === id ? read.source : null;
}

/** Tests only. */
export function resetHtmlBlockSourcesForTest(): void {
  kept.clear();
}
