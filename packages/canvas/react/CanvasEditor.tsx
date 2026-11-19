/**
 * The canvas a person works on: the renderer, plus selection, gestures and
 * the floating bars. It owns no document logic. Everything it does to the
 * canvas is a command to the store, the same commands an agent sends.
 */
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { CanvasStore } from '../events/store';
import type { CanvasColor } from '../model/color';
import { boundsOf } from '../model/document';
import { createId } from '../model/ids';
import type { ObjectId, ReferenceObject, Snapshot } from '../model/types';
import type { LinkPreviewPort } from '../model/reference';
import { CameraController, type Size, fitRect, worldToScreen, zoomAt } from '../view/camera';
import { indexFor } from '../view/document-index';
import { snapshotFromRegion, snapshotFromSelection } from '../view/snapshot-source';
import { CanvasView } from './CanvasView';
import { CANVAS_STRINGS, HistoryBar, SelectionBar, ToolDock, ZoomBar } from './chrome';
import { EditorState } from './editor-state';
import { GestureController } from './gestures';
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
  /** Hide the bars (while a transition is running). */
  chromeHidden?: boolean;
  className?: string;
}

const HANDLES = ['nw', 'ne', 'sw', 'se'] as const;

export function CanvasEditor({ store, camera: givenCamera, onAddToPlan, resolveImageSrc, linkPreview, resolvePaste, onOpenReference, onUserCamera, keepMounted, overscan, children, chromeHidden, className }: CanvasEditorProps) {
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

  const onEditEnd = useCallback(
    (id: ObjectId, text: string) => {
      const object = store.getDocument().objects[id];
      state.set({ editingId: null });
      if (!object) return;
      if (object.type === 'frame') {
        if (text !== object.title) store.dispatch({ type: 'edit', id, patch: { title: text } });
      } else if ('text' in object && text !== object.text) {
        store.dispatch({ type: 'edit', id, patch: { text } });
      }
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

  const addImageFile = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const src = String(reader.result);
        const probe = new Image();
        const add = (w: number, h: number) => {
          // Keep it visible and grabbable whatever its shape: at most 320 on
          // the long side, at least 24 on the short one.
          const scale = Math.min(1, 320 / Math.max(w, h));
          const width = Math.max(24, Math.round(w * scale));
          const height = Math.max(24, Math.round(h * scale));
          const centre = viewCentre();
          const id = createId('image');
          const result = store.dispatch({
            type: 'add',
            objects: [{ id, type: 'image', src, alt: file.name, x: Math.round(centre.x - width / 2), y: Math.round(centre.y - height / 2), w: width, h: height }],
          });
          if (result.ok) state.select([id]);
        };
        probe.onload = () => add(probe.naturalWidth || 160, probe.naturalHeight || 120);
        // A file that is not a picture still lands on the board, showing its
        // name, so the person sees that it did not work.
        probe.onerror = () => add(160, 120);
        probe.src = src;
      };
      reader.readAsDataURL(file);
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
      const picture = [...(event.clipboardData?.files ?? [])].find((file) => file.type.startsWith('image/'));
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
      onEditEnd={onEditEnd}
      resolveImageSrc={resolveImageSrc}
      keepMounted={keepMounted}
      overscan={overscan}
      onSize={onSize}
      rootRef={root}
      rootProps={{
        className,
        'data-interactive': '',
        'data-tool': ui.tool,
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
        onContextMenu: (event) => event.preventDefault(),
      }}
      worldOverlay={
        <>
          {regionOverlay}
          {handles}
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
            hidden={!!ui.marquee || !!ui.editingId || ui.tool === 'region'}
            onRecolor={recolor}
            onDelete={remove}
            onGroup={group}
            onUngroup={ungroup}
            addToPlan={addToPlan}
            onOpen={single?.type === 'reference' && (onOpenReference || single.target.kind === 'web') ? () => openReference(single) : undefined}
          />
          <ToolDock state={state} tool={ui.tool} onPickImage={() => filePicker.current?.click()} canSnapshot={!!onAddToPlan} />
          <HistoryBar store={store} />
          <ZoomBar camera={camera} onZoom={zoomBy} onFit={fit} onReset={() => zoomBy(1 / camera.get().z)} />
          {children}
        </>
      )}
      <input ref={filePicker} type="file" accept="image/*" hidden onChange={pickImage} />
    </CanvasView>
  );
}
