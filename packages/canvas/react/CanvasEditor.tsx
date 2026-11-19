/**
 * The canvas a person works on: the renderer, plus selection, gestures and
 * the floating bars. It owns no document logic. Everything it does to the
 * canvas is a command to the store, the same commands an agent sends.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';
import type { CanvasColor } from '../model/color';
import { boundsOf, objectBounds } from '../model/document';
import { rectContainsRect } from '../model/geometry';
import { createId } from '../model/ids';
import type { ObjectId, ReferenceObject, Snapshot } from '../model/types';
import { type AssetPort, pictureResolver } from '../model/assets';
import type { LinkPreviewPort } from '../model/reference';
import { CameraController, type Size, fitRect, viewportRect, worldToScreen, zoomAt } from '../view/camera';
import { neighbourInReadingOrder, readingOrder } from '../view/reading-order';
import { portPoint } from '../view/routes';
import { indexFor } from '../view/document-index';
import { snapshotFromRegion, snapshotFromSelection } from '../view/snapshot-source';
import { CanvasView } from './CanvasView';
import { CANVAS_STRINGS, HistoryBar, SelectionBar, ToolDock, ZoomBar } from './chrome';
import { EditorState } from './editor-state';
import { GestureController, firstEditGesture } from './gestures';
import { addPicture, looksLikePicture } from './pictures';
import { type PlanDropTarget, beginPlanDrag } from './plan-drop';
import { type PasteResolver, addReference, referenceFromPaste } from './references';

export interface CanvasEditorProps {
  store: CanvasStore;
  /** Pass one to drive or read the camera from outside. Absent: the editor makes its own and fits the board. */
  camera?: CameraController;
  /**
   * The host can put a snapshot into a plan. Called after the snapshot has
   * been added to the canvas; `drop` says where it was dropped, or is null
   * when the button was pressed without dragging.
   */
  onAddToPlan?: (snapshot: Snapshot, drop: PlanDropTarget | null) => void;
  resolveImageSrc?: (src: string) => string;
  /**
   * Where pasted and picked pictures are kept (`model/assets.ts`). Absent:
   * the picture tool is not shown, and a pasted picture gets a line saying
   * pictures cannot be added here.
   */
  assets?: AssetPort | null;
  /** Fetches a pasted web address's preview. Absent: a web card shows its address. */
  linkPreview?: LinkPreviewPort;
  /** Recognises the host's own artifacts and plans in pasted text. */
  resolvePaste?: PasteResolver;
  /** Open what a card points at. Absent: a web card opens in a new tab, others do nothing. */
  onOpenReference?: (reference: ReferenceObject) => void;
  /** The person panned or zoomed. A camera animation should stop driving. */
  onUserCamera?: () => void;
  /** Extra world area to keep mounted (see `CanvasView.keepMounted`). */
  keepMounted?: React.ComponentProps<typeof CanvasView>['keepMounted'];
  /** See `CanvasView.overscan`. */
  overscan?: number;
  /** Host controls drawn with the editor's own bars (a "back" button). */
  children?: React.ReactNode;
  /** Host controls that come first in the Tab order, before the board's objects (the way out of an opened canvas). */
  lead?: React.ReactNode;
  /** Hide the bars (while a transition is running). */
  chromeHidden?: boolean;
  className?: string;
}

const HANDLES = ['nw', 'ne', 'sw', 'se'] as const;

export function CanvasEditor({ store, camera: givenCamera, onAddToPlan, resolveImageSrc, assets, linkPreview, resolvePaste, onOpenReference, onUserCamera, keepMounted, overscan, children, lead, chromeHidden, className }: CanvasEditorProps) {
  const ownCamera = useMemo(() => new CameraController(), []);
  const camera = givenCamera ?? ownCamera;
  const state = useMemo(() => new EditorState(), []);
  const ui = useSyncExternalStore(state.subscribe, state.get, state.get);
  const doc = useSyncExternalStore(store.subscribe, store.getDocument, store.getDocument);
  const root = useRef<HTMLDivElement | null>(null);
  const size = useRef<Size>({ w: 0, h: 0 });
  const fitted = useRef(!!givenCamera);
  const filePicker = useRef<HTMLInputElement>(null);
  const userCamera = useRef(onUserCamera);
  userCamera.current = onUserCamera;

  const resolvePicture = useMemo(() => pictureResolver(assets, resolveImageSrc), [assets, resolveImageSrc]);

  const gestures = useMemo(
    () => new GestureController({ store, camera, state, root: () => root.current, onUserCamera: () => userCamera.current?.() }),
    [store, camera, state],
  );
  useEffect(() => () => gestures.dispose(), [gestures]);

  // A wheel listener React attaches is passive and cannot stop the page scrolling.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    el.addEventListener('wheel', gestures.onWheel, { passive: false });
    return () => el.removeEventListener('wheel', gestures.onWheel);
  }, [gestures]);

  // Someone else (an agent, a peer, an undo) may delete what is selected.
  useEffect(() => state.prune((id) => !!store.getDocument().objects[id]), [doc, state, store]);

  const fit = useCallback(() => {
    const all = boundsOf(store.getDocument(), store.getDocument().order);
    if (all && size.current.w > 0) camera.set(fitRect(all, size.current, 72, 1));
  }, [camera, store]);

  const onSize = useCallback(
    (next: Size) => {
      size.current = next;
      if (!fitted.current && next.w > 0) {
        fitted.current = true;
        fit();
      }
    },
    [fit],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      userCamera.current?.();
      camera.set(zoomAt(camera.get(), camera.get().z * factor, { x: size.current.w / 2, y: size.current.h / 2 }));
    },
    [camera],
  );

  /** A line the person can read when something they did could not be done. It clears itself. */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const onEditEnd = useCallback(
    (id: ObjectId, text: string) => {
      const object = store.getDocument().objects[id];
      state.set({ editingId: null });
      if (!object) return;
      const first = firstEditGesture(id);
      if (object.type === 'frame') {
        if (text !== object.title && !store.dispatch({ type: 'edit', id, patch: { title: text } }).ok) setNotice(CANVAS_STRINGS.textNotKept);
        return;
      }
      if (!('text' in object)) return;
      if (text === '' && object.text === '') {
        // Placed and left empty: it was never wanted. Gone, with no step left behind.
        if (!store.revert(first) && object.type === 'text') store.dispatch({ type: 'delete', ids: [id] });
        state.prune((other) => !!store.getDocument().objects[other]);
        return;
      }
      if (text === '' && object.type === 'text') {
        // Bare text with no words is nothing to see and nothing to grab: emptying it removes it.
        store.dispatch({ type: 'delete', ids: [id] });
        return;
      }
      if (text === object.text) return;
      // The words typed straight after placing it join that step.
      if (!store.dispatch({ type: 'edit', id, patch: { text } }, { gesture: first }).ok) setNotice(CANVAS_STRINGS.textNotKept);
    },
    [state, store],
  );

  const selected = [...ui.selection];
  const recolor = (color: CanvasColor | null, gesture?: string) => store.dispatch({ type: 'recolor', ids: selected, color }, { gesture });
  const remove = () => store.dispatch({ type: 'delete', ids: selected });
  const group = () => store.dispatch({ type: 'group', id: createId('group'), ids: selected });
  const ungroup = () => store.dispatch({ type: 'ungroup', ids: [...new Set(selected.map((id) => doc.objects[id]?.group).filter((id): id is string => !!id))] });

  /** Take the snapshot (the planner captures it), then hand it to the host. One undo step takes it back out. */
  const takeSnapshot = (drop: PlanDropTarget | null) => {
    const current = store.getDocument();
    const input = ui.region ? snapshotFromRegion(current, indexFor(store), ui.region) : snapshotFromSelection(current, ui.selection);
    if (!input) return;
    const result = store.dispatch({ type: 'add-snapshot', snapshot: input });
    const taken = store.getDocument().snapshots[input.id];
    if (!result.ok || !taken) return;
    state.set({ region: null });
    onAddToPlan?.(taken, drop);
  };

  const addToPlan = onAddToPlan
    ? {
        onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
          if (event.button !== 0) return;
          beginPlanDrag(event.nativeEvent, { label: CANVAS_STRINGS.addToPlan, onDrop: (target) => takeSnapshot(target), onClick: () => takeSnapshot(null) });
        },
        // A pointer press is handled above. This is the keyboard's press.
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          if (event.detail === 0) takeSnapshot(null);
        },
      }
    : undefined;

  const viewCentre = () => ({ x: camera.get().x + size.current.w / camera.get().z / 2, y: camera.get().y + size.current.h / camera.get().z / 2 });

  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const addImageFile = useCallback(
    (file: File) => {
      void addPicture(store, assetsRef.current, file, viewCentre()).then((result) => {
        if ('id' in result) state.select([result.id]);
        else setNotice(CANVAS_STRINGS.pictureProblems[result.problem]);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera, state, store],
  );

  const pickImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) addImageFile(file);
  };

  // Paste is the main way a link, an artifact or a picture gets onto the
  // board. It belongs to the editor the person last touched, and never to a
  // text field.
  const ports = useRef({ linkPreview, resolvePaste });
  ports.current = { linkPreview, resolvePaste };
  useEffect(() => {
    let mine = false;
    const track = (event: PointerEvent) => {
      mine = !!root.current?.contains(event.target as Node);
    };
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!mine || !root.current?.isConnected || target?.closest?.('input, textarea, [contenteditable]')) return;
      const picture = [...(event.clipboardData?.files ?? [])].find(looksLikePicture);
      if (picture) {
        event.preventDefault();
        addImageFile(picture);
        return;
      }
      const reference = referenceFromPaste(event.clipboardData?.getData('text/plain') ?? '', ports.current.resolvePaste);
      if (!reference) return;
      event.preventDefault();
      const id = addReference(store, viewCentre(), reference, ports.current.linkPreview);
      if (id) state.select([id]);
    };
    document.addEventListener('pointerdown', track, true);
    document.addEventListener('paste', paste);
    return () => {
      document.removeEventListener('pointerdown', track, true);
      document.removeEventListener('paste', paste);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addImageFile, state, store]);

  const openReference = (reference: ReferenceObject) => {
    if (onOpenReference) onOpenReference(reference);
    else if (reference.target.kind === 'web') window.open(reference.target.url, '_blank', 'noopener,noreferrer');
  };

  // ── Reaching objects without a pointer ──────────────────────────────────
  // Tab comes onto the board at one object, then walks the objects in reading order; from an object it goes
  // to that object's own bar and on to the next object. Enter starts typing in it, or opens a card. These are
  // how a keyboard reaches what a pointer reaches, not shortcuts: no key does anything a button does not.
  const order = useMemo(() => readingOrder(doc), [doc]);
  const tabStop = (selected.length === 1 && order.includes(selected[0]) ? selected[0] : order[0]) ?? null;

  const focusObject = useCallback(
    (id: ObjectId) => {
      const bounds = objectBounds(store.getDocument(), id);
      if (!bounds) return;
      state.select([id]);
      // Bring it into view if it is not, keeping the zoom.
      const view = viewportRect(camera.get(), size.current);
      if (!rectContainsRect(view, bounds)) {
        camera.set({ x: bounds.x + bounds.w / 2 - view.w / 2, y: bounds.y + bounds.h / 2 - view.h / 2, z: camera.get().z });
      }
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`.pcv-obj[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }));
    },
    [camera, state, store],
  );

  const onBoardKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.nativeEvent.isComposing) return;
    if (target.isContentEditable) {
      // Escape ends typing and leaves focus on the object that was being typed in.
      if (event.key === 'Escape') {
        const owner = target.closest<HTMLElement>('.pcv-obj');
        event.stopPropagation();
        target.blur();
        owner?.focus({ preventScroll: true });
      }
      return;
    }
    const current = store.getDocument();
    if (target.classList.contains('pcv-obj')) {
      const id = target.dataset.id ?? '';
      const object = current.objects[id];
      if (event.key === 'Enter' && object) {
        event.preventDefault();
        if (object.type === 'reference') openReference(object);
        else if (object.type === 'box' || object.type === 'note' || object.type === 'text' || object.type === 'frame') state.set({ editingId: id });
        return;
      }
      if (event.key !== 'Tab') return;
      const bar = root.current?.querySelector<HTMLElement>('.pcv-bar-selection button, .pcv-bar-selection input');
      if (!event.shiftKey && bar) {
        event.preventDefault();
        bar.focus();
        return;
      }
      const next = neighbourInReadingOrder(current, id, event.shiftKey ? -1 : 1);
      if (next) {
        event.preventDefault();
        focusObject(next);
      }
      return;
    }
    const bar = target.closest<HTMLElement>('.pcv-bar-selection');
    if (event.key === 'Tab' && bar && selected.length === 1) {
      const stops = [...bar.querySelectorAll<HTMLElement>('button, input')];
      if (event.shiftKey && target === stops[0]) {
        event.preventDefault();
        focusObject(selected[0]);
      } else if (!event.shiftKey && target === stops[stops.length - 1]) {
        const next = neighbourInReadingOrder(current, selected[0], 1);
        if (next) {
          event.preventDefault();
          focusObject(next);
        }
      }
    }
  };

  const single = selected.length === 1 ? doc.objects[selected[0]] : undefined;
  const handles =
    single && 'w' in single && !ui.editingId
      ? HANDLES.map((handle) => (
          <div
            key={handle}
            className="pcv-handle"
            data-handle={handle}
            data-for={single.id}
            style={{ transform: `translate(${handle.endsWith('w') ? single.x : single.x + single.w}px, ${handle.startsWith('n') ? single.y : single.y + single.h}px)` }}
          />
        ))
      : null;

  // Ports: a ring at the middle of each side of the one selected shape. Dragging from one draws a connector.
  const portRings =
    single && 'w' in single && single.type !== 'frame' && single.type !== 'stamp' && !ui.editingId && ui.carried.size === 0
      ? (['n', 'e', 's', 'w'] as const).map((side) => {
          const at = portPoint(single, side);
          return <div key={side} className="pcv-port" data-port={side} data-for={single.id} style={{ transform: `translate(${at.x}px, ${at.y}px)` }} />;
        })
      : null;
  const guides = ui.guides.map((guide, i) => (
    <React.Fragment key={i}>
      <div
        className="pcv-guide"
        data-axis={guide.axis}
        style={guide.axis === 'x' ? { transform: `translate(${guide.at}px, ${guide.from}px)`, height: guide.to - guide.from } : { transform: `translate(${guide.from}px, ${guide.at}px)`, width: guide.to - guide.from }}
      />
      {guide.gap ? (
        <div className="pcv-guide-badge" style={{ transform: guide.axis === 'x' ? `translate(${guide.at}px, ${guide.gap.at}px)` : `translate(${guide.gap.at}px, ${guide.at}px)` }}>
          <span>{guide.gap.distance}</span>
        </div>
      ) : null}
    </React.Fragment>
  ));

  const c = camera.get();
  const regionOverlay = ui.region ? (
    <div className="pcv-region" style={{ transform: `translate(${ui.region.x}px, ${ui.region.y}px)`, width: ui.region.w, height: ui.region.h, borderWidth: 'calc(1.5px / var(--pcv-z))' }} />
  ) : null;
  const draft = ui.draftArrow ? { from: worldToScreen(c, ui.draftArrow.from), to: worldToScreen(c, ui.draftArrow.to) } : null;

  return (
    <CanvasView
      store={store}
      camera={camera}
      selection={ui.selection}
      editingId={ui.editingId}
      tabStop={tabStop}
      carried={ui.carried}
      onEditEnd={onEditEnd}
      resolveImageSrc={resolvePicture}
      keepMounted={keepMounted}
      overscan={overscan}
      lead={chromeHidden ? null : lead}
      onSize={onSize}
      rootRef={root}
      rootProps={{
        className,
        'data-interactive': '',
        'data-tool': ui.tool,
        // A press on the board must not move focus by itself: placing an object focuses its words in the same
        // press, and the browser's own focus change would take that straight back. Bars and fields keep theirs.
        onMouseDown: (event) => {
          if (!(event.target as HTMLElement).closest?.('.pcv-bar, [contenteditable], input, button')) event.preventDefault();
        },
        onKeyDown: onBoardKey,
        // Focus arriving on an object by keyboard selects it, so its bar appears.
        onFocus: (event) => {
          const el = event.target as HTMLElement;
          const id = el.classList.contains('pcv-obj') ? el.dataset.id : undefined;
          if (id && !(ui.selection.size === 1 && ui.selection.has(id)) && el.matches(':focus-visible')) state.select([id]);
        },
        onPointerDown: gestures.onPointerDown,
        onPointerMove: gestures.onPointerMove,
        onPointerUp: gestures.onPointerUp,
        onPointerCancel: gestures.onPointerCancel,
        onDoubleClick: (event) => {
          const hit = (event.target as HTMLElement).closest?.<HTMLElement>('.pcv-card')?.dataset.id;
          const object = hit ? store.getDocument().objects[hit] : undefined;
          if (object?.type === 'reference' && ui.tool === 'select') openReference(object);
          else gestures.onDoubleClick(event);
        },
      }}
      worldOverlay={
        <>
          {regionOverlay}
          {guides}
          {ui.carried.size === 0 ? handles : null}
          {portRings}
        </>
      }
    >
      {ui.marquee ? <div className="pcv-marquee" style={{ transform: `translate(${ui.marquee.x}px, ${ui.marquee.y}px)`, width: ui.marquee.w, height: ui.marquee.h }} /> : null}
      {draft ? (
        <svg className="pcv-draft-arrow" aria-hidden="true">
          <line x1={draft.from.x} y1={draft.from.y} x2={draft.to.x} y2={draft.to.y} stroke="currentColor" strokeWidth={1.5} strokeDasharray="5 4" />
        </svg>
      ) : null}
      {chromeHidden ? null : (
        <>
          <SelectionBar
            store={store}
            camera={camera}
            doc={doc}
            selection={ui.selection}
            region={ui.region}
            hidden={!!ui.marquee || !!ui.editingId || ui.tool === 'region' || ui.carried.size > 0}
            onRecolor={recolor}
            onDelete={remove}
            onGroup={group}
            onUngroup={ungroup}
            addToPlan={addToPlan}
            onOpen={single?.type === 'reference' && (onOpenReference || single.target.kind === 'web') ? () => openReference(single) : undefined}
          />
          <ToolDock state={state} tool={ui.tool} onPickImage={assets ? () => filePicker.current?.click() : undefined} canSnapshot={!!onAddToPlan} />
          <HistoryBar store={store} />
          <ZoomBar camera={camera} onZoom={zoomBy} onFit={fit} onReset={() => zoomBy(1 / camera.get().z)} />
          {children}
        </>
      )}
      {notice ? (
        <div className="pcv-notice" role="status">
          {notice}
        </div>
      ) : null}
      <input ref={filePicker} type="file" accept="image/*,.heic,.heif,.tif,.tiff,.bmp" hidden onChange={pickImage} />
    </CanvasView>
  );
}
