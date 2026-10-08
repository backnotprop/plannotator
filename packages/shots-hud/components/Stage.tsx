/**
 * The marking canvas: one shot, large, with numbered boxes and their
 * comments, arrows and freehand strokes, and redactions. Everything is stored
 * in ORIGINAL image pixels; the display only scales.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Rect, Shot, ShotBox, ShotStroke } from '@plannotator/shared/shots/types';
import { Icon } from '../icons';

export type Tool = 'box' | 'arrow' | 'pen' | 'redact';

const MARKER = '#ff3b30';
const STROKE_DISPLAY_PX = 3.5;
const CARD_W = 236;
const MIN_DRAG = 6;
/** Room kept under the shot for its note field (the field is 30 px, 10 px off the bottom). */
const NOTE_ROOM = 32;
const NOTE_MIN_W = 320;

interface Props {
  shot: Shot;
  imageUrl: string | null;
  tool: Tool;
  selectedId: string | null;
  editingBoxId: string | null;
  /** The note field, so N and the rail button can focus it. */
  noteRef?: React.Ref<HTMLTextAreaElement>;
  /** Width covered on the right (the Ask pane): the shot fits in what is left. */
  reserveRight?: number;
  /** The stage image's rect in the window, for the capture flight. */
  imageRef?: React.Ref<HTMLDivElement>;
  onSelect: (id: string | null) => void;
  onCreateBox: (rect: Rect) => void;
  onEditBox: (id: string | null) => void;
  onComment: (box: ShotBox, comment: string) => void;
  onCancelComment: (box: ShotBox) => void;
  onAddStroke: (stroke: ShotStroke) => void;
  onAddRedaction: (rect: Rect) => void;
  onNote: (note: string) => void;
  onAskAbout: (box: ShotBox) => void;
}

interface Draft {
  kind: 'box' | 'redact' | 'arrow' | 'pen';
  start: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
}

function rectFrom(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y)];
}

function strokePath(stroke: Pick<ShotStroke, 'points'>): string {
  return stroke.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

function ArrowMark({ stroke, scale }: { stroke: ShotStroke; scale: number }) {
  const a = stroke.points[0]!;
  const b = stroke.points[stroke.points.length - 1]!;
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const head = Math.max(10 / scale, stroke.size * 4);
  const tip = (delta: number) => `${b.x - head * Math.cos(angle + delta)},${b.y - head * Math.sin(angle + delta)}`;
  return (
    <g stroke={stroke.color} fill={stroke.color} strokeWidth={stroke.size} strokeLinecap="round">
      <line x1={a.x} y1={a.y} x2={b.x - Math.cos(angle) * head * 0.6} y2={b.y - Math.sin(angle) * head * 0.6} />
      <polygon points={`${b.x},${b.y} ${tip(-Math.PI / 7)} ${tip(Math.PI / 7)}`} stroke="none" />
    </g>
  );
}

export function Stage(props: Props) {
  const { shot, imageUrl, tool, selectedId, editingBoxId } = props;
  const stageRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const draftRef = useRef<Draft | null>(null);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Fit the shot, leaving room on the right for comment cards when the shot is tall enough to allow it.
  const layout = useMemo(() => {
    const H = size.height - NOTE_ROOM;
    const W = size.width - (props.reserveRight ?? 0);
    if (W <= 0 || !H) return null;
    const pad = 22;
    const ow = shot.original.width;
    const oh = shot.original.height;
    const roomForCards = W - CARD_W - 40;
    const fitWith = (maxW: number) => Math.min(maxW / ow, (H - pad * 2) / oh, 1);
    let scale = fitWith(W - pad * 2);
    let left = (W - ow * scale) / 2;
    const narrower = fitWith(roomForCards - pad);
    if (!props.reserveRight && narrower >= scale * 0.72) {
      scale = narrower;
      left = Math.max(pad, (roomForCards - ow * scale) / 2);
    }
    const width = ow * scale;
    const height = oh * scale;
    return { scale, left, top: (H - height) / 2, width, height };
  }, [size, shot.original.width, shot.original.height, props.reserveRight]);

  const toOriginal = (event: React.PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const scale = layout!.scale;
    return {
      x: Math.max(0, Math.min(shot.original.width, (event.clientX - rect.left) / scale)),
      y: Math.max(0, Math.min(shot.original.height, (event.clientY - rect.top) / scale)),
    };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (!layout || event.button !== 0) return;
    // No compatibility mousedown: it would move focus off a comment field opened by this press.
    event.preventDefault();
    const target = event.target as HTMLElement;
    const hit = target.closest('[data-mark-id]') as HTMLElement | null;
    if (hit && (tool === 'box' || tool === 'redact')) {
      const id = hit.dataset.markId!;
      props.onSelect(id);
      if (hit.dataset.markKind === 'box') props.onEditBox(id);
      return;
    }
    props.onEditBox(null);
    const point = toOriginal(event);
    const next: Draft = { kind: tool, start: point, points: [point] };
    draftRef.current = next;
    setDraft(next);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const current = draftRef.current;
    if (!current) return;
    const point = toOriginal(event);
    const next = { ...current, points: current.kind === 'pen' ? [...current.points, point] : [current.start, point] };
    draftRef.current = next;
    setDraft(next);
  };

  const onPointerUp = () => {
    const current = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!current || !layout) return;
    const end = current.points[current.points.length - 1]!;
    const dragged = Math.hypot(end.x - current.start.x, end.y - current.start.y) * layout.scale;
    if (dragged < MIN_DRAG) {
      props.onSelect(null);
      return;
    }
    const strokeSize = STROKE_DISPLAY_PX / layout.scale;
    if (current.kind === 'box') props.onCreateBox(rectFrom(current.start, end));
    else if (current.kind === 'redact') props.onAddRedaction(rectFrom(current.start, end));
    else
      props.onAddStroke({
        id: crypto.randomUUID(),
        tool: current.kind === 'arrow' ? 'arrow' : 'pen',
        color: MARKER,
        size: strokeSize,
        points: current.points.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),
      });
  };

  // Comment cards: beside their box, stacked so they never overlap.
  const cards = useMemo(() => {
    if (!layout) return [];
    const { scale, left, top } = layout;
    const placed: Array<{ box: ShotBox; x: number; y: number }> = [];
    const sorted = [...shot.boxes].filter((box) => box.comment.trim() || box.id === editingBoxId).sort((a, b) => a.rect[1] - b.rect[1]);
    let floor = 8;
    for (const box of sorted) {
      const [bx, by, bw] = box.rect;
      const right = left + (bx + bw) * scale + 14;
      const leftSide = left + bx * scale - CARD_W - 14;
      const x = right + CARD_W <= size.width - 8 ? right : leftSide >= 8 ? leftSide : Math.max(8, size.width - CARD_W - 8);
      const estimate = heights[box.id] ?? 44 + Math.ceil(Math.max(1, box.comment.length) / 34) * 17 + (box.id === editingBoxId ? 20 : 0);
      const y = Math.max(floor, Math.min(size.height - NOTE_ROOM - estimate - 8, top + by * scale - 14));
      floor = y + estimate + 6;
      placed.push({ box, x, y });
    }
    return placed;
  }, [layout, shot.boxes, editingBoxId, size.width, size.height, heights]);

  // Measure the cards as rendered, so the stacking uses their real heights.
  useLayoutEffect(() => {
    const next: Record<string, number> = {};
    let changed = false;
    for (const [id, element] of cardRefs.current) {
      next[id] = element.offsetHeight;
      if (heights[id] !== next[id]) changed = true;
    }
    if (changed) setHeights(next);
  });

  const draftRect = draft && (draft.kind === 'box' || draft.kind === 'redact') ? rectFrom(draft.start, draft.points[draft.points.length - 1]!) : null;

  return (
    <div ref={stageRef} className={`stage tool-${tool}`}>
      {layout && (
        <div
          ref={props.imageRef}
          className="stage-surface"
          style={{ left: layout.left, top: layout.top, width: layout.width, height: layout.height }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {imageUrl && <img className="shot-img" src={imageUrl} alt={`Shot: ${shot.source?.app ?? 'screenshot'}`} draggable={false} />}
          {shot.redactions.map((redaction) => {
            const [x, y, w, h] = redaction.rect;
            return (
              <div
                key={redaction.id}
                data-mark-id={redaction.id}
                data-mark-kind="redaction"
                className={`redaction${selectedId === redaction.id ? ' selected' : ''}`}
                style={{ left: x * layout.scale, top: y * layout.scale, width: w * layout.scale, height: h * layout.scale }}
                aria-label="Redacted area"
              />
            );
          })}
          <svg className="marks" viewBox={`0 0 ${shot.original.width} ${shot.original.height}`} preserveAspectRatio="none">
            {[...shot.strokes, ...(draft && (draft.kind === 'pen' || draft.kind === 'arrow') ? [{ id: 'draft', tool: draft.kind, color: MARKER, size: STROKE_DISPLAY_PX / layout.scale, points: draft.points } as ShotStroke] : [])].map((stroke) =>
              stroke.tool === 'arrow' && stroke.points.length >= 2 ? (
                <ArrowMark key={stroke.id} stroke={stroke} scale={layout.scale} />
              ) : (
                <path key={stroke.id} d={strokePath(stroke)} stroke={stroke.color} strokeWidth={stroke.size} fill="none" strokeLinecap="round" strokeLinejoin="round" />
              ),
            )}
          </svg>
          {shot.boxes.map((box) => {
            const [x, y, w, h] = box.rect;
            return (
              <div
                key={box.id}
                data-mark-id={box.id}
                data-mark-kind="box"
                className={`box${selectedId === box.id ? ' selected' : ''}`}
                style={{ left: x * layout.scale - 2, top: y * layout.scale - 2, width: w * layout.scale + 4, height: h * layout.scale + 4 }}
                role="img"
                aria-label={`Box ${box.n}${box.comment ? `: ${box.comment}` : ''}`}
              >
                <span className="mk">{box.n}</span>
              </div>
            );
          })}
          {draftRect && (
            <div
              className={draft!.kind === 'redact' ? 'redaction' : 'box drafting'}
              style={{ left: draftRect[0] * layout.scale, top: draftRect[1] * layout.scale, width: draftRect[2] * layout.scale, height: draftRect[3] * layout.scale }}
            />
          )}
        </div>
      )}
      {!props.reserveRight && cards.map(({ box, x, y }) => (
        <CommentCard
          key={box.id}
          cardRef={(element) => {
            if (element) cardRefs.current.set(box.id, element);
            else cardRefs.current.delete(box.id);
          }}
          box={box}
          x={x}
          y={y}
          editing={box.id === editingBoxId}
          onEdit={() => {
            props.onSelect(box.id);
            props.onEditBox(box.id);
          }}
          onSave={(text) => props.onComment(box, text)}
          onCancel={() => props.onCancelComment(box)}
          onAsk={() => props.onAskAbout(box)}
        />
      ))}
      {layout && (
        <ShotNote
          key={shot.id}
          noteRef={props.noteRef}
          value={shot.note}
          onChange={props.onNote}
          // A caption under the shot: as wide as the image, never narrower than a sentence.
          style={(() => {
            const room = size.width - (props.reserveRight ?? 0);
            const width = Math.min(room - 24, Math.max(layout.width, NOTE_MIN_W));
            const left = Math.max(12, Math.min(room - 12 - width, layout.left + layout.width / 2 - width / 2));
            return { left, width };
          })()}
        />
      )}
    </div>
  );
}

function CommentCard(props: {
  cardRef: (element: HTMLDivElement | null) => void;
  box: ShotBox;
  x: number;
  y: number;
  editing: boolean;
  onEdit: () => void;
  onSave: (text: string) => void;
  onCancel: () => void;
  onAsk: () => void;
}) {
  const { box, editing } = props;
  const [text, setText] = useState(box.comment);
  const ref = useRef<HTMLTextAreaElement>(null);
  // Leaving the card any other way (a click elsewhere, the panel collapsing) keeps what was typed.
  const latest = useRef({ text, comment: box.comment, onSave: props.onSave, cancelled: false });
  latest.current.text = text;
  latest.current.comment = box.comment;
  latest.current.onSave = props.onSave;
  useEffect(() => {
    if (!editing) return;
    latest.current.cancelled = false;
    return () => {
      const { text: typed, comment, onSave, cancelled } = latest.current;
      if (!cancelled && typed.trim() !== comment) onSave(typed.trim());
    };
  }, [editing]);
  // Focus synchronously: keys typed right after the drag must land here, never on the tool shortcuts.
  useLayoutEffect(() => {
    if (!editing) return;
    setText(box.comment);
    const element = ref.current;
    if (element) {
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    }
  }, [editing, box.comment]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) {
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [text, editing]);
  return (
    <div ref={props.cardRef} className={`cmt glass${editing ? ' editing' : ''}`} style={{ left: props.x, top: props.y }} onPointerDown={(e) => e.stopPropagation()} onClick={editing ? undefined : props.onEdit}>
      <i className="cmt-n" aria-hidden="true">{box.n}</i>
      {editing ? (
        <>
          <textarea
            ref={ref}
            autoFocus
            rows={1}
            value={text}
            placeholder="Comment"
            aria-label={`Comment for box ${box.n}`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                latest.current.cancelled = true;
                props.onSave(text.trim());
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                latest.current.cancelled = true;
                props.onCancel();
              } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
                event.preventDefault();
                event.stopPropagation();
                props.onSave(text.trim());
                props.onAsk();
              } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                // ⌘↩ sends everything: keep what was typed first.
                props.onSave(text.trim());
              } else {
                event.stopPropagation();
              }
            }}
            onBlur={() => {
              if (text.trim() !== box.comment) props.onSave(text.trim());
            }}
          />
        </>
      ) : (
        <div className="body">{box.comment}</div>
      )}
    </div>
  );
}

/**
 * The note on the whole image: always there under the shot, saved as it is
 * typed (like the box comments, it travels with the shot). Enter or Esc leaves
 * the field; ⇧↩ starts a new line. Keys typed here never reach the HUD's
 * shortcuts, except the ⌘ ones (⌘↩ sends with the note in it).
 */
function ShotNote(props: { noteRef?: React.Ref<HTMLTextAreaElement>; value: string; onChange: (value: string) => void; style: React.CSSProperties }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const setRef = (element: HTMLTextAreaElement | null) => {
    ref.current = element;
    const outer = props.noteRef;
    if (typeof outer === 'function') outer(element);
    else if (outer) (outer as React.MutableRefObject<HTMLTextAreaElement | null>).current = element;
  };
  // Grows upward with the text (a few lines), so the shot never jumps while you type.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 88)}px`;
  }, [props.value]);
  const has = props.value.trim().length > 0;
  return (
    <div className={`shot-note${has ? ' has' : ''}`} style={props.style} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={setRef}
        rows={1}
        value={props.value}
        placeholder="Note on this image"
        aria-label="Note on this image"
        spellCheck
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey) return;
          event.stopPropagation();
          if ((event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) || event.key === 'Escape') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        onBlur={(event) => {
          if (event.currentTarget.value !== event.currentTarget.value.trim()) props.onChange(event.currentTarget.value.trim());
        }}
      />
      {has && (
        <button type="button" className="shot-note-x" aria-label="Remove the note" title="Remove the note" onClick={() => props.onChange('')}>
          <Icon name="close" size={11} />
        </button>
      )}
    </div>
  );
}
