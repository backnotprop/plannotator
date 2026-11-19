/**
 * A thread's canvas: the real Excalidraw editor (the lazy `#canvas-board`
 * chunk; nothing here loads until a person opens a canvas or the Inbox asks
 * this window to draw one for an agent).
 *
 * The scene lives with the thread in the Inbox (packages/server/inbox-canvas.ts).
 * This saves every change a moment after it is made, takes an agent's change
 * the moment it lands (the stream's `event: canvas`), and never lets one
 * replace what the person is doing: an element the person changed since the
 * last save stays as they have it.
 *
 * The bar under the canvas sends it with a reply: the whole sketch, or only
 * what is selected ("work on this"). The agent gets a picture and a text
 * reading of the same things (the reply route's `sketch`).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, convertToExcalidrawElements, exportToCanvas, getSceneVersion, restoreElements, serializeAsJSON, sceneCoordsToViewportCoords } from '@excalidraw/excalidraw';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import excalidrawCss from '@excalidraw/excalidraw/index.css?inline';
import { authorWords, type CanvasLogEntry } from '@plannotator/shared/inbox/canvas/changes';
import { thingsOf } from '@plannotator/shared/inbox/canvas/reading';
import { boxOf, boxesOverlap, unionBox, type Box, type CanvasElement, type CanvasScene } from '@plannotator/shared/inbox/canvas/scene';
import boardCss from './canvas.css?inline';
import { CANVAS_WINDOW, canvasApi, subscribeCanvasFrames, type CanvasFrame, type CanvasJob, type CanvasReply } from './canvasApi';

export interface CanvasBoardProps {
  threadId: string;
  dark: boolean;
  /** Who a reply from here reaches, as the thread names it ("Claude Code"); null when nobody is known. */
  agent: string | null;
  /** The reply the bar sends: its words, its pictures and scene file, and what the agent reads of the canvas. */
  onSend: (reply: CanvasReply) => void;
}

const SAVE_AFTER_MS = 450;
const PICTURE_AFTER_MS = 1500;
const PAD = 24;
const PICTURE_MAX = 2400;

function withStyles(): void {
  if (document.getElementById('ibc-styles')) return;
  const style = document.createElement('style');
  style.id = 'ibc-styles';
  style.textContent = `${excalidrawCss}\n${boardCss}`;
  document.head.appendChild(style);
}

const asCanvas = (elements: readonly ExcalidrawElement[]) => elements as unknown as CanvasElement[];
const asExcalidraw = (elements: readonly CanvasElement[]) => elements as unknown as ExcalidrawElement[];
const sig = (el: { version?: number; versionNonce?: number; isDeleted?: boolean }) => `${el.version ?? 0}:${el.versionNonce ?? 0}:${el.isDeleted ? 1 : 0}`;

/**
 * Elements from the Inbox, made whole for the editor: defaults filled in, labels centred on what they label. Text is
 * not measured again here: the drawing fonts may not be in yet, and text measured with a stand-in face is cut off
 * when the real one draws it (the server sizes an agent's text generously instead, apply.ts).
 */
function restored(elements: readonly CanvasElement[]): ExcalidrawElement[] {
  const out = restoreElements(asExcalidraw(elements), null, { refreshDimensions: false, repairBindings: true }) as ExcalidrawElement[];
  const byId = new Map(out.map((e) => [e.id, e]));
  return out.map((el) => {
    // A label an agent placed was sized by guess on the server: now that it is measured, centre it again.
    if (el.type !== 'text' || !el.containerId || !(el.customData as { by?: string } | undefined)?.by) return el;
    const container = byId.get(el.containerId);
    if (!container) return el;
    const box = boxOf(container as unknown as CanvasElement);
    const x = box.x + box.w / 2 - el.width / 2;
    const y = box.y + box.h / 2 - el.height / 2;
    return Math.abs(x - el.x) < 0.5 && Math.abs(y - el.y) < 0.5 ? el : { ...el, x, y };
  });
}

interface Drawn {
  blob: Blob;
  canvas?: HTMLCanvasElement;
  place: { x: number; y: number; w: number; h: number; scale: number };
}

/** A PNG of some elements, always on white in the light look (what an agent reads must not depend on the person's theme). */
async function draw(elements: readonly ExcalidrawElement[], files: BinaryFiles, max = PICTURE_MAX): Promise<Drawn | null> {
  const shown = elements.filter((e) => !e.isDeleted);
  if (shown.length === 0) return null;
  let scale = 1;
  const canvas = await exportToCanvas({
    elements: shown,
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
    files,
    exportPadding: PAD,
    getDimensions: (width: number, height: number) => {
      scale = Math.min(2, max / Math.max(width, height, 1));
      return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
    },
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return { blob, canvas, place: { x: 0, y: 0, w: canvas.width / scale, h: canvas.height / scale, scale } };
}

/** A part of a placed picture, with what is under and around it (a ring drawn on a photo comes with the photo). */
async function cut(whole: Drawn, part: Box, pad = 28): Promise<Blob | null> {
  if (!whole.canvas) return null;
  const { place } = whole;
  const x0 = Math.max(0, Math.floor((part.x - pad - place.x) * place.scale));
  const y0 = Math.max(0, Math.floor((part.y - pad - place.y) * place.scale));
  const x1 = Math.min(whole.canvas.width, Math.ceil((part.x + part.w + pad - place.x) * place.scale));
  const y1 = Math.min(whole.canvas.height, Math.ceil((part.y + part.h + pad - place.y) * place.scale));
  if (x1 - x0 < 4 || y1 - y0 < 4) return null;
  const out = document.createElement('canvas');
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext('2d')?.drawImage(whole.canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
}

/** The same picture, with where on the canvas it is. */
async function drawPlaced(elements: readonly ExcalidrawElement[], files: BinaryFiles): Promise<Drawn | null> {
  const shown = elements.filter((e) => !e.isDeleted);
  const drawn = await draw(shown, files);
  if (!drawn) return null;
  const around = unionBox(asCanvas(shown).map(boxOf));
  // The picture is the elements' bounds with the padding around them; a stroke's width can push it a little past, which the size carries.
  return { blob: drawn.blob, canvas: drawn.canvas, place: { ...drawn.place, x: around.x - (drawn.place.w - around.w) / 2, y: around.y - (drawn.place.h - around.h) / 2 } };
}

/** The boards open in this window, so a drawing job reads what is on screen, not the last save. */
const openBoards = new Map<string, () => { elements: readonly ExcalidrawElement[]; files: BinaryFiles }>();

/** A drawing job from the Inbox, for an agent (canvasApi.ts `onCanvasJob`): a picture of a canvas or a part, or mermaid text as shapes. */
export async function runCanvasJob(job: CanvasJob): Promise<void> {
  if (job.kind === 'mermaid') {
    const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
    const drawn: Record<string, unknown> = {};
    for (const text of job.texts ?? []) {
      try {
        const parsed = await parseMermaidToExcalidraw(text);
        if (parsed.files && Object.keys(parsed.files).length > 0) {
          drawn[text] = { error: 'this kind of mermaid diagram becomes one picture, not shapes; a flowchart (flowchart TD / LR) becomes real boxes and arrows' };
          continue;
        }
        drawn[text] = convertToExcalidrawElements(parsed.elements, { regenerateIds: true });
      } catch (error) {
        drawn[text] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    await canvasApi.answerMermaid(job.id, drawn);
    return;
  }
  if (!job.thread_id) return;
  try {
    const live = openBoards.get(job.thread_id)?.();
    let elements: readonly ExcalidrawElement[];
    let files: BinaryFiles;
    if (live) ({ elements, files } = live);
    else {
      const read = await canvasApi.read(job.thread_id);
      elements = restored(read.scene.elements);
      files = read.scene.files as BinaryFiles;
    }
    let shown = elements.filter((e) => !e.isDeleted);
    if (job.box) {
      const box = job.box;
      const inside = new Set(asCanvas(shown).filter((e) => e.type !== 'frame' && boxesOverlap(boxOf(e), box)).map((e) => e.id));
      shown = shown.filter((e) => inside.has(e.id) || (e.type === 'text' && e.containerId && inside.has(e.containerId)));
    }
    const drawn = await drawPlaced(shown, files);
    await canvasApi.answerPicture(job.id, drawn?.blob ?? null, drawn?.place);
  } catch {
    await canvasApi.answerPicture(job.id, null).catch(() => {});
  }
}

function changeWords(entries: CanvasLogEntry[]): { who: string; text: string } | null {
  const mine = entries.filter((e) => e.by.kind === 'agent');
  if (mine.length === 0) return null;
  const who = authorWords(mine[mine.length - 1]!.by);
  const count = { added: 0, changed: 0, removed: 0 };
  for (const entry of mine) for (const change of entry.changes) count[change.op]++;
  const parts = [count.added ? `added ${count.added}` : '', count.changed ? `changed ${count.changed}` : '', count.removed ? `removed ${count.removed}` : ''].filter(Boolean);
  return { who, text: parts.join(', ') || 'changed the canvas' };
}

export default function CanvasBoard({ threadId, dark, agent, onSend }: CanvasBoardProps) {
  useLayoutEffect(withStyles, []);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [initial, setInitial] = useState<{ elements: ExcalidrawElement[]; files: BinaryFiles; background: string | undefined } | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [empty, setEmpty] = useState(true);
  const [words, setWords] = useState('');
  const [state, setState] = useState<{ text: string; bad?: boolean } | null>(null);
  const [note, setNote] = useState<{ who: string; text: string; ids: string[] } | null>(null);
  const [flashes, setFlashes] = useState<{ key: string; box: Box }[]>([]);
  const [busy, setBusy] = useState(false);

  /** The revision this window holds, and each element as the Inbox last had it (what differs is the person's unsaved work). */
  const rev = useRef(0);
  const synced = useRef(new Map<string, string>());
  const sentFiles = useRef(new Set<string>());
  const lastVersion = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pictureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const pointerDown = useRef(false);
  const live = useRef(true);

  /** Take a scene from the Inbox into the editor, keeping what the person changed since the last save. */
  const take = useCallback((scene: CanvasScene): void => {
    const editor = api.current;
    if (!editor) return;
    const local = editor.getSceneElementsIncludingDeleted();
    const mine = new Map(local.map((e) => [e.id, e]));
    const editing = editor.getAppState().editingTextElement?.id ?? null;
    const merged: CanvasElement[] = [];
    const taken = new Set<string>();
    const seen = new Set<string>();
    for (const remote of scene.elements) {
      seen.add(remote.id);
      const here = mine.get(remote.id);
      const dirty = !!here && synced.current.get(here.id) !== sig(here);
      const theirs = !here || (!dirty && here.id !== editing && sig(here) !== sig(remote) && (remote.version ?? 0) >= here.version) || (remote.version ?? 0) > here.version;
      merged.push(theirs ? remote : (here as unknown as CanvasElement));
      if (theirs) taken.add(remote.id);
      synced.current.set(remote.id, sig(remote));
    }
    for (const here of local) if (!seen.has(here.id)) merged.push(here as unknown as CanvasElement);
    const files = Object.values(scene.files as Record<string, BinaryFileData>).filter((file) => file && !sentFiles.current.has(file.id));
    for (const file of files) sentFiles.current.add(file.id);
    if (files.length > 0) editor.addFiles(files);
    const next = restored(merged);
    lastVersion.current = '';
    editor.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
    // What the editor re-stamped while taking it in is the Inbox's change still, not the person's.
    for (const el of editor.getSceneElementsIncludingDeleted()) if (taken.has(el.id)) synced.current.set(el.id, sig(el));
  }, []);

  const sceneNow = (): CanvasScene | null => {
    const editor = api.current;
    if (!editor) return null;
    const all = editor.getFiles();
    const files: BinaryFiles = {};
    for (const [id, file] of Object.entries(all)) if (!sentFiles.current.has(id)) files[id] = file;
    return {
      type: 'excalidraw',
      version: 2,
      source: window.location.origin,
      elements: asCanvas(editor.getSceneElementsIncludingDeleted()),
      appState: { viewBackgroundColor: editor.getAppState().viewBackgroundColor },
      files: files as Record<string, unknown>,
    };
  };

  const storePicture = useCallback(() => {
    if (pictureTimer.current) clearTimeout(pictureTimer.current);
    pictureTimer.current = setTimeout(() => {
      const editor = api.current;
      if (!editor || !live.current) return;
      const at = rev.current;
      void drawPlaced(editor.getSceneElements(), editor.getFiles())
        .then((drawn) => (drawn ? canvasApi.picture(threadId, at, drawn.blob, drawn.place) : undefined))
        .catch(() => {});
    }, PICTURE_AFTER_MS);
  }, [threadId]);

  const save = useCallback((): Promise<void> => {
    if (saving.current) {
      again.current = true;
      return saving.current;
    }
    const scene = sceneNow();
    if (!scene) return Promise.resolve();
    const sent = new Map(scene.elements.map((e) => [e.id, sig(e)]));
    // What the Inbox holds that this window no longer does (a file loaded over the canvas): gone, not "never seen".
    const gone = [...synced.current.keys()].filter((id) => !sent.has(id));
    const run = canvasApi
      .save(threadId, scene, rev.current, { gone })
      .then((answer) => {
        for (const id of Object.keys(scene.files)) sentFiles.current.add(id);
        for (const id of gone) synced.current.delete(id);
        for (const [id, value] of sent) synced.current.set(id, value);
        if (answer.scene) take(answer.scene);
        rev.current = answer.rev;
        if (live.current) setState((now) => (now?.bad ? null : now));
        storePicture();
      })
      .catch(() => {
        if (live.current) setState({ text: 'Not saved yet. It will try again as you draw.', bad: true });
      })
      .finally(() => {
        saving.current = null;
        if (again.current) {
          again.current = false;
          void save();
        }
      });
    saving.current = run;
    return run;
    // sceneNow reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, take, storePicture]);

  const saveSoon = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void save();
    }, SAVE_AFTER_MS);
  }, [save]);

  /** Everything unsaved is in the Inbox when this settles. */
  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      await save();
    }
    while (saving.current) await saving.current;
  }, [save]);

  // The scene, read once.
  useEffect(() => {
    live.current = true;
    const stop = new AbortController();
    canvasApi
      .read(threadId, undefined, stop.signal)
      .then((read) => {
        rev.current = read.rev;
        for (const el of read.scene.elements) synced.current.set(el.id, sig(el));
        for (const id of Object.keys(read.scene.files)) sentFiles.current.add(id);
        setEmpty(!read.scene.elements.some((e) => !e.isDeleted));
        setInitial({ elements: restored(read.scene.elements), files: read.scene.files as BinaryFiles, background: read.scene.appState.viewBackgroundColor as string | undefined });
      })
      .catch(() => {
        if (!stop.signal.aborted) setFailed(true);
      });
    return () => {
      live.current = false;
      stop.abort();
    };
  }, [threadId]);

  // Open boards answer drawing jobs from what is on screen; leaving saves what is not saved yet.
  useEffect(() => {
    openBoards.set(threadId, () => ({ elements: api.current?.getSceneElements() ?? [], files: api.current?.getFiles() ?? {} }));
    const leaving = () => {
      const scene = sceneNow();
      if (scene && saveTimer.current) void canvasApi.save(threadId, scene, rev.current, { keepalive: true }).catch(() => {});
    };
    window.addEventListener('pagehide', leaving);
    return () => {
      window.removeEventListener('pagehide', leaving);
      openBoards.delete(threadId);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void save();
      }
      if (pictureTimer.current) clearTimeout(pictureTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  // Escape belongs to the drawing (drop a tool, leave a text, clear a selection): it never closes the thread under
  // the canvas. The window's own Escape skips a key marked used. Marked on the way down, because Excalidraw takes
  // its text box out of the page while the key is still on its way up, and a key from nowhere reads as the thread's.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target instanceof Element ? event.target : null;
      const here = !target || target === document.body || target === document.documentElement || !target.isConnected || !!root.current?.contains(target) || !!target.closest('.excalidraw');
      if (here) event.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /** Show the person what changed: a wash over each changed thing, and the view brought to them when they are out of sight. */
  const reveal = useCallback((ids: string[], scroll: boolean) => {
    const editor = api.current;
    const host = stage.current;
    if (!editor || !host || ids.length === 0) return;
    const wanted = new Set(ids);
    const found = editor.getSceneElements().filter((e) => wanted.has(e.id));
    // A frame that only grew around what was added is not what to look at; the things in it are.
    const inner = found.filter((e) => e.type !== 'frame');
    const changed = inner.length > 0 ? inner : found;
    if (changed.length === 0) return;
    const show = () => {
      const appState = editor.getAppState();
      const rect = host.getBoundingClientRect();
      // One wash per thing, not per element: a label shares its box's.
      const boxes = asCanvas(changed).filter((e) => !(e.type === 'text' && e.containerId && wanted.has(e.containerId))).map(boxOf);
      const out = boxes.slice(0, 40).map((box, i) => {
        const a = sceneCoordsToViewportCoords({ sceneX: box.x, sceneY: box.y }, appState);
        const b = sceneCoordsToViewportCoords({ sceneX: box.x + box.w, sceneY: box.y + box.h }, appState);
        return { key: `${Date.now()}-${i}`, box: { x: a.x - rect.left - 6, y: a.y - rect.top - 6, w: b.x - a.x + 12, h: b.y - a.y + 12 } };
      });
      setFlashes(out);
      setTimeout(() => live.current && setFlashes((now) => (now === out ? [] : now)), 2500);
    };
    // Already in view: the view stays where the person has it.
    const rect = host.getBoundingClientRect();
    const view = editor.getAppState();
    const inView = asCanvas(changed).every((el) => {
      const box = boxOf(el);
      const a = sceneCoordsToViewportCoords({ sceneX: box.x, sceneY: box.y }, view);
      const b = sceneCoordsToViewportCoords({ sceneX: box.x + box.w, sceneY: box.y + box.h }, view);
      return a.x >= rect.left && a.y >= rect.top + 56 && b.x <= rect.right && b.y <= rect.bottom - 56;
    });
    if (scroll && !inView) {
      editor.scrollToContent(changed, { fitToViewport: true, viewportZoomFactor: 0.75, maxZoom: 1, animate: true, duration: 350 });
      setTimeout(show, 420);
    } else show();
  }, []);

  // An agent's change, or another window's save: take it in.
  useEffect(() => {
    const onFrame = (frame: CanvasFrame) => {
      if (frame.thread_id !== threadId || frame.window === CANVAS_WINDOW || frame.rev <= rev.current) return;
      const since = rev.current;
      void canvasApi
        .read(threadId, since)
        .then((read) => {
          if (!live.current || read.rev <= rev.current) return;
          take(read.scene);
          rev.current = read.rev;
          setEmpty(!read.scene.elements.some((e) => !e.isDeleted));
          const said = changeWords(read.changes);
          if (!said) return;
          const ids = read.changes.filter((e) => e.by.kind === 'agent').flatMap((e) => e.changes.filter((c) => c.op !== 'removed').flatMap((c) => c.elements));
          setNote({ ...said, ids });
          // Mid-stroke the view stays where the person has it; the note's Show brings them there.
          reveal(ids, !pointerDown.current);
          storePicture();
        })
        .catch(() => {});
    };
    return subscribeCanvasFrames(onFrame);
  }, [threadId, take, reveal, storePicture]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const count = elements.reduce((n, e) => n + (!e.isDeleted && appState.selectedElementIds[e.id] ? 1 : 0), 0);
      setSelected(count);
      // Where the view is, for a browser test to find a thing on screen: x = (sceneX + scrollX) * zoom, from the stage's corner.
      stage.current?.setAttribute('data-view', `${Math.round(appState.scrollX)},${Math.round(appState.scrollY)},${appState.zoom.value}`);
      const version = `${getSceneVersion(elements)}:${elements.length}:${appState.viewBackgroundColor}:${Object.keys(files).length}`;
      if (version === lastVersion.current) return;
      lastVersion.current = version;
      setEmpty(!elements.some((e) => !e.isDeleted));
      // The scene as the Inbox has it (just read, or just taken from it): nothing of the person's to save.
      if (elements.length === synced.current.size && elements.every((e) => synced.current.get(e.id) === sig(e)) && Object.keys(files).every((id) => sentFiles.current.has(id))) return;
      saveSoon();
    },
    [saveSoon],
  );

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const editor = api.current;
    if (!editor || busy || empty) return;
    setBusy(true);
    setState({ text: 'Sending…' });
    try {
      await flush();
      const all = editor.getSceneElements();
      const files = editor.getFiles();
      const appState = editor.getAppState();
      const picked = new Set(all.filter((e) => appState.selectedElementIds[e.id]).map((e) => e.id));
      // A picked shape brings its label, a picked frame what it holds.
      for (const el of all) {
        if ((el.type === 'text' && el.containerId && picked.has(el.containerId)) || (el.frameId && picked.has(el.frameId))) picked.add(el.id);
      }
      const out: File[] = [];
      const pictures: Record<string, string> = {};
      const png = (drawn: Drawn, name: string) => out.push(new File([drawn.blob], name, { type: 'image/png' }));
      const sceneFile = (elements: readonly ExcalidrawElement[], name: string) => {
        const used = new Set(elements.map((e) => (e.type === 'image' ? e.fileId : null)).filter(Boolean));
        const kept = Object.fromEntries(Object.entries(files).filter(([id]) => used.has(id as never)));
        out.push(new File([serializeAsJSON(elements, appState, kept, 'local')], name, { type: 'application/json' }));
      };
      if (picked.size > 0) {
        const chosen = all.filter((e) => picked.has(e.id));
        const drawn = await draw(chosen, files);
        if (drawn) png(drawn, 'canvas-selection.png');
        sceneFile(chosen, 'canvas-selection.excalidraw');
        onSend({ words: words.trim(), files: out, sketch: { kind: 'selection', elements: [...picked], pictures } });
      } else {
        const whole = await drawPlaced(all, files);
        if (whole) png(whole, 'canvas.png');
        // Each freehand drawing as its own picture, so nobody groups a face by hand and no model has to find it in the whole.
        const things = thingsOf({ type: 'excalidraw', version: 2, source: '', elements: asCanvas(all), appState: {}, files: {} });
        const sketches = things.filter((t) => t.kind === 'sketch').sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h).slice(0, 6);
        if (things.length === 1 && sketches.length === 1) pictures[sketches[0]!.id] = 'canvas.png';
        else {
          for (const [i, sketch] of sketches.entries()) {
            const part = whole ? await cut(whole, sketch.box) : null;
            if (!part) continue;
            const name = `sketch-${i + 1}.png`;
            out.push(new File([part], name, { type: 'image/png' }));
            pictures[sketch.id] = name;
          }
        }
        sceneFile(all, 'canvas.excalidraw');
        onSend({ words: words.trim(), files: out, sketch: { kind: 'sketch', elements: [], pictures } });
      }
      setWords('');
      // What was picked has gone with the reply: the selection (and Excalidraw's panel for it) steps aside for the answer.
      if (picked.size > 0) editor.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
      setState({ text: agent ? `Sent to ${agent}. Its changes land here.` : 'Sent with your reply.' });
    } catch {
      setState({ text: 'That did not send. Try again.', bad: true });
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <div className="ibc-root">
        <div className="ibc-wait" role="status">
          The canvas could not be read. Close it and open it again.
        </div>
      </div>
    );
  }

  return (
    <div
      className="ibc-root"
      data-canvas-board={threadId}
      ref={root}
    >
      <div
        className="ibc-stage"
        ref={stage}
        onPointerDownCapture={() => {
          pointerDown.current = true;
        }}
        onPointerUpCapture={() => {
          pointerDown.current = false;
        }}
        onPointerCancelCapture={() => {
          pointerDown.current = false;
        }}
      >
        {!initial ? (
          <div className="ibc-wait" aria-busy="true" />
        ) : (
          <div className="excalidraw-host">
            <Excalidraw
              excalidrawAPI={(next) => {
                api.current = next;
                // The whole drawing in view, never larger than life.
                setTimeout(() => next.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.85, maxZoom: 1, animate: false }), 0);
                try {
                  if (performance.getEntriesByName('canvas:open').length > 0 && performance.getEntriesByName('canvas:ready').length === 0) performance.measure('canvas:ready', 'canvas:open');
                } catch {
                  // No timing: nothing to do.
                }
              }}
              initialData={{ elements: initial.elements, files: initial.files, appState: { viewBackgroundColor: initial.background ?? '#ffffff' }, scrollToContent: true }}
              onChange={onChange}
              theme={dark ? 'dark' : 'light'}
              name="canvas"
              UIOptions={{ canvasActions: { toggleTheme: false, saveToActiveFile: false } }}
            >
              <MainMenu>
                <MainMenu.DefaultItems.LoadScene />
                <MainMenu.DefaultItems.Export />
                <MainMenu.DefaultItems.SaveAsImage />
                <MainMenu.DefaultItems.ClearCanvas />
                <MainMenu.Separator />
                <MainMenu.DefaultItems.ChangeCanvasBackground />
              </MainMenu>
              <WelcomeScreen>
                <WelcomeScreen.Hints.ToolbarHint />
                <WelcomeScreen.Hints.MenuHint />
                <WelcomeScreen.Center>
                  <WelcomeScreen.Center.Heading>Sketch it, then send it with your reply. Or select a part and say what should change.</WelcomeScreen.Center.Heading>
                </WelcomeScreen.Center>
              </WelcomeScreen>
            </Excalidraw>
          </div>
        )}
        {flashes.map((flash) => (
          <span key={flash.key} className="ibc-flash" aria-hidden="true" style={{ left: flash.box.x, top: flash.box.y, width: flash.box.w, height: flash.box.h }} />
        ))}
        {note && (
          <div className="ibc-note" role="status" data-canvas-note="">
            <span className="ibc-note-text">
              <b>{note.who}</b> {note.text}
            </span>
            {note.ids.length > 0 && (
              <button type="button" onClick={() => reveal(note.ids, true)}>
                Show
              </button>
            )}
            <button type="button" className="ibc-note-x" aria-label="Dismiss" onClick={() => setNote(null)}>
              ✕
            </button>
          </div>
        )}
      </div>
      <form className="ibc-bar" onSubmit={send} data-canvas-bar="">
        <span className="ibc-what" data-on={selected > 0 ? '' : undefined} data-canvas-what="">
          {selected > 0 ? `${selected} selected` : 'Whole canvas'}
        </span>
        <input
          className="ibc-words"
          type="text"
          value={words}
          onChange={(event) => setWords(event.target.value)}
          placeholder={selected > 0 ? 'What should change here?' : 'Add a note (optional)'}
          aria-label={selected > 0 ? 'What should change in the selection' : 'Words to send with the canvas'}
          enterKeyHint="send"
        />
        {state && (
          <span className="ibc-state" role="status" data-bad={state.bad ? '' : undefined}>
            {state.text}
          </span>
        )}
        <button type="submit" className="ibc-send" disabled={busy || empty || !initial} data-canvas-send="">
          {selected > 0 ? 'Send selection' : 'Send sketch'}
        </button>
      </form>
    </div>
  );
}
