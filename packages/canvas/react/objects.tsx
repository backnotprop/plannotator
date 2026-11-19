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
import type { ArrowObject, ArtifactKind, HtmlObject, ImageObject, PlacedCanvasObject, ReferenceObject, SpriteObject } from '../model/types';

export interface ObjectViewProps {
  object: PlacedCanvasObject;
  selected: boolean;
  /** The text is being typed into. */
  editing: boolean;
  /** Embedded HTML and sprites are drawn only when there is room to see them. */
  rich: boolean;
  resolveImageSrc?: (src: string) => string;
  onEditEnd?: (id: string, text: string) => void;
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
      <div className={className ? `pcv-words ${className}` : 'pcv-words'} dir="auto">
        {text}
      </div>
    );
  }
  return (
    <div
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
  const frame = useRef<HTMLIFrameElement>(null);
  const [scheme, setScheme] = useState<'light' | 'dark' | null>(null);
  // The item is told the theme it sits in, and told again when it changes.
  useLayoutEffect(() => {
    const read = () => {
      const value = frame.current ? getComputedStyle(frame.current).colorScheme : '';
      setScheme(value === 'dark' || value === 'light' ? value : null);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, []);
  return <iframe ref={frame} title={object.alt ?? ''} sandbox={HTML_ITEM_SANDBOX} srcDoc={htmlItemSrcdoc(object.html, scheme)} {...HTML_ITEM_FRAME_ATTRS} />;
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

export const ObjectView = memo(function ObjectView({ object, selected, editing, rich, resolveImageSrc, onEditEnd }: ObjectViewProps) {
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
  };
  switch (object.type) {
    case 'box':
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
        <div className="pcv-obj pcv-sprite" role="img" aria-label={object.alt} {...common} style={{ ...style, ...spriteStyle(object, resolveImageSrc) }} />
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
        <div className="pcv-obj pcv-html" role={object.alt ? 'img' : undefined} aria-label={object.alt} {...common} style={style}>
          {rich ? <HtmlFrame object={object} /> : <div className="pcv-missing" />}
        </div>
      );
  }
});

export interface ArrowViewProps {
  arrow: ArrowObject;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  selected: boolean;
}

const HEAD = 10;
const SPREAD = 0.42;

/** An arrow: a line, a head and an optional label. Memoised on its four numbers. */
export const ArrowView = memo(function ArrowView({ arrow, x1, y1, x2, y2, selected }: ArrowViewProps) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = `${x2},${y2} ${x2 - HEAD * Math.cos(angle - SPREAD)},${y2 - HEAD * Math.sin(angle - SPREAD)} ${x2 - HEAD * Math.cos(angle + SPREAD)},${y2 - HEAD * Math.sin(angle + SPREAD)}`;
  const color = colorAttrs(arrow.color);
  return (
    <g className="pcv-arrow" data-id={arrow.id} data-color={color['data-color']} data-selected={selected ? '' : undefined} style={color.style}>
      <line x1={x1} y1={y1} x2={x2 - 4 * Math.cos(angle)} y2={y2 - 4 * Math.sin(angle)} />
      <polygon points={head} />
      {arrow.label ? (
        <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6}>
          {arrow.label}
        </text>
      ) : null}
    </g>
  );
});
