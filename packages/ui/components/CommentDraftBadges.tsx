/**
 * Visible comment drafts (opt-in, `configurePlannotatorUI({ visibleCommentDrafts })`): a floating "Draft" badge just
 * under the end of each set of words whose comment was closed with words in it. The badge sits on top of the text,
 * never in it: it is absolutely placed in the document's column, so no line moves, and it stays inside the column.
 * A press opens the comment again with its words.
 *
 * The word is drawn by CSS (`content: attr(data-label)`), so the badge adds no text to the document: a text search,
 * a copy or a restore never meets it. Styles: `comment-card.css`.
 */
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type Highlighter from '@plannotator/web-highlighter';
import type { CommentPopoverState } from '../hooks/useAnnotationHighlighter';
import { Icon } from './inbox-thread/icons';

/** How far the badge's start sits back from the words' end, and how far it rises into the line gap. */
const BACK = 10;
const RISE = 3;
const FALLBACK_WIDTH = 56;

interface Placed { id: string; left: number; top: number; quote: string }

function quoteOf(draft: CommentPopoverState): string {
  const text = (draft.selectedText ?? draft.contextText).replace(/\s+/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function CommentDraftBadges({
  drafts,
  highlighterRef,
  containerRef,
  onOpen,
}: {
  drafts: readonly CommentPopoverState[];
  highlighterRef: RefObject<Highlighter | null>;
  containerRef: RefObject<HTMLElement | null>;
  onOpen: (id: string) => void;
}) {
  const [placed, setPlaced] = useState<Placed[]>([]);
  const widthRef = useRef<number>(FALLBACK_WIDTH);
  const layerRef = useRef<HTMLSpanElement | null>(null);
  /** The badge that opened the comment now open: when it closes again with its words, focus comes back to it. */
  const openedFrom = useRef<string | null>(null);

  const place = useCallback(() => {
    const container = containerRef.current;
    const highlighter = highlighterRef.current;
    if (!container || !highlighter || drafts.length === 0) {
      setPlaced((prev) => (prev.length ? [] : prev));
      return;
    }
    const box = container.getBoundingClientRect();
    const cs = getComputedStyle(container);
    const colLeft = parseFloat(cs.paddingLeft) || 0;
    const colRight = container.clientWidth - (parseFloat(cs.paddingRight) || 0);
    const measured = layerRef.current?.querySelector<HTMLElement>('[data-comment-draft-badge]')?.offsetWidth;
    if (measured) widthRef.current = measured;
    const width = widthRef.current;
    const next: Placed[] = [];
    for (const draft of drafts) {
      const id: string | undefined = draft.source?.id;
      if (!id) continue;
      let doms: HTMLElement[] = [];
      try { doms = (highlighter.getDoms(id) as HTMLElement[] | undefined) ?? []; } catch { doms = []; }
      const rects = doms.filter((el) => el.isConnected).flatMap((el) => [...el.getClientRects()]).filter((r) => r.width > 0);
      if (!rects.length) continue;
      // The end of the words: the lowest line's rightmost piece.
      const bottom = Math.max(...rects.map((r) => r.bottom));
      const last = rects.filter((r) => r.bottom >= bottom - 2).reduce((a, b) => (b.right > a.right ? b : a));
      const left = Math.max(colLeft, Math.min(last.right - box.left - BACK, colRight - width));
      next.push({ id, left: Math.round(left), top: Math.round(last.bottom - box.top - RISE), quote: quoteOf(draft) });
    }
    setPlaced((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [containerRef, drafts, highlighterRef]);

  useLayoutEffect(() => {
    place();
    const container = containerRef.current;
    if (!container) return;
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    observer?.observe(container);
    void document.fonts?.ready.then(() => place());
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [containerRef, place]);
  // Measured once drawn: the real width keeps a badge at a line's end inside the column.
  useLayoutEffect(() => {
    const measured = layerRef.current?.querySelector<HTMLElement>('[data-comment-draft-badge]')?.offsetWidth;
    if (measured && measured !== widthRef.current) place();
  }, [placed, place]);
  // Back from the comment a badge opened (Escape, the chevron): its badge is drawn anew, and focus, left on the page
  // as the box went, goes to it. Focus the person put somewhere else stays there.
  useLayoutEffect(() => {
    const id = openedFrom.current;
    if (!id || !placed.some((p) => p.id === id)) return;
    openedFrom.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    layerRef.current?.querySelector<HTMLElement>(`[data-comment-draft-badge="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }, [placed]);

  if (placed.length === 0) return null;
  return (
    <span ref={layerRef} className="pn-cdraft-layer" data-comment-draft-layer="" data-print-hide="">
      {placed.map((p) => (
        <button
          key={p.id}
          type="button"
          className="pn-cdraft"
          style={{ left: p.left, top: p.top }}
          data-comment-draft-badge={p.id}
          data-label="Draft"
          aria-label={p.quote ? `Draft comment on “${p.quote}”, not sent. Open it` : 'Draft comment, not sent. Open it'}
          title="Your comment, not sent. Open it"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            openedFrom.current = p.id;
            onOpen(p.id);
          }}
        >
          <Icon name="compose" size={10} />
        </button>
      ))}
    </span>
  );
}
