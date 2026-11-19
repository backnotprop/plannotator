/**
 * One object on the board, as DOM. Each is memoised on the object itself:
 * the reducer keeps an untouched object's identity, so a change to one
 * object re-renders one of these, however many are mounted.
 */
import { Check, CircleHelp, File, FileCode, FileText, Film, Globe, Image as ImageIcon, ThumbsUp } from 'lucide-react';
import React, { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CanvasColor } from '../model/color';
import { HTML_ITEM_FRAME_ATTRS, HTML_ITEM_SANDBOX, type HtmlItemFace, checkHtmlItemFaces, htmlItemSrcdoc, isSafeImageSrc } from '../model/html-item';
import { referenceCard } from '../model/reference';
import { seedOf, seeded } from '../view/rough';
import { describeChart } from '../view/chart';
import { ChartView } from './ChartView';
import { Face, usePerson } from './people';
import { type Ground, groundUnder, lookAtPicture, pictureLooks } from './picture-look';
import { previewsPending } from './references';
import type { Rect } from '../model/geometry';
import type { ArrowObject, ArtifactKind, BoxObject, BoxShape, HtmlObject, ImageObject, PlacedCanvasObject, ReferenceObject, SpriteObject } from '../model/types';
import { inkPath } from '../view/ink-path';
import { flatten, hachure, roughStrokes } from '../view/rough';
import { CONTAINER_HEADER, type ShapeOutline, shapeOutline, toPath } from '../view/shape-outline';

export interface ObjectViewProps {
  object: PlacedCanvasObject;
  selected: boolean;
  /** The text is being typed into. */
  editing: boolean;
  /** Embedded HTML and sprites are drawn only when there is room to see them. */
  rich: boolean;
  resolveImageSrc?: (src: string) => string;
  onEditEnd?: EditEnd;
  /**
   * Present in an editor: the object can take focus. 0 for the one object Tab lands on from outside the board,
   * -1 for the rest (the editor moves focus between them in reading order). Absent: not focusable (a figure).
   */
  tabIndex?: 0 | -1;
  /** A note with another lying exactly on it: it casts no shadow of its own. */
  buried?: boolean;
  /** Being dragged right now: a note lifts off the board while it is carried. */
  carried?: boolean;
  /** Bare text or a drawn line lying over a picture: the picture, and the address it is loaded from (null: one that cannot be loaded). Absent: it lies on the board. */
  over?: ImageObject;
  overSrc?: string | null;
}

const noLook = () => undefined;
const never = () => () => {};

/**
 * What a mark lying over a picture is read against (`picture-look.ts`). Only the mark itself waits to hear that
 * its picture has been looked at: nothing else on the board is drawn again when a picture loads.
 */
function useGround(over: Rect | undefined, src: string | null | undefined, area: Rect): Ground | undefined {
  const look = useSyncExternalStore(
    over && src ? (listener) => pictureLooks.subscribe(src, listener) : never,
    over && src ? () => pictureLooks.get(src) : noLook,
    noLook,
  );
  return over ? groundUnder(look, over, area) : undefined;
}

/** Typing into an object's words has ended. `words` is the element typed into, still laid out, for measuring. */
export type EditEnd = (id: string, text: string, words?: HTMLElement) => void;

/** Past this many characters a box's title is likely cut short, so all of it is offered on hover. */
const LONG_WORDS = 48;

/**
 * Whether a box's title may be too long for its box, by a count that errs towards yes: about seven units of
 * width to a character (wide scripts take more, so any character outside Latin counts as two).
 */
function mayOverflow(text: string, width: number, lines: number): boolean {
  if (text.includes('\n')) return true;
  let units = 0;
  for (let i = 0; i < text.length; i++) units += text.charCodeAt(i) > 0x24f ? 2 : 1;
  return units * 7 > Math.max(1, width) * lines;
}

/** How many lines of a box's title its box has room for: three at most, one at least. */
function titleLines(room: number, detail: boolean): number {
  return Math.max(1, Math.min(3, Math.floor((room - (detail ? 18 : 0)) / 17)));
}

/** `data-color` and, for a custom colour, the variable the stylesheet reads. */
export function colorAttrs(color: CanvasColor | undefined): { 'data-color'?: string; style?: React.CSSProperties } {
  if (!color) return {};
  if (typeof color === 'string') return { 'data-color': color };
  return { 'data-color': 'custom', style: { ['--pcv-custom' as string]: color.custom } };
}

function Words({ id, text, editing, className, onEditEnd, title, clamp }: { id: string; text: string; editing: boolean; className?: string; onEditEnd?: EditEnd; title?: string; clamp?: boolean }) {
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
      <div key="view" className={className ? `pcv-words ${className}` : 'pcv-words'} dir="auto" title={title} data-clamp={clamp ? '' : undefined}>
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
      onBlur={(event) => {
        // Typing scrolled the object to where the caret was; it rests showing its start again.
        const object = event.currentTarget.closest('.pcv-obj');
        if (object) object.scrollTop = 0;
        onEditEnd?.(id, event.currentTarget.innerText.replace(/\n$/, ''), event.currentTarget);
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {text}
    </div>
  );
}

/** Whether a loaded picture has see-through parts: looked at once per address (`picture-look.ts`). `null`: it could not be told. */
const clearOf = (src: string): boolean | null => pictureLooks.get(src)?.clear ?? null;
const hasClearParts = (src: string, image: HTMLImageElement): boolean | null => lookAtPicture(src, image)?.clear ?? null;

/** Kinds of picture that never move. Any other may be animated. */
const NEVER_MOVES = /\.jpe?g(?:[?#]|$)/i;
const STILL_MAX = 1600;

function wantsLessMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A picture for someone who asked for less motion: its first frame, drawn once into a canvas, so an animated
 * GIF or SVG stands still. (Drawing needs no permission from the picture's site; only reading back would.)
 */
function StillPicture({ src, alt, onFail }: { src: string; alt: string; onFail: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [clear, setClear] = useState<boolean | null>(clearOf(src));
  useEffect(() => {
    const image = new Image();
    image.referrerPolicy = 'no-referrer';
    image.decoding = 'async';
    let live = true;
    image.onload = () => {
      const el = canvas.current;
      if (!live || !el) return;
      const scale = Math.min(1, STILL_MAX / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
      el.width = Math.max(1, Math.round((image.naturalWidth || 300) * scale));
      el.height = Math.max(1, Math.round((image.naturalHeight || 150) * scale));
      el.getContext('2d')?.drawImage(image, 0, 0, el.width, el.height);
      setClear(hasClearParts(src, image));
    };
    image.onerror = () => {
      if (live) onFail();
    };
    image.src = src;
    return () => {
      live = false;
      image.onload = image.onerror = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);
  return <canvas ref={canvas} role="img" aria-label={alt} data-clear={clear ? '' : undefined} />;
}

function Picture({ object, resolveImageSrc }: { object: ImageObject; resolveImageSrc?: (src: string) => string }) {
  const [failed, setFailed] = useState(false);
  // The stored reference is resolved first; what the browser is then asked to load is checked.
  const resolved = resolveImageSrc ? resolveImageSrc(object.src) : object.src;
  const src = isSafeImageSrc(resolved) ? resolved : null;
  const [clear, setClear] = useState<boolean | null>(src ? clearOf(src) : null);
  useEffect(() => {
    setFailed(false);
    setClear(src ? clearOf(src) : null);
  }, [src]);
  if (!src || failed) return <div className="pcv-missing">{object.alt}</div>;
  if (!NEVER_MOVES.test(src) && wantsLessMotion()) return <StillPicture src={src} alt={object.alt} onFail={() => setFailed(true)} />;
  return (
    <img
      src={src}
      alt={object.alt}
      draggable={false}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      data-clear={clear ? '' : undefined}
      onLoad={(event) => setClear(hasClearParts(src, event.currentTarget))}
      onError={() => setFailed(true)}
    />
  );
}

/** Sprite sheets that could not be loaded, by address: a sheet is a CSS background, which reports nothing itself. */
const SHEETS = new Map<string, boolean>();

/** Whether a sprite's sheet loads: true until it is known not to. */
function useSheet(src: string | null): boolean {
  const [ok, setOk] = useState(src ? (SHEETS.get(src) ?? true) : false);
  useEffect(() => {
    if (!src) {
      setOk(false);
      return;
    }
    const known = SHEETS.get(src);
    setOk(known ?? true);
    if (known !== undefined || typeof Image === 'undefined') return;
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';
    let live = true;
    const settle = (value: boolean) => {
      if (SHEETS.size > 2000) SHEETS.clear();
      SHEETS.set(src, value);
      if (live) setOk(value);
    };
    probe.onload = () => settle(true);
    probe.onerror = () => settle(false);
    probe.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return ok;
}

function Sprite({ object, common, style, resolveImageSrc, named }: { object: SpriteObject; common: object; style: React.CSSProperties; resolveImageSrc?: (src: string) => string; named: boolean }) {
  const resolved = resolveImageSrc ? resolveImageSrc(object.src) : object.src;
  const ok = useSheet(isSafeImageSrc(resolved) ? resolved : null);
  return ok ? (
    <div className="pcv-obj pcv-sprite" {...common} {...(named ? {} : { role: 'img', 'aria-label': object.alt })} style={{ ...style, ...spriteStyle(object, resolveImageSrc) }} />
  ) : (
    <div className="pcv-obj pcv-sprite" {...common} style={{ ...style, animation: 'none' }}>
      <div className="pcv-missing">{object.alt}</div>
    </div>
  );
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

const HtmlItemFacesContext = createContext<readonly HtmlItemFace[]>([]);

/**
 * Lend the host's own type to every HTML item under this (`HtmlItemFace` in `model/html-item.ts`): each face
 * as a `data:` URL. The list is checked here, once; what does not pass is left out.
 */
export function HtmlItemFacesProvider({ faces, children }: { faces: readonly HtmlItemFace[]; children: React.ReactNode }) {
  const checked = useMemo(() => checkHtmlItemFaces(faces), [faces]);
  return <HtmlItemFacesContext.Provider value={checked}>{children}</HtmlItemFacesContext.Provider>;
}

/** The only way custom HTML is ever drawn. See `model/html-item.ts`. */
function HtmlFrame({ object }: { object: HtmlObject }) {
  const faces = useContext(HtmlItemFacesContext);
  const [scheme, setScheme] = useState<'light' | 'dark' | null | undefined>(undefined);
  // The item's document is made once for what it is made from, not on every draw (a drag draws it every frame).
  const srcDoc = useMemo(() => (scheme === undefined ? '' : htmlItemSrcdoc(object.html, scheme, faces)), [object.html, scheme, faces]);
  const probe = useRef<HTMLSpanElement>(null);
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
      {scheme !== undefined ? <iframe title={object.alt ?? ''} sandbox={HTML_ITEM_SANDBOX} srcDoc={srcDoc} {...HTML_ITEM_FRAME_ATTRS} /> : null}
    </>
  );
}

/**
 * An HTML item on the board. `shown` false: a view zoomed out with many items in it, where each shows its words
 * instead of itself (`htmlFramesNext`). Once an item's frame has been drawn it stays mounted, hidden, so going
 * back and forth never loads the item again or flashes it empty. An item with no words says what it is and how big.
 */
function HtmlItem({ object, shown }: { object: HtmlObject; shown: boolean }) {
  const drawn = useRef(shown);
  if (shown) drawn.current = true;
  return (
    <>
      {drawn.current ? (
        <div className="pcv-html-frame" hidden={!shown}>
          <HtmlFrame object={object} />
        </div>
      ) : null}
      {shown ? null : <div className="pcv-missing">{object.alt || `${OBJECT_NAMES.html}, ${Math.round(object.w)} × ${Math.round(object.h)}`}</div>}
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
  // Its page is being looked up: the card says so quietly until the answer, or the wait, ends.
  const pending = useSyncExternalStore(previewsPending.subscribe, () => previewsPending.has(object.id), () => false);
  const Glyph = target.kind === 'web' ? Globe : target.kind === 'plan' ? FileText : ARTIFACT_GLYPHS[target.artifactKind];
  const source = card.site || (target.kind === 'plan' ? REFERENCE_STRINGS.plan : target.kind === 'artifact' ? REFERENCE_STRINGS.artifact[target.artifactKind] : '');
  return (
    <>
      {card.image ? <CardPicture src={card.image} className="pcv-card-image" resolveImageSrc={resolveImageSrc} /> : null}
      <div className="pcv-card-body" data-pending={pending ? '' : undefined}>
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
 * The sketch look of a shape, worked out once and kept: by what it is drawn from (id for the seed, size,
 * shape, fill, roughness), so moving an object reuses it, and every figure of the same object shares it.
 */
const SKETCHES = new Map<string, { strokes: string; details: string; hatch: string }>();

function sketchPaths(object: BoxObject, lanes: number) {
  const shape = object.shape ?? 'process';
  const rough = object.style?.rough ?? 1;
  const seed = object.style?.seed ?? seedOf(object.id);
  const fill = object.style?.fill ?? 'hachure';
  const key = `${seed}|${shape}|${object.w}|${object.h}|${lanes}|${rough}|${fill}`;
  let hit = SKETCHES.get(key);
  if (!hit) {
    const made = shapeOutline(shape, object.w, object.h, lanes);
    const polygon = fill === 'hachure' || fill === 'cross' ? flatten(made.outline) : [];
    hit = {
      strokes: roughStrokes(made.outline, rough, seed),
      details: made.details.map((segs, i) => roughStrokes(segs, rough, seed + i + 1)).join(''),
      hatch: polygon.length ? hachure(polygon, 6, -41, seed) + (fill === 'cross' ? hachure(polygon, 6, 49, seed + 7) : '') : '',
    };
    if (SKETCHES.size > 4000) SKETCHES.clear();
    SKETCHES.set(key, hit);
  }
  return hit;
}

/**
 * A box drawn as its shape: the outline is one small SVG, the words stay
 * HTML on top of it, so they wrap, can be typed into and are read out.
 */
function ShapedBox({ object, editing, onEditEnd }: { object: BoxObject; editing: boolean; onEditEnd?: EditEnd }) {
  const shape = object.shape ?? 'process';
  const lanes = shape === 'container' ? (object.lanes ?? []) : [];
  const paths = shapePaths(shape, object.w, object.h, lanes.length);
  const sketch = object.style?.look === 'sketch' ? sketchPaths(object, lanes.length) : null;
  const [top, right, bottom, left] = paths.text;
  const lines = titleLines(object.h - top - bottom, !!object.detail && shape !== 'container' && shape !== 'actor');
  const clamp = mayOverflow(object.text, object.w - left - right, lines);
  return (
    <>
      <svg className="pcv-shape-svg" width={object.w} height={object.h} viewBox={`0 0 ${object.w} ${object.h}`} aria-hidden="true" focusable="false">
        {sketch ? (
          <>
            {/* The fill sits under the strokes: a faint wash of the colour, and hatching over it when asked for. */}
            <path className="pcv-sketch-wash" d={paths.outline} />
            {sketch.hatch ? <path className="pcv-sketch-hatch" d={sketch.hatch} /> : null}
            <path className="pcv-sketch-stroke" d={sketch.strokes + sketch.details} />
          </>
        ) : (
          <>
            <path className="pcv-shape-fill" d={paths.outline} />
            {paths.details.map((d, i) => (
              <path key={i} className="pcv-shape-line" d={d} />
            ))}
          </>
        )}
      </svg>
      <div className="pcv-shape-text" style={{ padding: `${top}px ${right}px ${bottom}px ${left}px`, ...(clamp ? { ['--pcv-lines' as string]: lines } : null) }}>
        <Words id={object.id} text={object.text} editing={editing} className="pcv-box-text" onEditEnd={onEditEnd} clamp={clamp} title={clamp && object.text.length > LONG_WORDS ? object.text : undefined} />
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

/** A plain box: its title, clamped to its room only when it is long enough to need that, and one line of detail. */
function BoxWords({ object, editing, onEditEnd, common, style }: { object: BoxObject; editing: boolean; onEditEnd?: EditEnd; common: object; style: React.CSSProperties }) {
  const lines = titleLines(object.h - 18, !!object.detail);
  const clamp = mayOverflow(object.text, object.w - 30, lines);
  return (
    <div className="pcv-obj pcv-box" {...common} data-fill={object.style?.fill} data-dash={object.style?.dash ? '' : undefined} style={clamp ? { ...style, ['--pcv-lines' as string]: lines } : style}>
      <Words id={object.id} text={object.text} editing={editing} className="pcv-box-text" onEditEnd={onEditEnd} clamp={clamp} title={clamp && object.text.length > LONG_WORDS ? object.text : undefined} />
      {object.detail && !editing ? <div className="pcv-words pcv-box-detail" dir="auto">{object.detail}</div> : null}
    </div>
  );
}

/** What an object is called when it has no words of its own. */
export const OBJECT_NAMES = { ink: 'Drawing', box: 'Box', note: 'Note', text: 'Text', frame: 'Frame', image: 'Image', sprite: 'Animation', html: 'Embedded content', chart: 'Chart', reference: 'Card', stamp: 'Stamp' } as const;
export const STAMP_NAMES = { check: 'Agreed', thumb: 'Liked', ask: 'In question' } as const;

/** What a screen reader says for an object: its own words, else what it is. */
export function objectLabel(object: PlacedCanvasObject): string {
  const words =
    object.type === 'frame'
      ? object.title
      : object.type === 'reference'
        ? referenceCard(object).title
        : object.type === 'stamp'
          ? `${STAMP_NAMES[object.kind]}${object.count ? ` ${object.count}` : ''}`
          : object.type === 'chart'
            ? describeChart(object)
          : 'text' in object
            ? object.text
            : 'alt' in object
              ? (object.alt ?? '')
              : '';
  const line = words.split('\n')[0].trim();
  const name = object.type === 'box' && object.shape ? SHAPE_NAMES[object.shape] : OBJECT_NAMES[object.type];
  const lanes = object.type === 'box' && object.lanes?.length ? ` (${object.lanes.join(', ')})` : '';
  return line ? `${name}: ${line}${lanes}` : `${name}${lanes}`;
}

/**
 * The slight turn a note rests at: worked out from its id and where it lies, so it is not stored, two people
 * see the same, and a note set down somewhere new settles at a new angle.
 */
export function noteTilt(id: string, x: number, y: number): number {
  const random = seeded(seedOf(id) ^ Math.imul(Math.round(x) | 0, 73856093) ^ Math.imul(Math.round(y) | 0, 19349663));
  return Math.round((random() * 4.4 - 2.2) * 10) / 10;
}

/** Who added it: a face and a name, at the foot of a note or beside a caption. */
function By({ actor }: { actor: PlacedCanvasObject['by'] }) {
  const person = usePerson(actor);
  if (!actor || !person) return null;
  return (
    <span className="pcv-by">
      <Face actor={actor} label={person} />
      <span className="pcv-by-name">{person.name}</span>
    </span>
  );
}

/** Who added it, as a face alone on a corner. */
function ByBadge({ actor }: { actor: PlacedCanvasObject['by'] }) {
  const person = usePerson(actor);
  if (!actor || !person) return null;
  return (
    <span className="pcv-by-badge" title={person.name}>
      <Face actor={actor} label={person} />
    </span>
  );
}

const STAMP_GLYPHS = { check: Check, thumb: ThumbsUp, ask: CircleHelp } as const;

export const ObjectView = memo(function ObjectView({ object, selected, editing, rich, resolveImageSrc, onEditEnd, tabIndex, carried, buried, over, overSrc }: ObjectViewProps) {
  const ground = useGround(over, overSrc, object);
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
      if ((object.shape && object.shape !== 'process') || object.style?.look === 'sketch') {
        return (
          <div className="pcv-obj pcv-shape" {...common} data-shape={object.shape ?? 'process'} data-look={object.style?.look} data-dash={object.style?.dash ? '' : undefined} data-fill={object.style?.fill} style={style}>
            <ShapedBox object={object} editing={editing} onEditEnd={onEditEnd} />
          </div>
        );
      }
      return <BoxWords object={object} editing={editing} onEditEnd={onEditEnd} common={common} style={style} />;
    case 'note':
      return (
        // A note rests at a slight angle and lifts, level, while it is carried.
        <div className="pcv-obj pcv-note" {...common} data-carried={carried ? '' : undefined} data-buried={buried ? '' : undefined} style={{ ...style, transform: `${style.transform} rotate(${carried || editing ? 0 : noteTilt(object.id, object.x, object.y)}deg)` }}>
          <Words id={object.id} text={object.text} editing={editing} onEditEnd={onEditEnd} />
          <By actor={object.by} />
        </div>
      );
    case 'stamp': {
      const Glyph = STAMP_GLYPHS[object.kind];
      return (
        <div className="pcv-obj pcv-stamp" {...common} style={style}>
          <Glyph />
          {object.count ? <span>{object.count}</span> : null}
        </div>
      );
    }
    case 'text':
      return (
        <div className="pcv-obj pcv-text" {...common} data-size={object.size} data-face={object.face} data-ground={ground} style={style}>
          <Words id={object.id} text={object.text} editing={editing} onEditEnd={onEditEnd} />
        </div>
      );
    case 'frame':
      return (
        <div className="pcv-obj pcv-frame" {...common} style={style}>
          {/* The title sits on a chip above the frame, which stays readable when the board is zoomed out. */}
          <div className="pcv-frame-chip" title={editing ? undefined : object.title || undefined}>
            <Words id={object.id} text={object.title} editing={editing} className="pcv-frame-title" onEditEnd={onEditEnd} />
          </div>
        </div>
      );
    case 'image':
      return (
        <div className="pcv-obj pcv-image" {...common} style={style}>
          <Picture object={object} resolveImageSrc={resolveImageSrc} />
          {/* What the picture is, and who added it, under it. */}
          <div className="pcv-caption">
            <ByBadge actor={object.by} />
            <span className="pcv-words">{object.alt}</span>
          </div>
        </div>
      );
    case 'sprite':
      return <Sprite object={object} common={common} style={style} resolveImageSrc={resolveImageSrc} named={tabIndex !== undefined} />;
    case 'reference':
      return (
        <div className="pcv-obj pcv-card" {...common} data-target={object.target.kind} style={style}>
          <Card object={object} resolveImageSrc={resolveImageSrc} />
          <ByBadge actor={object.by} />
        </div>
      );
    case 'ink':
      return (
        <div className="pcv-obj pcv-ink" {...common} data-pen={object.pen} data-ground={ground} style={style}>
          {/* The line may run half a pen's width outside its box, so the drawing is never clipped to it. */}
          <svg width={object.w} height={object.h} viewBox={`0 0 ${object.w} ${object.h}`} aria-hidden="true" focusable="false">
            <path d={inkPath(object.points, object.w, object.h)} />
          </svg>
        </div>
      );
    case 'chart':
      return (
        // In a figure it is one picture with its data said in words; in an editor the object already carries that name.
        <div className="pcv-obj pcv-chart" {...common} {...(tabIndex === undefined ? { role: 'img', 'aria-label': describeChart(object) } : {})} data-mark={object.mark} style={style}>
          <ChartView object={object} rich={rich} />
        </div>
      );
    case 'html':
      return (
        <div className="pcv-obj pcv-html" {...common} {...(tabIndex === undefined && object.alt ? { role: 'img', 'aria-label': object.alt } : {})} style={style}>
          <HtmlItem object={object} shown={rich} />
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
  /** How long the line is: a label is given no more room than its line has. */
  room?: number;
  /** Where the label sits. */
  lx: number;
  ly: number;
  selected: boolean;
  /** Both ends lie on one picture: that picture and the address it is loaded from. Absent: the line lies on the board. */
  over?: ImageObject;
  overSrc?: string | null;
}

/** About how many characters of a label fit on a line between two things without lying over them. */
export const ARROW_LABEL_MAX = 40;

/**
 * A label short enough for its line: forty characters at most, fewer on a short line (about a character to
 * every seven units of it, and never under eight), cut at a word when one ends near the limit.
 */
export function shortLabel(label: string, room?: number): string {
  const line = label.replace(/\s+/g, ' ').trim();
  const max = room ? Math.max(8, Math.min(ARROW_LABEL_MAX, Math.floor(room / 7))) : ARROW_LABEL_MAX;
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
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
export const ArrowView = memo(function ArrowView({ arrow, label, d, x1, y1, a1, x2, y2, a2, lx, ly, room, selected, over, overSrc }: ArrowViewProps) {
  const ground = useGround(over, overSrc, { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
  const shown = arrow.label ? shortLabel(arrow.label, room) : '';
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
      data-ground={ground}
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
          {/* A long label is shortened on the line; all of it is in the arrow's name and shows on hover. */}
          {shown !== arrow.label ? <title>{arrow.label}</title> : null}
          {shown}
        </text>
      ) : null}
    </g>
  );
});
