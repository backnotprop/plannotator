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
import { CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, convertToExcalidrawElements, exportToCanvas, getSceneVersion, restoreElements, serializeAsJSON, sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import excalidrawCss from '@excalidraw/excalidraw/index.css?inline';
import { authorWords } from '@plannotator/shared/inbox/canvas/changes';
import { thingsOf } from '@plannotator/shared/inbox/canvas/reading';
import { boxOf, boxesOverlap, unionBox, type Box, type CanvasElement, type CanvasScene } from '@plannotator/shared/inbox/canvas/scene';
import boardCss from './canvas.css?inline';
import { CANVAS_WINDOW, canvasApi, canvasLooked, subscribeCanvasFrames, type CanvasFrame, type CanvasJob, type CanvasReply } from './canvasApi';

export interface CanvasBoardProps {
  threadId: string;
  dark: boolean;
  /** Who a reply from here reaches, as the thread names it ("Claude Code"); null when nobody is known. */
  agent: string | null;
  /** The reply box's words when the canvas opened (they may arrive a moment after it): the bar starts from them. */
  draft?: string;
  /** The bar's words as they change: they go back to the reply box when the canvas closes. */
  onWords?: (words: string) => void;
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
function restored(elements: readonly CanvasElement[], context: readonly { id: string }[] = []): ExcalidrawElement[] {
  const out = restoreElements(asExcalidraw(elements), null, { refreshDimensions: false, repairBindings: true }) as ExcalidrawElement[];
  const byId = new Map<string, ExcalidrawElement>([...(context as ExcalidrawElement[]), ...out].map((e) => [e.id, e]));
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
          drawn[text] = { error: 'Excalidraw\'s converter turns flowcharts and sequence diagrams into real shapes; this kind (class, state, ER, gantt, pie and the rest) it can only draw as one flat picture, which is refused here. Use a flowchart, or add boxes and connect them' };
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

const NUMBER = new Intl.NumberFormat('en-US');

export default function CanvasBoard({ threadId, dark, agent, draft = '', onWords, onSend }: CanvasBoardProps) {
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
  const [note, setNote] = useState<{ who: string; added: number; changed: number; removed: number; ids: string[]; rev: number } | null>(null);
  /** The selection the person was writing about was removed by someone else. */
  const [lost, setLost] = useState(false);
  const pickedSig = useRef('');
  const pickedBefore = useRef(0);
  /** Sent, and no change from the agent yet: the canvas says it waits for one. */
  const [waiting, setWaiting] = useState(false);
  // The reply box's words arrive: the bar takes them while it is still empty.
  useEffect(() => {
    if (draft) setWords((now) => now || draft);
  }, [draft]);
  useEffect(() => {
    onWords?.(words);
    // The callback is the host's latest each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setWaiting(false), 3 * 60_000);
    return () => clearTimeout(timer);
  }, [waiting]);
  const [flashes, setFlashes] = useState<{ key: string; box: Box }[]>([]);
  const [busy, setBusy] = useState(false);

  /** The revision this window holds, and each element as the Inbox last had it (what differs is the person's unsaved work). */
  const rev = useRef(0);
  const synced = useRef(new Map<string, string>());
  const sentFiles = useRef(new Set<string>());
  const fetching = useRef(new Set<string>());
  /** Something of the person's is not in the Inbox yet (a save pending, in flight, or failed). */
  const unsaved = useRef(false);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const threadGone = useRef(false);
  const [gone, setGone] = useState(false);
  /** When the person last touched the canvas: an agent's change never moves the view under their hands. */
  const lastInput = useRef(0);
  const lastVersion = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pictureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const pointerDown = useRef(false);
  const live = useRef(true);

  /** Take a scene from the Inbox into the editor, keeping what the person changed since the last save. */
  const take = useCallback((scene: CanvasScene): Set<string> => {
    const taken = new Set<string>();
    const editor = api.current;
    if (!editor) return taken;
    const local = editor.getSceneElementsIncludingDeleted();
    const mine = new Map(local.map((e) => [e.id, e]));
    const editing = editor.getAppState().editingTextElement?.id ?? null;
    const order: { id: string; remote: CanvasElement | null }[] = [];
    const seen = new Set<string>();
    for (const remote of scene.elements) {
      seen.add(remote.id);
      const here = mine.get(remote.id);
      const dirty = !!here && synced.current.get(here.id) !== sig(here);
      const theirs = !here || (!dirty && here.id !== editing && sig(here) !== sig(remote) && (remote.version ?? 0) >= here.version) || (remote.version ?? 0) > here.version;
      order.push({ id: remote.id, remote: theirs ? remote : null });
      if (theirs) taken.add(remote.id);
      synced.current.set(remote.id, sig(remote));
    }
    for (const here of local) if (!seen.has(here.id)) order.push({ id: here.id, remote: null });
    const files = Object.values(scene.files as Record<string, BinaryFileData>).filter((file) => file && !sentFiles.current.has(file.id));
    for (const file of files) sentFiles.current.add(file.id);
    if (files.length > 0) editor.addFiles(files);
    // A picture this window holds no bytes for (an agent's change or an Undo brought its element back): fetched by id.
    const held = editor.getFiles();
    for (const el of scene.elements) {
      const id = el.fileId;
      if (el.isDeleted || typeof id !== 'string' || held[id] || fetching.current.has(id)) continue;
      fetching.current.add(id);
      void canvasApi
        .file(threadId, id)
        .then((answer) => {
          sentFiles.current.add(id);
          if (live.current && answer.file) api.current?.addFiles([answer.file as BinaryFileData]);
        })
        .catch(() => {})
        .finally(() => fetching.current.delete(id));
    }
    // Nothing of theirs to take: the editor is left exactly as it is.
    if (taken.size === 0) return taken;
    // What is not taken is handed back as the very same objects the editor holds (a stroke being drawn, a text being
    // typed go on untouched); only what is taken is made new.
    const fresh = new Map(restored(order.filter((o) => o.remote).map((o) => o.remote!), local).map((e) => [e.id, e]));
    const next = order.map((o) => fresh.get(o.id) ?? mine.get(o.id)).filter((e): e is ExcalidrawElement => !!e);
    lastVersion.current = '';
    editor.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
    // What the editor re-stamped while taking it in is the Inbox's change still, not the person's.
    for (const el of editor.getSceneElementsIncludingDeleted()) if (taken.has(el.id)) synced.current.set(el.id, sig(el));
    return taken;
  }, [threadId]);

  /**
   * While a pointer is down (a stroke, a drag) nothing from the Inbox touches the editor: the newest scene waits and
   * is taken when the pointer lifts.
   */
  const waitingScene = useRef<{ scene: CanvasScene; then?: (taken: Set<string>) => void } | null>(null);
  const takeWhenFree = useCallback(
    (scene: CanvasScene, then?: (taken: Set<string>) => void) => {
      if (pointerDown.current) {
        const before = waitingScene.current?.then;
        waitingScene.current = { scene, then: before && then ? (taken) => (before(taken), then(taken)) : then ?? before };
        return;
      }
      const taken = take(scene);
      then?.(taken);
    },
    [take],
  );
  const pointerLifted = useCallback(() => {
    const held = waitingScene.current;
    if (!held) return;
    waitingScene.current = null;
    const taken = take(held.scene);
    held.then?.(taken);
  }, [take]);

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
        if (answer.scene) takeWhenFree(answer.scene);
        rev.current = answer.rev;
        unsaved.current = again.current;
        if (live.current) setState((now) => (now?.bad ? null : now));
        storePicture();
      })
      .catch((error: unknown) => {
        // The thread is gone (deleted in another window): there is nowhere to save to, and trying again will not help.
        const gone = (error as { status?: number } | null)?.status === 404;
        threadGone.current = gone;
        if (live.current) {
          setState({ text: gone ? 'Thread deleted' : 'Not saved', bad: true });
          if (gone) setGone(true);
        }
        // Tried again by itself: a few seconds on, and at once when the network is back.
        if (!gone && live.current && !retry.current) {
          retry.current = setTimeout(() => {
            retry.current = null;
            void save();
          }, 4000);
        }
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
    unsaved.current = true;
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
      .read(threadId, undefined, stop.signal, true)
      .then((read) => {
        canvasLooked(threadId);
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
      if (scene && unsaved.current && !threadGone.current) // Uncompressed: compressing waits, and a closing page's request must start at once. Only a scene under the
      // browser's 64 KB limit for such a request gets out this way; a larger one relies on the save made as the tab was put away.
      void canvasApi.save(threadId, scene, rev.current, { keepalive: true, plain: true }).catch(() => {});
    };
    // A tab put away saves at once (while the page can still wait for the answer); a page going away sends what is left.
    const hidden = () => {
      if (document.visibilityState === 'hidden' && unsaved.current && !threadGone.current) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const scene = sceneNow();
        if (scene) void canvasApi.save(threadId, scene, rev.current, { keepalive: true }).then((answer) => (rev.current = Math.max(rev.current, answer.rev))).catch(() => {});
      }
    };
    const online = () => {
      if (unsaved.current && !threadGone.current) void save();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    window.addEventListener('online', online);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      window.removeEventListener('online', online);
      openBoards.delete(threadId);
      if (retry.current) clearTimeout(retry.current);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      // Closing the canvas saves whatever is not saved, a save that failed earlier included.
      if (unsaved.current && !threadGone.current) void save();
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
      // Anywhere in the canvas's layer (its header too: focus starts on its Thread button), or nowhere in particular.
      const here = !target || target === document.body || target === document.documentElement || !target.isConnected || !!root.current?.contains(target) || !!target.closest('.excalidraw, [data-canvas-layer]');
      if (here) event.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /** Show the person what changed: a wash over each changed thing, and the view brought to them when they are out of sight. */
  const reveal = useCallback((ids: string[], scroll: boolean | 'ask') => {
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
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const around = unionBox(asCanvas(changed).map(boxOf));
    if (scroll === 'ask') {
      // The person pressed Show: everything that changed, in view.
      editor.scrollToContent(changed, { fitToViewport: true, viewportZoomFactor: 0.75, maxZoom: 1, animate: !still, duration: 350 });
      setTimeout(show, still ? 0 : 420);
    } else if (scroll && !inView && around.w * view.zoom.value <= rect.width * 0.9 && around.h * view.zoom.value <= rect.height * 0.8) {
      // By itself the view only slides, at the person's own zoom, and only to something that fits in it. Anything
      // larger or farther waits for Show: an agent's change never zooms the person out.
      editor.scrollToContent(changed, { fitToViewport: false, animate: !still, duration: 350 });
      setTimeout(show, still ? 0 : 420);
    } else show();
  }, []);

  // An agent's change, or another window's save: take it in. One read at a time, however many frames a burst holds.
  useEffect(() => {
    let reading = false;
    let more = false;
    const refresh = () => {
      if (reading) {
        more = true;
        return;
      }
      reading = true;
      const since = rev.current;
      void canvasApi
        .read(threadId, since, undefined, true)
        .then((read) => {
          canvasLooked(threadId);
          if (!live.current || read.rev <= rev.current) return;
          rev.current = read.rev;
          takeWhenFree(read.scene, (taken) => {
            setEmpty(!read.scene.elements.some((e) => !e.isDeleted));
            const agents = read.changes.filter((e) => e.by.kind === 'agent');
            if (agents.length === 0) return;
            // Only what this window took counts: a thing the person was dragging stays theirs and is not called changed.
            const count = { added: 0, changed: 0, removed: 0 };
            const ids: string[] = [];
            const now = new Map((api.current?.getSceneElementsIncludingDeleted() ?? []).map((e) => [e.id, e]));
            for (const entry of agents) {
              for (const change of entry.changes) {
                const mine = change.elements.filter((id) => taken.has(id));
                if (mine.length === 0) continue;
                count[change.op]++;
                if (change.op !== 'removed') ids.push(...mine.filter((id) => !now.get(id)?.isDeleted));
              }
            }
            // The selection the person was writing about is gone: the bar must not fall back to the whole canvas.
            const selectedNow = api.current?.getAppState().selectedElementIds ?? {};
            if (pickedBefore.current > 0 && !Object.keys(selectedNow).some((id) => now.get(id) && !now.get(id)!.isDeleted)) setLost(true);
            setWaiting(false);
            if (count.added + count.changed + count.removed === 0) return;
            const who = authorWords(agents[agents.length - 1]!.by);
            // The pill adds up until it is dismissed; Undo is for the last change, Show for all of them.
            setNote((before) => ({
              who,
              added: (before?.added ?? 0) + count.added,
              changed: (before?.changed ?? 0) + count.changed,
              removed: (before?.removed ?? 0) + count.removed,
              ids: [...new Set([...(before?.ids ?? []), ...ids])].slice(-400),
              rev: Math.max(...agents.map((e) => e.rev)),
            }));
            // The view moves by itself only when the person's hands are off the canvas for a few seconds.
            reveal(ids, Date.now() - lastInput.current > 3000 && !pointerDown.current);
            storePicture();
          });
        })
        .catch(() => {})
        .finally(() => {
          reading = false;
          if (more) {
            more = false;
            refresh();
          }
        });
    };
    const onFrame = (frame: CanvasFrame) => {
      if (frame.thread_id !== threadId || frame.window === CANVAS_WINDOW) return;
      // An agent tried and the Inbox refused it: nothing landed, and the canvas stops saying one is on its way.
      if (frame.refused) {
        setWaiting(false);
        setState({ text: `${frame.by ?? 'Agent'}: no change` });
        return;
      }
      if (frame.rev <= rev.current) return;
      refresh();
    };
    return subscribeCanvasFrames(onFrame);
  }, [threadId, takeWhenFree, reveal, storePicture]);

  const onChange = useCallback(
    (elements: readonly ExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const picked = elements.filter((e) => !e.isDeleted && appState.selectedElementIds[e.id]);
      // Things, as a person counts them (a box and its label are one), read again only when the selection changes.
      const pickedKey = picked.length === 0 ? '' : `${picked.length}:${picked[0]!.id}:${picked[picked.length - 1]!.id}`;
      if (pickedKey !== pickedSig.current) {
        pickedSig.current = pickedKey;
        const count = picked.length === 0 ? 0 : picked.length > 3000 ? picked.length : thingsOf({ type: 'excalidraw', version: 2, source: '', elements: asCanvas(picked), appState: {}, files: {} }).length;
        pickedBefore.current = count;
        setSelected(count);
        if (count > 0) setLost(false);
      }
      // Where the view is, for a browser test to find a thing on screen: x = (sceneX + scrollX) * zoom, from the stage's corner.
      stage.current?.setAttribute('data-view', `${Math.round(appState.scrollX)},${Math.round(appState.scrollY)},${appState.zoom.value}`);
      const version = `${getSceneVersion(elements)}:${elements.length}:${appState.viewBackgroundColor}:${Object.keys(files).length}`;
      if (version === lastVersion.current) return;
      lastVersion.current = version;
      // A file that is not a picture (a renamed .png): Excalidraw leaves a grey box. It is taken out and said.
      const broken = elements.filter((e) => !e.isDeleted && e.type === 'image' && (e as { status?: string }).status === 'error');
      if (broken.length > 0) {
        const ids = new Set(broken.map((e) => e.id));
        setState({ text: 'Not a picture', bad: true });
        setTimeout(() => api.current?.updateScene({ elements: api.current.getSceneElementsIncludingDeleted().map((e) => (ids.has(e.id) ? { ...e, isDeleted: true, version: e.version + 1 } : e)), captureUpdate: CaptureUpdateAction.NEVER }), 0);
      }
      // Nothing to send: no element, or only a speck (a stray tap of the pen).
      const shown = asCanvas(elements.filter((e) => !e.isDeleted));
      const all = unionBox(shown.map(boxOf));
      setEmpty(shown.length === 0 || (shown.every((e) => e.type === 'freedraw') && all.w < 4 && all.h < 4));
      // The scene as the Inbox has it (just read, or just taken from it): nothing of the person's to save.
      if (elements.length === synced.current.size && elements.every((e) => synced.current.get(e.id) === sig(e)) && Object.keys(files).every((id) => sentFiles.current.has(id))) return;
      saveSoon();
    },
    [saveSoon],
  );

  /** Take back the agent's change: what it changed is as it was, what it added is gone; what the person did since stays. */
  const undo = async (change: number) => {
    try {
      await flush();
      const answer = await canvasApi.undo(threadId, change);
      takeWhenFree(answer.scene);
      rev.current = answer.rev;
      setEmpty(!answer.scene.elements.some((e) => !e.isDeleted));
      setNote(null);
      const kept = answer.kept ?? [];
      setState({
        text: answer.already ? 'Already undone' : kept.length > 0 ? `Undone, kept: ${kept.slice(0, 2).join(', ')}${kept.length > 2 ? ` +${kept.length - 2}` : ''}` : 'Undone',
      });
      storePicture();
    } catch {
      setState({ text: "Can't undo", bad: true });
    }
  };

  /**
   * A drag that starts on a frame's empty inside draws a selection box, as it does on bare canvas. Excalidraw takes
   * such a press for the frame itself and drags it. For the length of the press the frame under the pointer is
   * locked (a locked thing is not picked up), then put back as it was; nothing is saved, its version does not move.
   */
  const held = useRef<string[]>([]);
  const overFrame = (clientX: number, clientY: number) => {
    const editor = api.current;
    if (!editor) return;
    const appState = editor.getAppState();
    if (appState.activeTool.type !== 'selection') return;
    const at = viewportCoordsToSceneCoords({ clientX, clientY }, appState);
    const edge = 10 / appState.zoom.value;
    const all = editor.getSceneElements();
    const inside = (el: ExcalidrawElement, margin: number) => {
      const box = boxOf(el as unknown as CanvasElement);
      return at.x > box.x + margin && at.x < box.x + box.w - margin && at.y > box.y + margin && at.y < box.y + box.h - margin;
    };
    const frames = all.filter((el) => el.type === 'frame' && !el.locked && inside(el, edge));
    if (frames.length === 0 || all.some((el) => el.type !== 'frame' && inside(el, -edge))) return;
    const ids = new Set(frames.map((f) => f.id));
    held.current = [...ids];
    editor.updateScene({ elements: editor.getSceneElementsIncludingDeleted().map((el) => (ids.has(el.id) ? { ...el, locked: true } : el)), captureUpdate: CaptureUpdateAction.NEVER });
  };
  const releaseFrames = () => {
    const editor = api.current;
    if (!editor || held.current.length === 0) return;
    const ids = new Set(held.current);
    held.current = [];
    editor.updateScene({ elements: editor.getSceneElementsIncludingDeleted().map((el) => (ids.has(el.id) ? { ...el, locked: false } : el)), captureUpdate: CaptureUpdateAction.NEVER });
  };

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
      setState(null);
      setNote(null);
      setWaiting(true);
    } catch {
      setState({ text: 'Not sent', bad: true });
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <div className="ibc-root">
        <div className="ibc-wait" role="status">
          Canvas not loaded
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
        onKeyDownCapture={() => {
          lastInput.current = Date.now();
        }}
        onWheelCapture={() => {
          lastInput.current = Date.now();
        }}
        onPointerDownCapture={(event) => {
          pointerDown.current = true;
          lastInput.current = Date.now();
          if (event.button === 0 && event.target instanceof HTMLCanvasElement) overFrame(event.clientX, event.clientY);
        }}
        onPointerUpCapture={() => {
          pointerDown.current = false;
          lastInput.current = Date.now();
          // After Excalidraw has finished the press: the frame is put back, and what arrived meanwhile is taken.
          setTimeout(() => {
            releaseFrames();
            pointerLifted();
          }, 0);
        }}
        onPointerCancelCapture={() => {
          pointerDown.current = false;
          setTimeout(() => {
            releaseFrames();
            pointerLifted();
          }, 0);
        }}
      >
        {!initial ? (
          <div className="ibc-wait" aria-busy="true" />
        ) : (
          <div className="excalidraw-host">
            <Excalidraw
              excalidrawAPI={(next) => {
                api.current = next;
                // The one face this build does not ship (Xiaolai, 12 MB of Chinese and Japanese handwriting) is taken off the
                // page's font list, so those characters draw in the system's face and nothing asks for a file that is not there.
                const dropUnshipped = () => {
                  for (const face of [...document.fonts]) if (face.family.replace(/["']/g, '') === 'Xiaolai') document.fonts.delete(face);
                };
                dropUnshipped();
                setTimeout(dropUnshipped, 600);
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
              // Embedding a web page cannot work here (the Inbox's pages load nothing from other sites): not offered.
              validateEmbeddable={false}
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
                  <WelcomeScreen.Center.Heading>Sketch, then Send. Or select a part.</WelcomeScreen.Center.Heading>
                </WelcomeScreen.Center>
              </WelcomeScreen>
            </Excalidraw>
          </div>
        )}
        {flashes.map((flash) => (
          <span key={flash.key} className="ibc-flash" aria-hidden="true" style={{ left: flash.box.x, top: flash.box.y, width: flash.box.w, height: flash.box.h }} />
        ))}
        {waiting && !note && (
          <div className="ibc-note ibc-waiting" role="status" data-canvas-waiting="" aria-label={`Sent to ${agent ?? 'the agent'}`}>
            <span className="ibc-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <b className="ibc-who" title={agent ?? undefined}>
              {agent ?? 'Sent'}
            </b>
          </div>
        )}
        {note && (
          <div className="ibc-note" role="status" data-canvas-note="">
            <b className="ibc-who" title={note.who}>
              {note.who}
            </b>
            <span className="ibc-counts">{[note.added ? `added ${NUMBER.format(note.added)}` : '', note.changed ? `changed ${NUMBER.format(note.changed)}` : '', note.removed ? `removed ${NUMBER.format(note.removed)}` : ''].filter(Boolean).join(', ')}</span>
            {note.ids.length > 0 && (
              <button type="button" onClick={() => reveal(note.ids, 'ask')}>
                Show
              </button>
            )}
            {note.rev > 0 && (
              <button type="button" data-canvas-undo="" onClick={() => void undo(note.rev)}>
                Undo
              </button>
            )}
            <button type="button" className="ibc-note-x" aria-label="Dismiss" onClick={() => setNote(null)}>
              ✕
            </button>
          </div>
        )}
      </div>
      <form className="ibc-bar" onSubmit={send} data-canvas-bar="">
        <span className="ibc-what" data-on={selected > 0 ? '' : undefined} data-lost={lost && selected === 0 ? '' : undefined} data-canvas-what="" aria-live="polite">
          {selected > 0 ? `${NUMBER.format(selected)} selected` : lost ? 'Selection removed' : 'Whole canvas'}
        </span>
        <textarea
          className="ibc-words"
          rows={1}
          value={words}
          maxLength={20000}
          onChange={(event) => {
            setWords(event.target.value);
            if (!event.target.value) setLost(false);
          }}
          ref={(el) => {
            // As tall as its words, up to a few lines.
            if (!el) return;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
          }}
          placeholder={selected > 0 ? 'What should change?' : 'Note (optional)'}
          aria-label={selected > 0 ? 'What should change in the selection' : 'Note to send with the canvas'}
        />
        {state && (
          <span className="ibc-state" role="status" data-bad={state.bad ? '' : undefined} title={state.text}>
            {state.text}
          </span>
        )}
        {/* A request written about a selection that was then removed is not sent about the whole canvas instead. */}
        <button type="submit" className="ibc-send" disabled={busy || empty || !initial || gone || (lost && selected === 0 && words.trim() !== '')} data-canvas-send="">
          {selected > 0 ? 'Send selection' : 'Send sketch'}
        </button>
      </form>
    </div>
  );
}
