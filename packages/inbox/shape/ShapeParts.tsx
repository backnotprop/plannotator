import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanePart, ShapeBoardPart } from '../lazyParts';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { ShapeGrid, shapeAgo, type ShapeGridItem } from '@plannotator/ui/components/shape/ShapeGrid';
import type { ShapeHost, ShapeReviewAt } from '@plannotator/ui/components/shape';
import type { ShapeBoardPlace, ShapeBoardProps } from './types';
import { inboxApi, type InboxShapeSummary } from '../api';
import { agentName, whenTime } from '../format';
import { Icon } from '../icons';
import { MessageBody } from '../components/Thread';
import { Tip } from '../components/Tip';
import { SidebarTrigger, useSidebar } from '../shell/sidebar';
import { shapeReview, shapeReviewMessage } from './review';

const ShapeBoard = ShapeBoardPart.Part;
const NO_ANSWERS: ReadonlyMap<string, QuestionAnswer> = new Map();
const noop = () => {};
const noFooter = () => null;

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

export function ShapeLayer({
  host,
  id,
  onClose,
  thread,
  onOpenReview,
  covered = false,
  onAddToReply,
  place = null,
  onNavigate,
  back = null,
  headSide,
}: {
  host: ShapeHost;
  id: string;
  onClose: () => void;
  thread: InboxThread | null;
  onOpenReview?: (messageId: string, at: ShapeReviewAt | null) => void;
  covered?: boolean;
  onAddToReply?: ShapeBoardProps['onAddToReply'];
  place?: ShapeBoardPlace | null;
  onNavigate?: ShapeBoardProps['onNavigate'];
  back?: ReactNode;
  headSide?: ReactNode;
}) {
  const { isMobile } = useSidebar();
  const reviewMessage = shapeReviewMessage(thread);
  const openReview = useRef(onOpenReview);
  openReview.current = onOpenReview;
  const review = useMemo(
    () => (reviewMessage && onOpenReview ? shapeReview(reviewMessage, (message, at) => openReview.current?.(message, at), inboxApi.guide) : null),
    [reviewMessage?.id, reviewMessage?.guide?.sha256, !!onOpenReview],
  );
  return (
    <ShapeBoardLayer
      host={host}
      id={id}
      onClose={onClose}
      thread={thread}
      review={review}
      covered={covered}
      onAddToReply={onAddToReply}
      place={place}
      onNavigate={onNavigate}
      headStart={isMobile && !back ? undefined : (
        <>
          {!isMobile && <SidebarTrigger />}
          {back}
        </>
      )}
      headSide={headSide}
    />
  );
}

export function ShapeBoardLayer({
  host,
  id,
  onClose,
  thread,
  hidden,
  onCode,
  review = null,
  covered = false,
  onAddToReply,
  headStart,
  headSide,
  place = null,
  onNavigate,
}: {
  host: ShapeHost;
  id: string;
  onClose: () => void;
  thread: InboxThread | null;
  hidden?: boolean;
  onCode?: ShapeBoardProps['onCode'];
  review?: ShapeBoardProps['review'];
  covered?: boolean;
  onAddToReply?: ShapeBoardProps['onAddToReply'];
  headStart?: ReactNode;
  headSide?: ReactNode;
  place?: ShapeBoardPlace | null;
  onNavigate?: ShapeBoardProps['onNavigate'];
}) {
  const [failedOn, setFailedOn] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  if (failedOn !== null && failedOn !== id) {
    setFailedOn(null);
    setAttempt(attempt + 1);
  }
  const failed = useCallback(() => {
    ShapeBoardPart.retry();
    setFailedOn(id);
  }, [id]);
  return (
    <section className="ib-shape-layer ib-wlayer pn-shape" data-shape-layer={id} aria-label="Shape" hidden={hidden} inert={covered || undefined}>
      <PanePart key={attempt} loading={<div className="ib-shape-loading" aria-busy="true" />} onFailed={failed}>
        <ShapeBoard
          host={host}
          id={id}
          onClose={onClose}
          onCode={onCode}
          review={review}
          renderThread={thread ? ({ flash }) => <ShapeThreadTab thread={thread} flash={flash} openInFiles={!!host.fileAction} /> : undefined}
          headStart={headStart}
          headSide={headSide}
          crosshair
          onAddToReply={thread ? onAddToReply : undefined}
          {...(place ? { initialView: place.view, initialPanel: place.panel } : {})}
          onNavigate={onNavigate}
        />
      </PanePart>
    </section>
  );
}

export function ShapeThreadTab({ thread, flash, openInFiles = false }: { thread: InboxThread; flash: string | null; openInFiles?: boolean }) {
  return (
    <div className="ib-shape-thread">
      {thread.messages.map((m) => (
        <article key={m.id} className={`ib-shape-msg${flash === m.id ? ' shp-flash' : ''}`} data-shape-message={m.id}>
          <div className="ib-shape-who">
            <b>{m.author.kind === 'person' ? 'You' : agentName(m.author)}</b>
            <span>{whenTime(m.created_at)}</span>
          </div>
          <MessageBody message={m} projectRoot={thread.project.root} openInFiles={openInFiles} repo={thread.project.repo ?? null} readOnly answers={NO_ANSWERS} onPick={noop} footerFor={noFooter} onOpenAttachment={noop} />
        </article>
      ))}
    </div>
  );
}

export function ShapeGridPage({ shapes, onOpen }: { shapes: InboxShapeSummary[] | null; onOpen: (s: InboxShapeSummary) => void }) {
  const [query, setQuery] = useState('');
  const items = useMemo(() => (shapes ?? []).filter((s) => s.state === 'active').map(shapeGridItem), [shapes]);
  const byId = useMemo(() => new Map((shapes ?? []).map((s) => [s.id, s])), [shapes]);
  const headingRef = useRef<HTMLHeadingElement>(null);
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
          assetUrl={inboxApi.shapeFileUrl}
          onOpen={(id) => {
            const s = byId.get(id);
            if (s) onOpen(s);
          }}
        />
      </div>
    </section>
  );
}
