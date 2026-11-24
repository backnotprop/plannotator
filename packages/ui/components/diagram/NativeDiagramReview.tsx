import type { DiagramPart } from '@plannotator/diagrams';
import { MessageCircleQuestion, Paperclip } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { REF_CARD_CLOSE_MS, REF_CARD_DELAY_MS } from '../RefHoverCard';
import { DiagramCanvas, type DiagramCanvasHandle } from './DiagramCanvas';
import { AskDrawer, CloseButton, FloatingCard, RefActions, ReferenceDetails, TextEditor, type SubmitResult } from './NativeDiagramCard';
import {
  anchorOnPart, partKey, placeCommentPins, reviewSvg, screenRect,
  type NativeDiagramAnchor, type NativeDiagramComment, type NativeDiagramDrawing, type NativeDiagramFileReference,
} from './nativeDiagramDrawing';
import './nativeDiagramReview.css';

export type { NativeDiagramAnchor, NativeDiagramComment, NativeDiagramFileReference } from './nativeDiagramDrawing';

export interface NativeDiagramAskContext {
  title: string;
  description: string;
  question: string;
  assetId?: string;
  part?: DiagramPart;
}

export interface NativeDiagramReviewProps {
  source: string;
  comments?: readonly NativeDiagramComment[];
  /** The host owns the writing surface (for example, a native phone composer). */
  onRequestComment?: (anchor: NativeDiagramAnchor) => void;
  onCreateComment?: (anchor: NativeDiagramAnchor, text: string) => SubmitResult;
  onEditComment?: (id: string, text: string) => SubmitResult;
  onSelectComment?: (id: string | null) => void;
  selectedCommentId?: string | null;
  /** Share the current part between, for example, an inline drawing and its expanded view. */
  selectedPart?: NativeDiagramAnchor | null;
  onSelectPart?: (anchor: NativeDiagramAnchor | null) => void;
  onResolutionChange?: (resolution: ReadonlyMap<string, boolean>) => void;
  onAskAI?: (context: NativeDiagramAskContext) => SubmitResult;
  onOpenFile?: (ref: NativeDiagramFileReference) => void;
  inline?: boolean;
  className?: string;
}

interface Drawing {
  diagram: NativeDiagramDrawing;
  svg: SVGSVGElement;
  title: string;
  assetId?: string;
}
type Card = {
  anchor: NativeDiagramAnchor;
  mode: 'references' | 'write' | 'note';
  pinned: boolean;
  keyboard?: boolean;
  commentId?: string;
};
const NO_COMMENTS: readonly NativeDiagramComment[] = [];
const noop = () => {};
const BUBBLE = 'M13 1.1C6.55 1.1 1.4 5.83 1.4 11.62c0 3.62 2.02 6.8 5.08 8.68l-0.85 3.5 4.28-2.02c1.01 0.25 2.05 0.38 3.09 0.38 6.45 0 11.6-4.73 11.6-10.54C24.6 5.83 19.45 1.1 13 1.1Z';

export function NativeDiagramReview(props: NativeDiagramReviewProps) {
  return <Loader key={props.source} {...props} />;
}

function Loader(props: NativeDiagramReviewProps) {
  const descriptionId = useId();
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    let url: string | undefined;
    async function render() {
      try {
        const spec = JSON.parse(props.source);
        const { renderDiagram } = await import('@plannotator/diagrams');
        if (!live) return;
        const diagram = await renderDiagram(spec);
        if (!live) return;
        url = URL.createObjectURL(new Blob([diagram.svg], { type: 'image/svg+xml' }));
        setDrawing({ title: spec.title, assetId: spec.id, diagram, svg: reviewSvg(diagram, url) });
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void render();
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [props.source]);

  const parts = useMemo(() => new Map(drawing?.diagram.parts.map(p => [partKey(p), p])), [drawing]);
  const resolution = useMemo(() => new Map((props.comments ?? NO_COMMENTS).map(c => [c.id, parts.has(partKey(c.anchor))])), [parts, props.comments]);
  const reported = useRef<ReadonlyMap<string, boolean> | null>(null);
  useEffect(() => {
    // Wait for a verdict on this revision. Invalid source leaves all its saved comments unresolved.
    if (!drawing && !error) return;
    const last = reported.current;
    if (last?.size === resolution.size && [...resolution].every(([id, ok]) => last.get(id) === ok)) return;
    reported.current = resolution;
    props.onResolutionChange?.(resolution);
  }, [drawing, error, resolution, props.onResolutionChange]);

  return <section className={cn('ndr annotation-exclude', props.inline && 'ndr-inline', props.className)} aria-label={drawing?.title ?? 'Diagram'} aria-describedby={drawing ? descriptionId : undefined}>
    {drawing && <span className="sr-only" id={descriptionId}>{drawing.diagram.description}</span>}
    {drawing ? <ReviewSurface {...props} drawing={drawing} parts={parts} /> : error
      ? <div className="ndr-status" role="alert"><strong>Couldn’t draw the diagram</strong><p>{error}</p></div>
      : <div className="ndr-status" role="status">Drawing diagram…</div>}
  </section>;
}

function ReviewSurface({ drawing, parts, comments = NO_COMMENTS, onRequestComment, onCreateComment, onEditComment, onSelectComment, selectedCommentId,
  selectedPart, onSelectPart, onAskAI, onOpenFile, inline }: NativeDiagramReviewProps & { drawing: Drawing; parts: ReadonlyMap<string, DiagramPart> }) {
  const { diagram, svg, title, assetId } = drawing;
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<DiagramCanvasHandle | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState('');
  const drafts = useRef(new Map<string, string>());
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopTimers = useCallback(() => { clearTimeout(openTimer.current); clearTimeout(closeTimer.current); }, []);
  useEffect(() => stopTimers, [stopTimers]);

  const activePart = card ? parts.get(partKey(card.anchor)) : null;
  const selectedComment = card?.commentId ? comments.find(c => c.id === card.commentId) : undefined;
  function reveal(anchor: NativeDiagramAnchor) {
    const current = canvas.current;
    const part = parts.get(partKey(anchor));
    if (current && part) current.panIntoView(screenRect(part, current.viewport));
  }
  // Host echoes must keep an editor or pinned card the user already has open.
  const externalPartKey = selectedPart && JSON.stringify(selectedPart);
  useEffect(() => {
    if (selectedPart === undefined) return;
    if (!selectedPart || !parts.has(partKey(selectedPart))) { setCard(null); return; }
    reveal(selectedPart);
    setCard(prev => prev && partKey(prev.anchor) === partKey(selectedPart) ? prev :
      { anchor: selectedPart, mode: 'references', pinned: true });
  }, [externalPartKey, parts]);
  const fromRail = comments.find(c => c.id === selectedCommentId);
  useEffect(() => {
    if (!fromRail || !parts.has(partKey(fromRail.anchor))) return;
    reveal(fromRail.anchor);
    setCard(prev => prev?.commentId === fromRail.id ? prev : { anchor: fromRail.anchor, mode: 'note', pinned: true, commentId: fromRail.id });
  }, [selectedCommentId, fromRail?.id, parts]);
  useEffect(() => {
    if (card?.commentId && !selectedComment) setCard(null);
  }, [card?.commentId, selectedComment]);

  useEffect(() => {
    const index = activePart ? diagram.parts.indexOf(activePart) : -1;
    if (index < 0) return;
    const el = svg.querySelector(`[data-native-hit="${index}"]`);
    el?.setAttribute('data-selected', card?.pinned ? 'pinned' : 'preview');
    return () => el?.removeAttribute('data-selected');
  }, [activePart, card?.pinned, diagram, svg]);

  function close(restoreFocus = true) {
    stopTimers();
    if (restoreFocus && card) {
      const i = diagram.parts.findIndex(p => partKey(p) === partKey(card.anchor));
      const j = comments.findIndex(c => c.id === card.commentId);
      const selector = j >= 0 ? `[data-native-pin="${j}"]` : `[data-native-focus="${i}"]`;
      container.current?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    }
    setCard(null);
    setAsking(false);
    onSelectPart?.(null);
    onSelectComment?.(null);
  }
  function show(anchor: NativeDiagramAnchor, keyboard = false) {
    stopTimers();
    if (card?.pinned && !asking && card.mode === 'references' && partKey(card.anchor) === partKey(anchor)) { close(keyboard); return; }
    setAsking(false);
    setCard({ anchor, mode: 'references', pinned: true, keyboard });
    onSelectComment?.(null);
    onSelectPart?.(anchor);
  }
  function startComment() {
    if (!card) return;
    if (onRequestComment) {
      onRequestComment(card.anchor);
      setCard(null);
    } else {
      setCard({ ...card, mode: 'write' });
    }
  }
  function pin() {
    if (!card || card.pinned) return;
    setCard({ ...card, pinned: true });
    onSelectPart?.(card.anchor);
  }
  function schedulePreview(part: DiagramPart | undefined, anchor: NativeDiagramAnchor | undefined) {
    stopTimers();
    if (!part?.refs.length || !anchor || card?.pinned || asking) return;
    openTimer.current = setTimeout(() => setCard({ anchor, mode: 'references', pinned: false }), REF_CARD_DELAY_MS);
  }
  function leavePreview() {
    stopTimers();
    closeTimer.current = setTimeout(() => setCard(prev => prev?.pinned ? prev : null), REF_CARD_CLOSE_MS);
  }
  function showComment(comment: NativeDiagramComment) {
    stopTimers();
    if (card?.commentId === comment.id && !asking) { close(); return; }
    setAsking(false);
    setCard({ anchor: comment.anchor, mode: 'note', pinned: true, commentId: comment.id, keyboard: true });
    onSelectPart?.(comment.anchor);
    onSelectComment?.(comment.id);
  }
  function ask() { stopTimers(); pin(); setAsking(true); }
  function endAsk() {
    setAsking(false);
    if (!card) container.current?.querySelector<HTMLButtonElement>('[data-native-ask]')?.focus({ preventScroll: true });
    else setCard({ ...card, keyboard: true });
  }

  function pointerAnchor(part: DiagramPart, hit: Element, point?: { clientX: number; clientY: number }) {
    const imageRect = svg.getBoundingClientRect();
    if (!imageRect.width) return anchorOnPart(part, point, hit.getBoundingClientRect());
    const scale = imageRect.width / diagram.width;
    return anchorOnPart(part, point, new DOMRect(imageRect.x + part.x * scale, imageRect.y + part.y * scale, part.w * scale, part.h * scale));
  }

  function renderOverlay(handle: DiagramCanvasHandle) {
    canvas.current = handle;
    const { viewport, hostRef } = handle;
    const pins = placeCommentPins(comments, parts, viewport);
    const selectedPin = pins.find(p => p.comment.id === card?.commentId);
    const anchorRect = selectedPin ? { left: selectedPin.x - 13, top: selectedPin.y - 13, width: 26, height: 26 } :
      activePart ? screenRect(activePart, viewport) : null;
    const commentKey = JSON.stringify(['comment', activePart?.kind, activePart?.id, selectedComment?.id]);
    const askKey = JSON.stringify(['ask', activePart?.kind, activePart?.id]);
    return <>
      <div className="ndr-targets" role="group" aria-label="Parts of the diagram">
        {diagram.parts.map((part, i) => {
          const rect = screenRect(part, viewport);
          const label = `${part.kind} ${part.title}`;
          return <div key={partKey(part)}>
            <button type="button" data-native-focus={i} className="ndr-key-hit" style={rect} aria-label={label}
              aria-haspopup="dialog" aria-expanded={part === activePart}
              onClick={() => show(anchorOnPart(part), true)}
              onFocus={e => {
                if (e.currentTarget.matches(':focus-visible')) {
                  handle.panIntoView(rect);
                  schedulePreview(part, anchorOnPart(part));
                }
              }}
              onBlur={() => { if (!card?.pinned) leavePreview(); }}
              onKeyDown={e => {
                if (e.key === 'Escape' && card) { e.preventDefault(); e.stopPropagation(); close(); }
                if (e.key === 'Tab' && !e.shiftKey && part === activePart && !card?.pinned) {
                  const dialog = container.current?.querySelector<HTMLElement>('.ndr-card');
                  if (dialog) { e.preventDefault(); pin(); dialog.focus(); }
                }
              }} />
            {part.refs.length > 0 && createPortal(
              <g data-native-hit={i} data-native-ref-badge="" aria-hidden="true"
                transform={`translate(${part.x + part.w - 6 / viewport.scale} ${part.y + (viewport.scale < .78 ? -12 : 5) / viewport.scale}) scale(${1 / viewport.scale})`}>
                <rect x={-22 - String(part.refs.length).length * 6} width={22 + String(part.refs.length).length * 6} height={18} rx={9} />
                <Paperclip size={11} x={-18 - String(part.refs.length).length * 6} y={3.5} />
                <text x={-5} y={12.5} textAnchor="end">{part.refs.length}</text>
              </g>, svg)}
          </div>;
        })}
      </div>
      {pins.map(({ comment, part, x, y, index }) => <button type="button" key={comment.id} data-native-pin={index}
        className="ndr-bubble" style={{ left: x, top: y }} aria-label={`Comment ${comment.number ?? index + 1} on ${part.title}`}
        aria-expanded={card?.commentId === comment.id} onClick={() => showComment(comment)}>
        <svg viewBox="0 0 26 25" aria-hidden="true"><path d={BUBBLE} /></svg><span>{comment.number ?? index + 1}</span>
      </button>)}
      {onAskAI && !asking && <Button data-native-ask="" className="ndr-ask-button" variant="outline" onClick={ask}><MessageCircleQuestion />Ask AI</Button>}
      {card && activePart && anchorRect && !asking && <FloatingCard key={partKey(activePart) + (card.commentId ?? '')}
        anchor={anchorRect} host={hostRef.current} mode={card.mode} heading={card.mode === 'references' ? activePart.title : `Comment on ${activePart.title}`}
        pinned={card.pinned} keyboardOpen={!!card.keyboard} onClose={() => close()} onEnter={stopTimers} onLeave={leavePreview}>
        {card.mode === 'write' ? <TextEditor key={card.commentId ?? 'new'} initial={drafts.current.get(commentKey) ?? selectedComment?.text ?? ''}
          onChange={value => drafts.current.set(commentKey, value)}
          label={`Comment on ${activePart.title}`} original={selectedComment?.text}
          onSubmit={text => selectedComment ? onEditComment!(selectedComment.id, text) : onCreateComment!(card.anchor, text)}
          onCancel={() => { drafts.current.delete(commentKey); if (selectedComment) setCard({ ...card, mode: 'note' }); else close(); }}
          onDone={() => { drafts.current.delete(commentKey); setNotice(`Comment saved on ${activePart.title}`); close(); }} /> :
        card.mode === 'note' && selectedComment ? <div className="ndr-saved">
          <div className="ndr-note-heading">Comment {selectedComment.number ?? comments.indexOf(selectedComment) + 1}
            {onEditComment && <button type="button" onClick={() => setCard({ ...card, mode: 'write' })}>Edit</button>}</div>
          <p>{selectedComment.text}</p><CloseButton label="Close comment" onClick={() => close()} />
        </div> : <>
          <div className="ndr-card-head">
            <div className="ndr-meta">{activePart.kind}{activePart.refs.length > 0 && ` · ${activePart.refs.length} reference${activePart.refs.length === 1 ? '' : 's'}`}</div>
            <strong>{activePart.title}</strong>
            {activePart.summary && <p className="ndr-summary">{activePart.summary}</p>}
            {activePart.from && activePart.to && <div className="ndr-ends">{activePart.from} → {activePart.to}</div>}
          </div>
          <ReferenceDetails part={activePart} onOpenFile={onOpenFile} pin={pin} />
          {card.pinned && <>
            <CloseButton label="Close references" onClick={() => close()} />
            <RefActions onComment={onCreateComment || onRequestComment ? startComment : undefined} onAsk={onAskAI ? ask : undefined} />
          </>}
        </>}
      </FloatingCard>}
      {asking && onAskAI && <AskDrawer title={title} part={activePart ?? undefined} onClose={endAsk}>
        <TextEditor ask initial={drafts.current.get(askKey) ?? ''} label="Question about the diagram" onCancel={endAsk}
          onChange={value => drafts.current.set(askKey, value)} onDone={() => { drafts.current.delete(askKey); endAsk(); }}
          onSubmit={question => onAskAI({ question, title, assetId, description: diagram.description, part: activePart ?? undefined })} />
      </AskDrawer>}
      <span className="sr-only" role="status">{notice}</span>
    </>;
  }

  return <div ref={container} className="ndr-surface"
    onPointerOver={e => {
      if (e.pointerType === 'touch' || e.buttons) return;
      const hit = e.target instanceof Element && e.target.closest('[data-native-hit]');
      if (!hit) return;
      const part = diagram.parts[Number(hit.getAttribute('data-native-hit'))];
      schedulePreview(part, part && pointerAnchor(part, hit, e));
    }}
    onPointerOut={e => { if (e.target instanceof Element && e.target.closest('[data-native-hit]')) leavePreview(); }}
    onPointerDownCapture={stopTimers}>
    <DiagramCanvas svgNode={svg} dimmed={false} targetSelector="[data-native-hit]" onSvgRoot={noop} onHoverElement={noop}
      wheelZoom={inline ? 'modifier' : 'always'} className={inline ? undefined : 'touch-none'} showZoomPercent
      ariaLabel={`Diagram canvas. Drag or use arrow keys to pan. ${inline ? 'Pinch' : 'Scroll'} or use plus and minus to zoom. Press 0 to fit. Tab to a part to review it.`}
      onClickElement={(hit, _, point) => {
        if (!hit) { if (card || asking) close(false); return; }
        const part = diagram.parts[Number(hit.getAttribute('data-native-hit'))];
        if (part) show(pointerAnchor(part, hit, point));
      }}
      onEscape={() => {
        if (!card && !asking) return 'pass';
        if (asking) endAsk(); else close();
        return 'consumed';
      }} overlay={renderOverlay} />
  </div>;
}
