/**
 * One object on the board, as DOM. Each is memoised on the object itself:
 * the reducer keeps an untouched object's identity, so a change to one
 * object re-renders one of these, however many are mounted.
 */
import { File, FileCode, FileText, Film, Globe, Image as ImageIcon } from 'lucide-react';
import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CanvasColor } from '../model/color';
import { HTML_ITEM_FRAME_ATTRS, HTML_ITEM_SANDBOX, htmlItemSrcdoc, isSafeImageSrc } from '../model/html-item';
import { referenceCard } from '../model/reference';
import type { ArrowObject, ArtifactKind, BoxObject, BoxShape, HtmlObject, ImageObject, PlacedCanvasObject, ReferenceObject, SpriteObject } from '../model/types';
import { CONTAINER_HEADER, type ShapeOutline, shapeOutline, toPath } from '../view/shape-outline';

export interface ObjectViewProps {
  object: PlacedCanvasObject;
  selected: boolean;
  /** The text is being typed into. */
  editing: boolean;
  /** Embedded HTML and sprites are drawn only when there is room to see them. */
  rich: boolean;
  resolveImageSrc?: (src: string) => string;
  onEditEnd?: (id: string, text: string) => void;
  /**
   * Present in an editor: the object can take focus. 0 for the one object Tab lands on from outside the board,
   * -1 for the rest (the editor moves focus between them in reading order). Absent: not focusable (a figure).
   */
  tabIndex?: 0 | -1;
}

/** `data-color` and, for a custom colour, the variable the stylesheet reads. */
export function colorAttrs(color: CanvasColor | undefined): { 'data-color'?: string; style?: React.CSSProperties } {
  if (!color) return {};
  if (typeof color === 'string') return { 'data-color': color };
  return { 'data-color': 'custom', style: { ['--pcv-custom' as string]: color.custom } };
}

function Words({ id, text, editing, className, onEditEnd }: { id: string; text: string; editing: boolean; className?: string; onEditEnd?: (id: string, text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [editing]);
  if (!editing) {
    return (
      <div key="view" className={className ? `pcv-words ${className}` : 'pcv-words'} dir="auto">
        {text}
      </div>
    );
  }
  return (
    // A different key from the view above: when typing ends the node is replaced, so words the document did not
    // keep (a refused edit) are never left on screen.
    <div
      key="edit"
      ref={ref}
      className={className ? `pcv-words ${className}` : 'pcv-words'}
      dir="auto"
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      // Typing ends when focus leaves, never on Enter: Enter is a new line,
      // and an IME uses it to choose a candidate.
      onBlur={(event) => onEditEnd?.(id, event.currentTarget.innerText.replace(/\n$/, ''))}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {text}
    </div>
  );
}

function Picture({ object, resolveImageSrc }: { object: ImageObject; resolveImageSrc?: (src: string) => string }) {
  const [failed, setFailed] = useState(false);
  // The stored reference is resolved first; what the browser is then asked to load is checked.
  const resolved = resolveImageSrc ? resolveImageSrc(object.src) : object.src;
  const src = isSafeImageSrc(resolved) ? resolved : null;
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <div className="pcv-missing">{object.alt}</div>;
  return <img src={src} alt={object.alt} draggable={false} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function spriteStyle(object: SpriteObject, resolveImageSrc?: (src: string) => string): React.CSSProperties {
  const src = resolveImageSrc ? resolveImageSrc(object.src) : object.src;
  return {
    backgroundImage: `url(${JSON.stringify(src)})`,
    ['--pcv-frames' as string]: object.frames,
    ['--pcv-fps' as string]: object.fps,
    ['--pcv-sprite-w' as string]: `${object.w}px`,
  };
}

/** The only way custom HTML is ever drawn. See `model/html-item.ts`. */
function HtmlFrame({ object }: { object: HtmlObject }) {
  const probe = useRef<HTMLSpanElement>(null);
  const [scheme, setScheme] = useState<'light' | 'dark' | null | undefined>(undefined);
  // The item is told the theme it sits in, and told again when it changes.
  useLayoutEffect(() => {
    const read = () => {
      const value = probe.current?.parentElement ? getComputedStyle(probe.current.parentElement).colorScheme : '';
      setScheme(value === 'dark' || value === 'light' ? value : null);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  // The frame is mounted once its theme is known, so an item is loaded once, not once per guess.
  return (
    <>
      <span ref={probe} hidden />
      {scheme !== undefined ? <iframe title={object.alt ?? ''} sandbox={HTML_ITEM_SANDBOX} srcDoc={htmlItemSrcdoc(object.html, scheme)} {...HTML_ITEM_FRAME_ATTRS} /> : null}
    </>
  );
}

/** The words a card shows for what kind of thing it points at, when the thing has no site of its own. */
export const REFERENCE_STRINGS = {
  plan: 'Plan',
  artifact: { image: 'Image', html: 'HTML page', markdown: 'Markdown', text: 'Text', video: 'Video', file: 'File' } satisfies Record<ArtifactKind, string>,
} as const;

const ARTIFACT_GLYPHS: Record<ArtifactKind, React.ComponentType> = { image: ImageIcon, html: FileCode, markdown: FileText, text: FileText, video: Film, file: File };

/** A picture that takes no room and makes no noise when it cannot load. */
function CardPicture({ src, className, resolveImageSrc }: { src: string; className: string; resolveImageSrc?: (src: string) => string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const resolved = resolveImageSrc ? resolveImageSrc(src) : src;
  if (failed || !isSafeImageSrc(resolved)) return null;
  return <img className={className} src={resolved} alt="" draggable={false} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

/**
 * A reference card. Everything it shows is text and pictures from the
 * object: nothing is fetched here, and nothing in it is markup.
 */
function Card({ object, resolveImageSrc }: { object: ReferenceObject; resolveImageSrc?: (src: string) => string }) {
  const card = referenceCard(object);
  const { target } = object;
  const Glyph = target.kind === 'web' ? Globe : target.kind === 'plan' ? FileText : ARTIFACT_GLYPHS[target.artifactKind];
  const source = card.site || (target.kind === 'plan' ? REFERENCE_STRINGS.plan : target.kind === 'artifact' ? REFERENCE_STRINGS.artifact[target.artifactKind] : '');
  return (
    <>
      {card.image ? <CardPicture src={card.image} className="pcv-card-image" resolveImageSrc={resolveImageSrc} /> : null}
      <div className="pcv-card-body">
        <div className="pcv-card-source">
          <span className="pcv-card-icon">
            <Glyph />
            {card.icon ? <CardPicture src={card.icon} className="pcv-card-favicon" resolveImageSrc={resolveImageSrc} /> : null}
          </span>
          <span className="pcv-words pcv-card-site" dir="auto">{source}</span>
        </div>
        <div className="pcv-words pcv-card-title" dir="auto">{card.title}</div>
        {card.description ? <div className="pcv-words pcv-card-description" dir="auto">{card.description}</div> : null}
      </div>
    </>
  );
}

/** What each box shape is called, for someone who cannot see its outline. */
export const SHAPE_NAMES: Record<BoxShape, string> = {
  process: 'Box',
  decision: 'Decision',
  database: 'Database',
  document: 'Document',
  queue: 'Queue',
  actor: 'Actor',
  cloud: 'Cloud',
  pill: 'Start or end',
  container: 'Container',
};

/** Outlines as path strings, kept by shape and size: a move reuses them, and so does every figure of the same object. */
const PATHS = new Map<string, { outline: string; details: string[]; text: ShapeOutline['text'] }>();

function shapePaths(shape: BoxShape, w: number, h: number, lanes: number) {
  const key = `${shape}|${w}|${h}|${lanes}`;
  let hit = PATHS.get(key);
  if (!hit) {
    const made = shapeOutline(shape, w, h, lanes);
    hit = { outline: toPath(made.outline), details: made.details.map(toPath), text: made.text };
    if (PATHS.size > 4000) PATHS.clear();
    PATHS.set(key, hit);
  }
  return hit;
}

/**
 * A box drawn as its shape: the outline is one small SVG, the words stay
 * HTML on top of it, so they wrap, can be typed into and are read out.
 */
function ShapedBox({ object, editing, onEditEnd }: { object: BoxObject; editing: boolean; onEditEnd?: (id: string, text: string) => void }) {
  const shape = object.shape ?? 'process';
  const lanes = shape === 'container' ? (object.lanes ?? []) : [];
  const paths = shapePaths(shape, object.w, object.h, lanes.length);
  const [top, right, bottom, left] = paths.text;
  return (
    <>
      <svg className="pcv-shape-svg" width={object.w} height={object.h} viewBox={`0 0 ${object.w} ${object.h}`} aria-hidden="true" focusable="false">
        <path className="pcv-shape-fill" d={paths.outline} />
        {paths.details.map((d, i) => (
          <path key={i} className="pcv-shape-line" d={d} />
        ))}
      </svg>
      <div className="pcv-shape-text" style={{ padding: `${top}px ${right}px ${bottom}px ${left}px` }}>
        <Words id={object.id} text={object.text} editing={editing} className="pcv-box-text" onEditEnd={onEditEnd} />
        {object.detail && !editing && shape !== 'container' && shape !== 'actor' ? <div className="pcv-words pcv-box-detail" dir="auto">{object.detail}</div> : null}
      </div>
      {lanes.length ? (
        <div className="pcv-lanes" style={{ top: CONTAINER_HEADER }} aria-hidden="true">
          {lanes.map((lane, i) => (
            <div key={i} className="pcv-lane">
              <span>{lane}</span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** What an object is called when it has no words of its own. */
export const OBJECT_NAMES = { box: 'Box', note: 'Note', text: 'Text', frame: 'Frame', image: 'Image', sprite: 'Animation', html: 'Embedded content', reference: 'Card' } as const;

/** What a screen reader says for an object: its own words, else what it is. */
export function objectLabel(object: PlacedCanvasObject): string {
  const words =
    object.type === 'frame' ? object.title : object.type === 'reference' ? referenceCard(object).title : 'text' in object ? object.text : 'alt' in object ? (object.alt ?? '') : '';
  const line = words.split('\n')[0].trim();
  const name = object.type === 'box' && object.shape ? SHAPE_NAMES[object.shape] : OBJECT_NAMES[object.type];
  const lanes = object.type === 'box' && object.lanes?.length ? ` (${object.lanes.join(', ')})` : '';
  return line ? `${name}: ${line}${lanes}` : `${name}${lanes}`;
}

export const ObjectView = memo(function ObjectView({ object, selected, editing, rich, resolveImageSrc, onEditEnd, tabIndex }: ObjectViewProps) {
  const color = colorAttrs(object.color);
  const style: React.CSSProperties = {
    ...color.style,
    transform: `translate(${object.x}px, ${object.y}px)`,
    width: object.w,
    height: object.h,
  };
  const common = {
    'data-id': object.id,
    'data-color': color['data-color'],
    'data-selected': selected ? '' : undefined,
    // In an editor each object is something focus can land on, named by its words.
    ...(tabIndex !== undefined ? { tabIndex, role: 'group', 'aria-label': objectLabel(object) } : {}),
  };
  switch (object.type) {
    case 'box':
      if (object.shape && object.shape !== 'process') {
        return (
          <div className="pcv-obj pcv-shape" {...common} data-shape={object.shape} data-dash={object.style?.dash ? '' : undefined} data-fill={object.style?.fill} style={style}>
            <ShapedBox object={object} editing={editing} onEditEnd={onEditEnd} />
          </div>
        );
      }
      return (
        <div className="pcv-obj pcv-box" {...common} style={style}>
          <Words id={object.id} text={object.text} editing={editing} className="pcv-box-text" onEditEnd={onEditEnd} />
          {object.detail && !editing ? <div className="pcv-words pcv-box-detail" dir="auto">{object.detail}</div> : null}
        </div>
      );
    case 'note':
      return (
        <div className="pcv-obj pcv-note" {...common} style={style}>
          <Words id={object.id} text={object.text} editing={editing} onEditEnd={onEditEnd} />
        </div>
      );
    case 'text':
      return (
        <div className="pcv-obj pcv-text" {...common} data-size={object.size} style={style}>
          <Words id={object.id} text={object.text} editing={editing} onEditEnd={onEditEnd} />
        </div>
      );
    case 'frame':
      return (
        <div className="pcv-obj pcv-frame" {...common} style={style}>
          <Words id={object.id} text={object.title} editing={editing} className="pcv-frame-title" onEditEnd={onEditEnd} />
        </div>
      );
    case 'image':
      return (
        <div className="pcv-obj pcv-image" {...common} style={style}>
          <Picture object={object} resolveImageSrc={resolveImageSrc} />
        </div>
      );
    case 'sprite':
      return isSafeImageSrc(resolveImageSrc ? resolveImageSrc(object.src) : object.src) ? (
        <div className="pcv-obj pcv-sprite" {...common} {...(tabIndex === undefined ? { role: 'img', 'aria-label': object.alt } : {})} style={{ ...style, ...spriteStyle(object, resolveImageSrc) }} />
      ) : (
        <div className="pcv-obj pcv-sprite" {...common} style={{ ...style, animation: 'none' }}>
          <div className="pcv-missing">{object.alt}</div>
        </div>
      );
    case 'reference':
      return (
        <div className="pcv-obj pcv-card" {...common} data-target={object.target.kind} style={style}>
          <Card object={object} resolveImageSrc={resolveImageSrc} />
        </div>
      );
    case 'html':
      return (
        <div className="pcv-obj pcv-html" {...common} {...(tabIndex === undefined && object.alt ? { role: 'img', 'aria-label': object.alt } : {})} style={style}>
          {rich ? <HtmlFrame object={object} /> : <div className="pcv-missing" />}
        </div>
      );
  }
});

/**
 * An object far away: one element, a flat patch of its colour in its place,
 * no words and nothing inside. When a board is zoomed so far out that very
 * many objects are on screen and none of their text could be read, this is
 * what each one is. A fraction of the elements, so a pan stays cheap.
 */
export const FlatView = memo(function FlatView({ object }: { object: PlacedCanvasObject }) {
  const color = colorAttrs(object.color);
  return (
    <div
      className={`pcv-obj pcv-flat pcv-flat-${object.type}`}
      data-id={object.id}
      data-color={color['data-color']}
      style={{ ...color.style, transform: `translate(${object.x}px, ${object.y}px)`, width: object.w, height: object.h }}
    />
  );
});

export interface ArrowViewProps {
  arrow: ArrowObject;
  /** What a screen reader says: "Arrow from X to Y, label". */
  label?: string;
  /** The line as an SVG path. */
  d: string;
  /** Where the line starts and ends, and the angle it meets each end at. */
  x1: number;
  y1: number;
  a1: number;
  x2: number;
  y2: number;
  a2: number;
  /** Where the label sits. */
  lx: number;
  ly: number;
  selected: boolean;
}

const HEAD = 9;
const SPREAD = 0.42;

function head(x: number, y: number, angle: number): string {
  return `${x},${y} ${x - HEAD * Math.cos(angle - SPREAD)},${y - HEAD * Math.sin(angle - SPREAD)} ${x - HEAD * Math.cos(angle + SPREAD)},${y - HEAD * Math.sin(angle + SPREAD)}`;
}

function bar(x: number, y: number, angle: number): { x1: number; y1: number; x2: number; y2: number } {
  const nx = Math.cos(angle + Math.PI / 2) * 6;
  const ny = Math.sin(angle + Math.PI / 2) * 6;
  return { x1: x - nx, y1: y - ny, x2: x + nx, y2: y + ny };
}

/** A connector: its line, what its ends look like, and its label on the line. Memoised on its path and numbers. */
export const ArrowView = memo(function ArrowView({ arrow, label, d, x1, y1, a1, x2, y2, a2, lx, ly, selected }: ArrowViewProps) {
  const color = colorAttrs(arrow.color);
  const ends = arrow.style?.ends ?? 'arrow';
  return (
    <g
      className="pcv-arrow"
      role="img"
      aria-label={label}
      data-id={arrow.id}
      data-color={color['data-color']}
      data-dash={arrow.style?.dash ? '' : undefined}
      data-selected={selected ? '' : undefined}
      style={color.style}
    >
      <path className="pcv-arrow-line" d={d} />
      {ends === 'arrow' || ends === 'bar-arrow' ? <polygon points={head(x2, y2, a2)} /> : null}
      {ends === 'bar-arrow' ? <polygon points={head(x1, y1, a1)} /> : null}
      {ends === 'dot' ? <circle cx={x2} cy={y2} r={3.2} /> : null}
      {ends === 'bar' || ends === 'bar-arrow' ? (
        <>
          <line className="pcv-arrow-bar" {...bar(x1, y1, a1)} />
          <line className="pcv-arrow-bar" {...bar(x2, y2, a2)} />
        </>
      ) : null}
      {arrow.label ? (
        <text x={lx} y={ly + 4}>
          {arrow.label}
        </text>
      ) : null}
    </g>
  );
});
