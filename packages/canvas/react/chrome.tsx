/**
 * The editor's floating bars: tools, undo and redo, zoom, and the bar that
 * follows the selection. Buttons only. There are no keyboard shortcuts.
 */
import {
  ExternalLink,
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
import React, { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';
import { NAMED_COLORS, type CanvasColor, type NamedColor } from '../model/color';
import { boundsOf } from '../model/document';
import { createId } from '../model/ids';
import type { Rect } from '../model/geometry';
import type { CanvasDocument, ObjectId } from '../model/types';
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
  addToPlan: 'Add to plan',
  group: 'Group',
  ungroup: 'Ungroup',
  delete: 'Delete',
  open: 'Open',
  customColor: 'Custom colour',
  textNotKept: 'That text is too long to keep',
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

export function ZoomBar({ camera, onZoom, onFit, onReset }: { camera: CameraController; onZoom: (factor: number) => void; onFit: () => void; onReset: () => void }) {
  const label = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const write = () => {
      if (label.current) label.current.textContent = `${Math.round(camera.get().z * 100)}%`;
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
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  /** Present when the one selected object is a card that can be opened. */
  onOpen?: () => void;
  /** Present when the host can take a snapshot into a plan. */
  addToPlan?: { onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void };
}

export function SelectionBar({ camera, doc, selection, region, hidden, onRecolor, onDelete, onGroup, onUngroup, onOpen, addToPlan }: SelectionBarProps) {
  const bar = useRef<HTMLDivElement>(null);
  // One id for each time the colour well is opened: every colour passed over on the way is one undo step.
  const pick = useRef('');
  const ids = [...selection];
  const target = region ?? boundsOf(doc, ids);
  const show = !hidden && !!target;

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el || !show || !target) return;
    const place = () => {
      const view = el.parentElement;
      if (!view) return;
      const at = placeSelectionBar(worldRectToScreen(camera.get(), target), { w: el.offsetWidth, h: el.offsetHeight }, { w: view.clientWidth, h: view.clientHeight });
      el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
    };
    place();
    return camera.subscribe(place);
  });

  if (!show) return null;
  const first = ids.length ? doc.objects[ids[0]] : undefined;
  const current = first?.color;
  const groups = new Set(ids.map((id) => doc.objects[id]?.group).filter(Boolean));
  const oneGroup = groups.size === 1 && ids.every((id) => doc.objects[id]?.group);

  return (
    <div ref={bar} className="pcv-bar pcv-bar-selection" role="toolbar" aria-label={CANVAS_STRINGS.selection}>
      {ids.length > 0 ? (
        <>
          {NAMED_COLORS.map((name) => (
            <button
              key={name}
              type="button"
              className="pcv-swatch"
              aria-label={CANVAS_STRINGS.colors[name]}
              title={CANVAS_STRINGS.colors[name]}
              aria-pressed={name === 'neutral' ? !current || current === 'neutral' : current === name}
              style={name === 'neutral' ? undefined : { ['--pcv-swatch' as string]: `var(--pcv-${name})` }}
              onClick={() => onRecolor(name === 'neutral' ? null : name)}
            />
          ))}
          <label className="pcv-swatch pcv-swatch-custom" title={CANVAS_STRINGS.customColor}>
            <input
              type="color"
              aria-label={CANVAS_STRINGS.customColor}
              value={typeof current === 'object' && /^#[0-9a-f]{6}$/i.test(current.custom) ? current.custom : '#8a8f9c'}
              onPointerDown={() => (pick.current = createId('pick'))}
              onFocus={() => (pick.current ||= createId('pick'))}
              onBlur={() => (pick.current = '')}
              onChange={(event) => onRecolor({ custom: event.target.value }, (pick.current ||= createId('pick')))}
            />
          </label>
          <span className="pcv-sep" aria-hidden="true" />
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
  );
}
