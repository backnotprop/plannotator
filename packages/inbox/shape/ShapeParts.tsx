/**
 * Shape in the Inbox window (approval "shape-inbox-placement"): the thread
 * header's Pebble, the grid page the sidebar's Shape row opens, the board laid
 * over the thread, and the board's Thread tab. No keys of its own: ⌘K and Esc
 * are the window's.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanePart, ShapeBoardPart } from '../lazyParts';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
// The parts by file, never the index: the index holds ShapeSurface, which only the lazy #shape-board may load.
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { ShapeGrid, shapeAgo, type ShapeGridItem } from '@plannotator/ui/components/shape/ShapeGrid';
import type { ShapeHost } from '@plannotator/ui/components/shape';
import type { InboxShapeSummary } from '../api';
import { agentName, whenTime } from '../format';
import { Icon } from '../icons';
import { MessageBody } from '../components/Thread';
import { Tip } from '../components/Tip';
import { SidebarTrigger } from '../shell/sidebar';

const ShapeBoard = ShapeBoardPart.Part;
const NO_ANSWERS: ReadonlyMap<string, QuestionAnswer> = new Map();
const noop = () => {};
const noFooter = () => null;

/** The grid's card for a board. */
export function shapeGridItem(s: InboxShapeSummary): ShapeGridItem {
  return {
    id: s.id,
    title: s.title,
    project: s.project.name,
    updated: s.updated,
    drawing: s.drawing,
    changed: s.changed,
    picture: s.preview?.picture ?? null,
    refs: s.preview?.refs ?? [],
  };
}

/** The thread header's Pebble: opens and closes the thread's board. A dot: it changed since you looked. */
export function ShapePebbleButton({ shape, open, onToggle }: { shape: InboxShapeSummary; open: boolean; onToggle: () => void }) {
  const tip = (
    <span className="ib-shape-tip">
      <b>Shape</b> v{shape.latest} · {shape.drawing ? 'drawing now' : `${shapeAgo(shape.updated)} ago`.replace('now ago', 'just now')}
    </span>
  );
  return (
    <Tip content={tip}>
      <button
        type="button"
        className={`ib-iconbtn ib-shapebtn${open ? ' ib-on' : ''}`}
        aria-label={`Shape, v${shape.latest}${shape.changed ? ', changed since you looked' : ''}`}
        aria-pressed={open}
        onClick={onToggle}
        data-shape-pebble={shape.id}
      >
        <Pebble alive={open || shape.drawing} reshaping={shape.drawing} size={18} />
        {shape.changed && !open && <span className="ib-shape-dot" aria-hidden="true" />}
      </button>
    </Tip>
  );
}

/** The board, over the thread (or over the grid): its ×, Esc or Back closes it. */
export function ShapeLayer({ host, id, onClose, thread }: { host: ShapeHost; id: string; onClose: () => void; thread: InboxThread | null }) {
  return (
    <section className="ib-shape-layer pn-shape" data-shape-layer={id} aria-label="Shape">
      {/* The board is a chunk the Inbox serves: one that cannot arrive says so here, with Reload. */}
      <PanePart loading={<div className="ib-shape-loading" aria-busy="true" />}>
          <ShapeBoard host={host} id={id} onClose={onClose} renderThread={thread ? ({ flash }) => <ShapeThreadTab thread={thread} flash={flash} /> : undefined} />
      </PanePart>
    </section>
  );
}

/** The board's Thread tab: the thread's messages, read-only, each marked for the board's "jump to the message". */
export function ShapeThreadTab({ thread, flash }: { thread: InboxThread; flash: string | null }) {
  return (
    <div className="ib-shape-thread">
      {thread.messages.map((m) => (
        <article key={m.id} className={`ib-shape-msg${flash === m.id ? ' shp-flash' : ''}`} data-shape-message={m.id}>
          <div className="ib-shape-who">
            <b>{m.author.kind === 'person' ? 'You' : agentName(m.author)}</b>
            <span>{whenTime(m.created_at)}</span>
          </div>
          <MessageBody message={m} projectRoot={thread.project.root} repo={thread.project.repo ?? null} readOnly answers={NO_ANSWERS} onPick={noop} footerFor={noFooter} onOpenAttachment={noop} />
        </article>
      ))}
    </div>
  );
}

/** The grid page (the sidebar's Shape row): "Shape", Find, and every board newest first. */
export function ShapeGridPage({ shapes, onOpen }: { shapes: InboxShapeSummary[] | null; onOpen: (s: InboxShapeSummary) => void }) {
  const [query, setQuery] = useState('');
  const items = useMemo(() => (shapes ?? []).filter((s) => s.state === 'active').map(shapeGridItem), [shapes]);
  const byId = useMemo(() => new Map((shapes ?? []).map((s) => [s.id, s])), [shapes]);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The page's heading takes focus, as the Board's does; Find is one Tab away.
  useEffect(() => headingRef.current?.focus({ preventScroll: true }), []);
  return (
    <section className="ib-bpage ib-shape-page" data-shape-page="" aria-labelledby="ib-shape-title" aria-busy={shapes === null}>
      <div className="ib-bhead">
        <SidebarTrigger />
        <h1 id="ib-shape-title" ref={headingRef} tabIndex={-1}>
          Shape
        </h1>
        <span className="ib-bsp" />
        <label className="ib-shape-find">
          <Icon name="search" size={16} />
          <input type="search" placeholder="Find by title or project" aria-label="Find by title or project" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <div className="ib-shape-gridwrap">
        <ShapeGrid
          items={items}
          query={query}
          onOpen={(id) => {
            const s = byId.get(id);
            if (s) onOpen(s);
          }}
        />
      </div>
    </section>
  );
}
