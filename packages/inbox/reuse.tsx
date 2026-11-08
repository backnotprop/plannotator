/**
 * Add a file already in the Inbox to the message being written (approval
 * "reuse-attachments"): one quiet button on a tile, a big preview, a picture in
 * a message's text, an Artifacts card and the viewer; in an archived thread, which
 * takes no reply, it opens New message with the file. The composer's files
 * (ComposeFiles.tsx `addExisting`) do the rest: a pending upload naming the same
 * blob (POST /api/inbox/uploads/reuse), so nothing is written and the message
 * carries an ordinary attachment. See docs/agent-guides/inbox-files-and-guides.md.
 *
 * No provider, no button: another machine's thread (its files are not this
 * Inbox's), the tour, and a host of these parts draw what they drew.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { readableVersion } from './attachments';
import { Icon } from './icons';
import { Tip } from './components/Tip';

export type ReuseVersion = 'current' | 'sent';

/** What the composer needs from a file: the version on screen and its bytes' hash. */
export interface ReuseSource {
  id: string;
  name: string;
  size: number;
  version: ReuseVersion;
  sha256: string;
  preview: string | null;
}

export function sourceOf(file: InboxAttachmentState, version: ReuseVersion, imageUrl: (file: InboxAttachmentState, version: ReuseVersion) => string): ReuseSource {
  const changed = version === 'current' && file.current;
  return {
    id: file.id,
    name: file.name,
    size: changed ? file.current!.size : file.size,
    version,
    sha256: changed ? file.current!.sha256 : file.sent_sha256,
    preview: file.kind === 'image' ? imageUrl(file, version) : null,
  };
}

export interface ReuseApi {
  /** `reply`: into this thread's reply box. `new`: no reply can be written here (archived): New message with it. */
  target: 'reply' | 'new';
  isAdded: (file: InboxAttachmentState, version?: ReuseVersion) => boolean;
  toggle: (file: InboxAttachmentState, version?: ReuseVersion) => void;
  /** The thread's files by id: a picture in a message's text is named by its id. */
  fileOf: (id: string) => InboxAttachmentState | undefined;
}

export const ReuseContext = createContext<ReuseApi | null>(null);
export const useReuse = () => useContext(ReuseContext);

/** A paperclip with a small plus: "attach this", not "new". */
export function ReuseIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9.6 4.1 4.9 8.8a2.1 2.1 0 0 0 3 3l4.5-4.5a3.4 3.4 0 0 0-4.8-4.8L3 7.1a4.7 4.7 0 0 0 .9 7.3" transform="translate(-.6 -.2) scale(.92)" />
      <path d="M12.6 10.4v4M10.6 12.4h4" />
    </svg>
  );
}

function reuseWords(file: Pick<InboxAttachmentState, 'name'>, target: ReuseApi['target'], added: boolean): { tip: string; label: string } {
  if (added) return { tip: 'In your reply. Click to take it out', label: `${file.name} is in your reply. Take it out` };
  if (target === 'new') return { tip: 'New message with this', label: `New message with ${file.name}` };
  return { tip: 'Add to your reply', label: `Add ${file.name} to your reply` };
}

/** The button. `surface` sets its place and size in inbox.css. */
export function ReuseButton({ file, surface, version, className = '', big = false }: { file: InboxAttachmentState; surface: 'tile' | 'gallery' | 'inline' | 'card' | 'pane' | 'bar'; version?: ReuseVersion; className?: string; big?: boolean }) {
  const reuse = useReuse();
  if (!reuse) return null;
  const chosen = version ?? readableVersion(file);
  const added = reuse.isAdded(file, chosen);
  const words = reuseWords(file, reuse.target, added);
  return (
    <Tip content={words.tip}>
      <button
        type="button"
        className={`ib-reuse ib-reuse-${surface}${added ? ' ib-reuse-on' : ''} ${className}`}
        // Explicit: Safari's Tab skips a button without one (by default), and the tile's ⋯ beside it has one.
        tabIndex={0}
        aria-label={words.label}
        aria-pressed={reuse.target === 'reply' ? added : undefined}
        data-reuse={file.id}
        data-reuse-state={added ? 'added' : 'idle'}
        data-reuse-surface={surface}
        onClick={(event) => {
          event.stopPropagation();
          event.preventDefault();
          reuse.toggle(file, chosen);
        }}
      >
        {added ? <Icon name="check" size={big ? 18 : 15} /> : <ReuseIcon size={big ? 18 : 15} />}
      </button>
    </Tip>
  );
}

const MIN_PICTURE = 72;

/**
 * The button over a picture a message's text shows. The picture is drawn by
 * the shared Viewer (packages/ui, untouched), so these sit in a layer over the
 * message's body, placed from each picture's box. Each is a real button, in
 * the tab order after the message's text; it shows on the picture's hover or
 * its own focus. A picture with no captured file (remote, refused) gets none,
 * and a very small one gets none here (the viewer still has it).
 */
export function InlineReuseLayer({ bodyRef }: { bodyRef: RefObject<HTMLElement | null> }) {
  const reuse = useReuse();
  const layer = useRef<HTMLDivElement>(null);
  const [spots, setSpots] = useState<{ id: string; top: number; right: number }[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const measure = useRef(() => {});
  measure.current = () => {
    const body = bodyRef.current;
    const host = layer.current;
    if (!body || !host) return;
    const origin = host.getBoundingClientRect();
    const next: { id: string; top: number; right: number }[] = [];
    for (const img of body.querySelectorAll<HTMLImageElement>('img[data-inline-image]')) {
      const box = img.getBoundingClientRect();
      if (box.width < MIN_PICTURE || box.height < MIN_PICTURE) continue;
      next.push({ id: img.getAttribute('data-inline-image')!, top: Math.round(box.top - origin.top), right: Math.round(origin.right - box.right) });
    }
    setSpots((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  };
  useLayoutEffect(() => measure.current());
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !reuse) return;
    const run = () => measure.current();
    const observer = new ResizeObserver(run);
    observer.observe(body);
    const over = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLImageElement && target.hasAttribute('data-inline-image')) setHover(target.getAttribute('data-inline-image'));
    };
    const out = (event: Event) => {
      if (event.target instanceof HTMLImageElement) setHover(null);
    };
    body.addEventListener('mouseover', over);
    body.addEventListener('mouseout', out);
    body.addEventListener('load', run, true);
    return () => {
      observer.disconnect();
      body.removeEventListener('mouseover', over);
      body.removeEventListener('mouseout', out);
      body.removeEventListener('load', run, true);
    };
  }, [bodyRef, reuse]);
  if (!reuse) return null;
  return (
    <div className="ib-reuse-layer" ref={layer}>
      {spots.map((spot) => {
        const file = reuse.fileOf(spot.id);
        if (!file) return null;
        return (
          <div
            key={spot.id}
            className={`ib-reuse-spot${hover === spot.id ? ' ib-show' : ''}`}
            style={{ top: spot.top + 8, right: spot.right + 8 }}
            onMouseEnter={() => setHover(spot.id)}
            onMouseLeave={() => setHover(null)}
          >
            <ReuseButton file={file} surface="inline" />
          </div>
        );
      })}
    </div>
  );
}
