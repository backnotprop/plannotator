/**
 * The editor's floating bars: tools, undo and redo, zoom, and the bar that
 * follows the selection. Buttons only. There are no keyboard shortcuts.
 */
import {
  CircleDot,
  CircleOff,
  CornerDownRight,
  Droplet,
  ExternalLink,
  Hash,
  MoreHorizontal,
  MoveHorizontal,
  MoveRight,
  PaintBucket,
  PenLine,
  Shapes,
  Slash,
  Map as MapIcon,
  Group,
  Hand,
  ImagePlus,
  Maximize,
  Minus,
  MousePointer2,
  MoveUpRight,
  Plus,
  Redo2,
  ScanLine,
  Square,
  StickyNote,
  Trash2,
  Type,
  Undo2,
  Ungroup,
} from 'lucide-react';
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';
import { NAMED_COLORS, type CanvasColor, type NamedColor, isCustomColor } from '../model/color';
import { boundsOf } from '../model/document';
import { createId } from '../model/ids';
import type { Rect } from '../model/geometry';
import { BOX_SHAPES, type ArrowRouting, type BoxShape, type CanvasDocument, type CanvasObject, type ObjectId, type ObjectStyle } from '../model/types';
import { shapeOutline, toPath } from '../view/shape-outline';
import { type CameraController, worldRectToScreen } from '../view/camera';
import type { EditorState, Tool } from './editor-state';

/** Every word the editor shows or reads out. One place, so they can be reviewed and replaced. */
export const CANVAS_STRINGS = {
  select: 'Select',
  hand: 'Pan',
  box: 'Box',
  note: 'Note',
  text: 'Text',
  arrow: 'Arrow',
  image: 'Image',
  region: 'Snapshot region',
  undo: 'Undo',
  redo: 'Redo',
  zoomOut: 'Zoom out',
  zoomIn: 'Zoom in',
  zoomFit: 'Zoom to fit',
  zoomReset: 'Zoom to 100%',
  map: 'Map',
  mapLabel: 'Map of the board. Press to go to a place.',
  addToPlan: 'Add to plan',
  group: 'Group',
  ungroup: 'Ungroup',
  delete: 'Delete',
  open: 'Open',
  customColor: 'Custom colour',
  color: 'Colour',
  anyColor: 'Any colour',
  anyColorHint: '#0e9aa7, teal, rgb(…)',
  style: 'Style',
  clean: 'Clean',
  sketch: 'Sketch',
  dashed: 'Dashed',
  routing: { elbow: 'Right angles', straight: 'Straight' },
  ends: { arrow: 'Arrow', none: 'No ends', dot: 'Dot', 'bar-arrow': 'Measure' },
  fills: { tint: 'Tint', solid: 'Solid', hachure: 'Hatched', cross: 'Cross-hatched', none: 'No fill' },
  textNotKept: 'That text is too long to keep',
  emptyBoard: 'Paste a link or a picture, or pick a tool.',
  moreThisWay: 'More of the board this way',
  dropNotPicture: 'Only pictures and links can be dropped here',
  pictureProblems: {
    unavailable: 'Pictures cannot be added here',
    'too-large': 'That picture is too large to add',
    unreadable: 'That file could not be read as a picture',
    'not-saved': 'That picture could not be saved',
  },
  tools: 'Tools',
  history: 'History',
  zoom: 'Zoom',
  selection: 'Selection',
  colors: { neutral: 'Neutral', blue: 'Blue', green: 'Green', amber: 'Amber', red: 'Red', violet: 'Violet' } satisfies Record<NamedColor, string>,
} as const;

const TOOLS: { tool: Tool; label: string; icon: React.ReactNode; separatorAfter?: boolean }[] = [
  { tool: 'select', label: CANVAS_STRINGS.select, icon: <MousePointer2 /> },
  { tool: 'hand', label: CANVAS_STRINGS.hand, icon: <Hand />, separatorAfter: true },
  { tool: 'box', label: CANVAS_STRINGS.box, icon: <Square /> },
  { tool: 'note', label: CANVAS_STRINGS.note, icon: <StickyNote /> },
  { tool: 'text', label: CANVAS_STRINGS.text, icon: <Type /> },
  { tool: 'arrow', label: CANVAS_STRINGS.arrow, icon: <MoveUpRight /> },
];

export function IconButton({ label, pressed, children, ...rest }: { label: string; pressed?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="pcv-btn pcv-btn-icon" aria-label={label} title={label} aria-pressed={pressed} {...rest}>
      {children}
    </button>
  );
}

export function ToolDock({ state, tool, onPickImage, canSnapshot }: { state: EditorState; tool: Tool; onPickImage?: () => void; canSnapshot: boolean }) {
  return (
    <div className="pcv-bar pcv-bar-dock" role="toolbar" aria-label={CANVAS_STRINGS.tools}>
      {TOOLS.map(({ tool: t, label, icon, separatorAfter }) => (
        <React.Fragment key={t}>
          <IconButton label={label} pressed={tool === t} onClick={() => state.set({ tool: t })}>
            {icon}
          </IconButton>
          {separatorAfter ? <span className="pcv-sep" aria-hidden="true" /> : null}
        </React.Fragment>
      ))}
      {onPickImage ? (
        <IconButton label={CANVAS_STRINGS.image} onClick={onPickImage}>
          <ImagePlus />
        </IconButton>
      ) : null}
      {canSnapshot ? (
        <>
          <span className="pcv-sep" aria-hidden="true" />
          <IconButton label={CANVAS_STRINGS.region} pressed={tool === 'region'} onClick={() => state.set({ tool: 'region' })}>
            <ScanLine />
          </IconButton>
        </>
      ) : null}
    </div>
  );
}

export function HistoryBar({ store }: { store: CanvasStore }) {
  // The document changes on every commit, and so may what undo can do.
  useSyncExternalStore(store.subscribe, store.getDocument, store.getDocument);
  return (
    <div className="pcv-bar pcv-bar-history" role="toolbar" aria-label={CANVAS_STRINGS.history}>
      <IconButton label={CANVAS_STRINGS.undo} disabled={!store.canUndo} onClick={() => store.undo()}>
        <Undo2 />
      </IconButton>
      <IconButton label={CANVAS_STRINGS.redo} disabled={!store.canRedo} onClick={() => store.redo()}>
        <Redo2 />
      </IconButton>
    </div>
  );
}

export function ZoomBar({ camera, onZoom, onFit, onReset, map, onMap }: { camera: CameraController; onZoom: (factor: number) => void; onFit: () => void; onReset: () => void; map?: boolean; onMap?: () => void }) {
  const label = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const write = () => {
      const percent = `${Math.round(camera.get().z * 100)}%`;
      if (label.current) label.current.textContent = percent;
      // The button's name starts with what it shows, then says what pressing it does.
      label.current?.parentElement?.setAttribute('aria-label', `${percent}. ${CANVAS_STRINGS.zoomReset}`);
    };
    write();
    return camera.subscribe(write);
  }, [camera]);
  return (
    <div className="pcv-bar pcv-bar-zoom" role="toolbar" aria-label={CANVAS_STRINGS.zoom}>
      <IconButton label={CANVAS_STRINGS.zoomOut} onClick={() => onZoom(1 / 1.25)}>
        <Minus />
      </IconButton>
      <button type="button" className="pcv-btn" style={{ minWidth: 52 }} aria-label={CANVAS_STRINGS.zoomReset} title={CANVAS_STRINGS.zoomReset} onClick={onReset}>
        <span ref={label} />
      </button>
      <IconButton label={CANVAS_STRINGS.zoomIn} onClick={() => onZoom(1.25)}>
        <Plus />
      </IconButton>
      <IconButton label={CANVAS_STRINGS.zoomFit} onClick={onFit}>
        <Maximize />
      </IconButton>
      {onMap ? (
        <IconButton label={CANVAS_STRINGS.map} pressed={!!map} onClick={onMap}>
          <MapIcon />
        </IconButton>
      ) : null}
    </div>
  );
}

const BAR_GAP = 12;
const EDGE = 6;

/**
 * Where the selection bar goes: centred above the selection, below it when
 * there is no room above, and always wholly inside the view.
 */
export function placeSelectionBar(target: Rect, bar: { w: number; h: number }, view: { w: number; h: number }): { x: number; y: number } {
  let y = target.y - bar.h - BAR_GAP;
  if (y < EDGE) y = target.y + target.h + BAR_GAP;
  y = Math.max(EDGE, Math.min(view.h - bar.h - EDGE, y));
  const x = Math.max(EDGE, Math.min(view.w - bar.w - EDGE, target.x + target.w / 2 - bar.w / 2));
  return { x, y };
}

/** Six more colours picked to sit beside the six named ones. Any other colour is one field away. */
export const PALETTE_EXTRA = ['#0e9aa7', '#d6336c', '#e8590c', '#5c940d', '#495057', '#8d6e63'] as const;

export interface StyleChange {
  shape?: BoxShape;
  routing?: ArrowRouting;
  /** Style values to set; `undefined` takes one away. */
  style?: Partial<Record<keyof ObjectStyle, ObjectStyle[keyof ObjectStyle] | undefined>>;
}

export interface SelectionBarProps {
  store: CanvasStore;
  camera: CameraController;
  doc: CanvasDocument;
  selection: ReadonlySet<ObjectId>;
  region: Rect | null;
  /** Hidden while something is dragged, so it does not chase the pointer. */
  hidden: boolean;
  /** `gesture`: picks sharing one are one undo step (dragging through the colour well). */
  onRecolor: (color: CanvasColor | null, gesture?: string) => void;
  onStyle: (change: StyleChange) => void;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  /** Present when the one selected object is a card that can be opened. */
  onOpen?: () => void;
  /** Present when the host can take a snapshot into a plan. */
  addToPlan?: { onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void };
}

/** A small picture of a shape, drawn from the same outline the board uses. */
function ShapeGlyph({ shape }: { shape: BoxShape }) {
  const made = shapeOutline(shape, 22, shape === 'actor' ? 30 : 16, shape === 'container' ? 2 : 0);
  return (
    <svg viewBox={shape === 'actor' ? '-1 -1 24 26' : '-1 -3 24 22'} aria-hidden="true" style={{ fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }}>
      <path d={toPath(made.outline)} />
      {made.details.map((segs, i) => (
        <path key={i} d={toPath(segs)} />
      ))}
    </svg>
  );
}

const SHAPE_LABELS: Record<BoxShape, string> = {
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

/** Colour: the six named ones, six more, then any colour at all. */
function ColorPopover({ current, onRecolor }: { current: CanvasColor | undefined; onRecolor: SelectionBarProps['onRecolor'] }) {
  // One id for each time the colour well is opened: every colour passed over on the way is one undo step.
  const pick = useRef('');
  const custom = typeof current === 'object' ? current.custom : '';
  const [typed, setTyped] = useState(custom);
  useEffect(() => setTyped(custom), [custom]);
  const swatch = (key: string, label: string, value: CanvasColor | null, css: string | undefined, pressed: boolean) => (
    <button key={key} type="button" className="pcv-swatch" aria-label={label} title={label} aria-pressed={pressed} style={css ? { ['--pcv-swatch' as string]: css } : undefined} onClick={() => onRecolor(value)} />
  );
  return (
    <div className="pcv-popover pcv-popover-color" role="group" aria-label={CANVAS_STRINGS.color}>
      <div className="pcv-popover-row">
        {NAMED_COLORS.map((name) => swatch(name, CANVAS_STRINGS.colors[name], name === 'neutral' ? null : name, name === 'neutral' ? undefined : `var(--pcv-${name})`, name === 'neutral' ? !current || current === 'neutral' : current === name))}
      </div>
      <div className="pcv-popover-row">{PALETTE_EXTRA.map((hex) => swatch(hex, hex, { custom: hex }, hex, custom.toLowerCase() === hex))}</div>
      <div className="pcv-popover-row pcv-popover-any">
        <label className="pcv-swatch pcv-swatch-custom" title={CANVAS_STRINGS.customColor}>
          <input
            type="color"
            aria-label={CANVAS_STRINGS.customColor}
            value={/^#[0-9a-f]{6}$/i.test(custom) ? custom : '#8a8f9c'}
            onPointerDown={() => (pick.current = createId('pick'))}
            onFocus={() => (pick.current ||= createId('pick'))}
            onBlur={() => (pick.current = '')}
            onChange={(event) => onRecolor({ custom: event.target.value }, (pick.current ||= createId('pick')))}
          />
        </label>
        <input
          className="pcv-field"
          type="text"
          spellCheck={false}
          autoCapitalize="off"
          aria-label={CANVAS_STRINGS.anyColor}
          placeholder={CANVAS_STRINGS.anyColorHint}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            // Applied as soon as what is typed is a colour; until then nothing changes.
            if (isCustomColor(event.target.value)) onRecolor({ custom: event.target.value.trim() }, (pick.current ||= createId('pick')));
          }}
          onBlur={() => (pick.current = '')}
        />
      </div>
    </div>
  );
}

/** Style: what shape a box is, whether it is clean or sketched and how it is filled; how a connector runs and ends. */
function StylePopover({ first, onStyle }: { first: CanvasObject; onStyle: (change: StyleChange) => void }) {
  const option = (key: string, label: string, pressed: boolean, change: StyleChange, glyph: React.ReactNode) => (
    <button key={key} type="button" className="pcv-btn pcv-btn-icon" aria-label={label} title={label} aria-pressed={pressed} onClick={() => onStyle(change)}>
      {glyph}
    </button>
  );
  const style = first.style ?? {};
  if (first.type === 'arrow') {
    const routing = first.routing ?? 'elbow';
    const ends = style.ends ?? 'arrow';
    return (
      <div className="pcv-popover" role="group" aria-label={CANVAS_STRINGS.style}>
        <div className="pcv-popover-row">
          {option('elbow', CANVAS_STRINGS.routing.elbow, routing === 'elbow', { routing: 'elbow' }, <CornerDownRight />)}
          {option('straight', CANVAS_STRINGS.routing.straight, routing === 'straight', { routing: 'straight' }, <Minus />)}
          <span className="pcv-sep" aria-hidden="true" />
          {option('dash', CANVAS_STRINGS.dashed, !!style.dash, { style: { dash: style.dash ? undefined : true } }, <MoreHorizontal />)}
          {option('sketch', CANVAS_STRINGS.sketch, style.look === 'sketch', { style: { look: style.look === 'sketch' ? undefined : 'sketch' } }, <PenLine />)}
        </div>
        <div className="pcv-popover-row">
          {option('arrow', CANVAS_STRINGS.ends.arrow, ends === 'arrow', { style: { ends: undefined } }, <MoveRight />)}
          {option('none', CANVAS_STRINGS.ends.none, ends === 'none', { style: { ends: 'none' } }, <Minus />)}
          {option('dot', CANVAS_STRINGS.ends.dot, ends === 'dot', { style: { ends: 'dot' } }, <CircleDot />)}
          {option('bar-arrow', CANVAS_STRINGS.ends['bar-arrow'], ends === 'bar-arrow', { style: { ends: 'bar-arrow' } }, <MoveHorizontal />)}
        </div>
      </div>
    );
  }
  if (first.type !== 'box') return null;
  const shape = first.shape ?? 'process';
  const sketched = style.look === 'sketch';
  const fill = style.fill ?? (sketched ? 'hachure' : 'tint');
  return (
    <div className="pcv-popover" role="group" aria-label={CANVAS_STRINGS.style}>
      <div className="pcv-popover-grid">{BOX_SHAPES.map((kind) => option(kind, SHAPE_LABELS[kind], shape === kind, { shape: kind }, <ShapeGlyph shape={kind} />))}</div>
      <div className="pcv-popover-row">
        {option('clean', CANVAS_STRINGS.clean, !sketched, { style: { look: undefined, fill: fill === 'hachure' || fill === 'cross' ? undefined : style.fill } }, <Square />)}
        {option('sketch', CANVAS_STRINGS.sketch, sketched, { style: { look: 'sketch' } }, <PenLine />)}
        <span className="pcv-sep" aria-hidden="true" />
        {option('tint', CANVAS_STRINGS.fills.tint, fill === 'tint', { style: { fill: sketched ? 'tint' : undefined } }, <Droplet />)}
        {option('solid', CANVAS_STRINGS.fills.solid, fill === 'solid', { style: { fill: 'solid' } }, <PaintBucket />)}
        {sketched ? option('hachure', CANVAS_STRINGS.fills.hachure, fill === 'hachure', { style: { fill: undefined } }, <Slash />) : null}
        {sketched ? option('cross', CANVAS_STRINGS.fills.cross, fill === 'cross', { style: { fill: 'cross' } }, <Hash />) : null}
        {option('none', CANVAS_STRINGS.fills.none, fill === 'none', { style: { fill: 'none' } }, <CircleOff />)}
      </div>
    </div>
  );
}

/**
 * The bar that goes with what is selected: colour, style, and what can be
 * done with it. Icons only, but for the one action that leaves the canvas.
 */
export function SelectionBar({ camera, doc, selection, region, hidden, onRecolor, onStyle, onDelete, onGroup, onUngroup, onOpen, addToPlan }: SelectionBarProps) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<'color' | 'style' | null>(null);
  const ids = [...selection];
  const target = region ?? boundsOf(doc, ids);
  const show = !hidden && !!target;
  const key = ids.join(' ');
  // A new selection starts with its popovers closed.
  useEffect(() => setOpen(null), [key]);

  useLayoutEffect(() => {
    const el = anchor.current;
    if (!el || !show || !target) return;
    const place = () => {
      const view = el.parentElement;
      const bar = el.firstElementChild as HTMLElement | null;
      if (!view || !bar) return;
      const at = placeSelectionBar(worldRectToScreen(camera.get(), target), { w: bar.offsetWidth, h: bar.offsetHeight }, { w: view.clientWidth, h: view.clientHeight });
      el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
      // The popover opens downward, or upward when the bar sits in the lower part of the view.
      el.dataset.up = at.y > view.clientHeight * 0.55 ? '' : undefined;
      if (at.y <= view.clientHeight * 0.55) delete el.dataset.up;
    };
    place();
    return camera.subscribe(place);
  });

  if (!show) return null;
  const first = ids.length ? doc.objects[ids[0]] : undefined;
  const current = first?.color;
  const groups = new Set(ids.map((id) => doc.objects[id]?.group).filter(Boolean));
  const oneGroup = groups.size === 1 && ids.every((id) => doc.objects[id]?.group);
  const styled = first && (first.type === 'box' || first.type === 'arrow');
  const dot = !current || current === 'neutral' ? undefined : typeof current === 'string' ? `var(--pcv-${current})` : current.custom;

  return (
    <div ref={anchor} className="pcv-selection">
      <div className="pcv-bar pcv-bar-selection" role="toolbar" aria-label={CANVAS_STRINGS.selection}>
        {ids.length > 0 ? (
          <>
            <button type="button" className="pcv-btn pcv-btn-icon" aria-label={CANVAS_STRINGS.color} title={CANVAS_STRINGS.color} aria-expanded={open === 'color'} onClick={() => setOpen(open === 'color' ? null : 'color')}>
              <span className="pcv-color-dot" style={dot ? { ['--pcv-swatch' as string]: dot } : undefined} />
            </button>
            {styled ? (
              <IconButton label={CANVAS_STRINGS.style} aria-expanded={open === 'style'} onClick={() => setOpen(open === 'style' ? null : 'style')}>
                <Shapes />
              </IconButton>
            ) : null}
            {oneGroup ? (
              <IconButton label={CANVAS_STRINGS.ungroup} onClick={onUngroup}>
                <Ungroup />
              </IconButton>
            ) : ids.length > 1 ? (
              <IconButton label={CANVAS_STRINGS.group} onClick={onGroup}>
                <Group />
              </IconButton>
            ) : null}
            {onOpen ? (
              <IconButton label={CANVAS_STRINGS.open} onClick={onOpen}>
                <ExternalLink />
              </IconButton>
            ) : null}
            <IconButton label={CANVAS_STRINGS.delete} onClick={onDelete}>
              <Trash2 />
            </IconButton>
          </>
        ) : null}
        {addToPlan ? (
          <>
            {ids.length > 0 ? <span className="pcv-sep" aria-hidden="true" /> : null}
            <button type="button" className="pcv-btn pcv-btn-primary" onPointerDown={addToPlan.onPointerDown} onClick={addToPlan.onClick}>
              {CANVAS_STRINGS.addToPlan}
            </button>
          </>
        ) : null}
      </div>
      {open === 'color' ? <ColorPopover current={current} onRecolor={onRecolor} /> : null}
      {open === 'style' && first ? <StylePopover first={first} onStyle={onStyle} /> : null}
    </div>
  );
}
