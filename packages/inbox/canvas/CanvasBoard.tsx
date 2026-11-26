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
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CaptureUpdateAction, Excalidraw, MainMenu, WelcomeScreen, convertToExcalidrawElements, exportToCanvas, getSceneVersion, restoreElements, serializeAsJSON, sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from '@excalidraw/excalidraw';
import type { AppState, BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import excalidrawCss from '@excalidraw/excalidraw/index.css?inline';
import { authorWords } from '@plannotator/shared/inbox/canvas/changes';
import { thingsOf } from '@plannotator/shared/inbox/canvas/reading';
import { boxOf, boxesOverlap, farElements, pictureTiles, tameFar, unionBox, type Box, type CanvasElement, type CanvasScene } from '@plannotator/shared/inbox/canvas/scene';
import boardCss from './canvas.css?inline';
import { heldWords, InboxHeldError, type MachineView, type OutboxView } from '../api';
import { machineOf, rememberMachine } from '../inboxUrl';
import { CANVAS_WINDOW, canvasApi, canvasLooked, subscribeCanvasFrames, type CanvasFrame, type CanvasJob, type CanvasReply } from './canvasApi';
import { boardLine, farChanges, farParts, heldEnd, joinHeld, saveTimer, type BoardLine, type HeldSave, type SaveState } from './farSave';
import { clearSpotView, drawnThisVisit, sketchPictures } from './freshVisit';

export interface CanvasBoardProps {
  threadId: string;
  dark: boolean;
  /** Who a reply from here reaches, as the thread names it ("Claude Code"); null when nobody is known. */
  agent: string | null;
  /** That agent's icon, as the thread draws it. */
  agentMark?: ReactNode;
  /** The person's newest reply reached a running session of that agent (the thread's own delivery mark). */
  received?: boolean;
  /** The reply box's words when the canvas opened (they may arrive a moment after it): the bar starts from them. */
  draft?: string;
  /** The bar's words as they change: they go back to the reply box when the canvas closes. */
  onWords?: (words: string) => void;
  /** The reply the bar sends: its words, its pictures and scene file, and what the agent reads of the canvas. */
  onSend: (reply: CanvasReply) => void;
  /** The window's outbox (held writes for linked computers, by key): a save or an Undo held for the thread's computer ends there. */
  outbox?: ReadonlyMap<string, OutboxView>;
  /** The linked computer the thread lives on, as the window knows it now (null for this computer's thread). */
  machine?: MachineView | null;
  /**
   * Opened from the reply box's + → Canvas on a canvas that already holds something (freshVisit.ts): the view opens
   * on a clear spot beside the drawing, and Send with nothing selected carries only what was drawn on this visit.
   */
  fresh?: boolean;
}

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
 * The one drawing face this build does not ship (Xiaolai, 12 MB of Chinese and Japanese handwriting) never enters the
 * page's font list: Excalidraw adds its faces again on every load and every export, and each asks for a file that is
 * not there ("Failed to load font … Xiaolai"). Those characters draw in the system's face.
 */
function leaveOutUnshippedFaces(): void {
  const fonts = document.fonts as FontFaceSet & { __ibcGuard?: true };
  if (fonts.__ibcGuard) return;
  fonts.__ibcGuard = true;
  const unshipped = (face: FontFace) => face.family.replace(/["']/g, '') === 'Xiaolai';
  const add = fonts.add.bind(fonts);
  fonts.add = (face: FontFace) => (unshipped(face) ? fonts : add(face));
  for (const face of [...fonts]) if (unshipped(face)) fonts.delete(face);
}

/** Excalidraw's font families by number, for the ones it ships as files (2, Helvetica, is the system's). */
const FACES: Record<number, string> = { 1: 'Virgil', 3: 'Cascadia', 5: 'Excalifont', 6: 'Nunito', 7: 'Lilita One', 8: 'Comic Shanns', 9: 'Liberation Sans' };

/**
 * The faces these texts are drawn in, loaded, so that measuring them gives the size they are drawn at. Text measured
 * with a stand-in face is wrapped and cut wrong once the real one draws it. Gives up after a moment: a canvas is not
 * held back by a font.
 */
async function facesReady(elements: readonly { type: string; isDeleted?: boolean; fontFamily?: unknown; fontSize?: unknown; text?: unknown; originalText?: unknown }[]): Promise<void> {
  const chars = new Map<string, Set<string>>();
  for (const el of elements) {
    if (el.type !== 'text' || el.isDeleted) continue;
    const family = FACES[Number(el.fontFamily)];
    if (!family) continue;
    const set = chars.get(family) ?? new Set<string>();
    for (const ch of String(el.originalText ?? el.text ?? '')) set.add(ch);
    chars.set(family, set);
  }
  if (chars.size === 0) return;
  const registered = () => [...document.fonts].some((face) => chars.has(face.family.replace(/["']/g, '')));
  // Excalidraw lists its faces as it mounts: a text that arrives before that waits for the list, briefly.
  for (let waited = 0; !registered() && waited < 1500; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  const loads = [...chars].map(([family, set]) => document.fonts.load(`20px "${family}"`, [...set].join('')).catch(() => []));
  await Promise.race([Promise.all(loads), new Promise((resolve) => setTimeout(resolve, 2500))]);
}

/** The middle of an arrow, where its label sits (Excalidraw's rule: its middle point, or the middle of its middle stretch). */
function arrowMiddle(arrow: ExcalidrawElement): { x: number; y: number } | null {
  const points = (arrow as unknown as CanvasElement).points ?? [];
  if (points.length < 2) return null;
  const at = (i: number) => ({ x: arrow.x + (Number(points[i]?.[0]) || 0), y: arrow.y + (Number(points[i]?.[1]) || 0) });
  const half = Math.floor(points.length / 2);
  if (points.length % 2 === 1) return at(half);
  const a = at(half - 1);
  const b = at(half);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Elements from the Inbox, made whole for the editor. `context`: what the editor already holds, so a label finds its
 * shape and a shape its label when only one of the two came (without it Excalidraw unties them: a box drawn empty
 * while its words sit in the scene).
 *
 * Text is wrapped and measured here, by Excalidraw's own rule, from the words as written (`originalText`): the Inbox
 * stores an agent's words whole and guesses their size, and the line breaks are only ever a matter of display. Call
 * after `facesReady`.
 */
function restored(elements: readonly CanvasElement[], context: readonly { id: string }[] = []): ExcalidrawElement[] {
  const mine = new Set(elements.map((e) => e.id));
  const fresh = asExcalidraw(elements).map((el) => (el.type === 'text' && typeof el.originalText === 'string' && el.originalText !== '' ? { ...el, text: el.originalText } : el));
  const around = (context as ExcalidrawElement[]).filter((e) => !mine.has(e.id));
  const all = restoreElements([...fresh, ...around], null, { refreshDimensions: true, repairBindings: true }) as ExcalidrawElement[];
  const byId = new Map<string, ExcalidrawElement>(all.map((e) => [e.id, e]));
  return all
    .filter((el) => mine.has(el.id))
    .map((el) => {
      // A label sits in the middle of its shape, or on the middle of its arrow (left where the person aligned it otherwise).
      if (el.type !== 'text' || !el.containerId || el.textAlign !== 'center' || el.verticalAlign !== 'middle') return el;
      const container = byId.get(el.containerId);
      if (!container) return el;
      const box = boxOf(container as unknown as CanvasElement);
      const middle = container.type === 'arrow' ? arrowMiddle(container) : null;
      const x = (middle?.x ?? box.x + box.w / 2) - el.width / 2;
      const y = (middle?.y ?? box.y + box.h / 2) - el.height / 2;
      return Math.abs(x - el.x) < 0.5 && Math.abs(y - el.y) < 0.5 ? el : { ...el, x, y };
    });
}

interface Drawn {
  blob: Blob;
  canvas?: HTMLCanvasElement;
  place: { x: number; y: number; w: number; h: number; scale: number };
}

/** A PNG of some elements, always on white in the light look (what an agent reads must not depend on the person's theme). */
async function draw(elements: readonly ExcalidrawElement[], files: BinaryFiles, max = PICTURE_MAX, most = 2): Promise<Drawn | null> {
  const shown = elements.filter((e) => !e.isDeleted);
  if (shown.length === 0) return null;
  let scale = 1;
  const canvas = await exportToCanvas({
    elements: shown,
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false },
    files,
    exportPadding: PAD,
    getDimensions: (width: number, height: number) => {
      scale = Math.min(most, max / Math.max(width, height, 1));
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
async function drawPlaced(elements: readonly ExcalidrawElement[], files: BinaryFiles, max = PICTURE_MAX, most = 2): Promise<Drawn | null> {
  const shown = elements.filter((e) => !e.isDeleted);
  const drawn = await draw(shown, files, max, most);
  if (!drawn) return null;
  const around = unionBox(asCanvas(shown).map(boxOf));
  // The picture is the elements' bounds with the padding around them; a stroke's width can push it a little past, which the size carries.
  return { blob: drawn.blob, canvas: drawn.canvas, place: { ...drawn.place, x: around.x - (drawn.place.w - around.w) / 2, y: around.y - (drawn.place.h - around.h) / 2 } };
}

/** The longest side, in pixels, of the one large drawing that pieces of a long picture are cut from. */
const STRIP_MAX = 14_000;

/**
 * A long strip (a tall screenshot, a wide timeline) as pieces that can each be read, in order: one picture of it
 * would be a sliver. Empty when one picture is enough.
 */
async function pieces(elements: readonly ExcalidrawElement[], files: BinaryFiles, most: number): Promise<Blob[]> {
  const shown = elements.filter((e) => !e.isDeleted);
  if (shown.length === 0) return [];
  const around = unionBox(asCanvas(shown).map(boxOf));
  const tiles = pictureTiles({ x: around.x - PAD, y: around.y - PAD, w: around.w + PAD * 2, h: around.h + PAD * 2 }, PICTURE_MAX, most);
  if (tiles.length < 2) return [];
  const whole = await drawPlaced(shown, files, STRIP_MAX, 1);
  if (!whole) return [];
  const out: Blob[] = [];
  for (const tile of tiles) {
    const part = await cut(whole, tile, 0);
    if (part) out.push(part);
  }
  return out.length === tiles.length ? out : [];
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
    await canvasApi.answerMermaid(job.id, drawn, job.machine);
    return;
  }
  if (!job.thread_id) return;
  // A linked computer's agent asked about one of its threads: read it there, answer there.
  if (job.machine) rememberMachine([job.thread_id], job.machine);
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
    if (job.crop && job.box) {
      // One piece of a long strip: drawn large, cut to exactly the part asked for.
      const whole = await drawPlaced(shown, files, STRIP_MAX, 1);
      const part = whole ? await cut(whole, job.box, 0) : null;
      await canvasApi.answerPicture(job.id, part, part && whole ? { ...job.box, scale: whole.place.scale } : undefined, job.machine);
      return;
    }
    const drawn = await drawPlaced(shown, files);
    await canvasApi.answerPicture(job.id, drawn?.blob ?? null, drawn?.place, job.machine);
  } catch {
    await canvasApi.answerPicture(job.id, null, undefined, job.machine).catch(() => {});
  }
}

const NUMBER = new Intl.NumberFormat('en-US');
/** A press with no movement for this long is no longer a stroke in progress: what the Inbox holds back for it is let in. */
const PRESS_IDLE_MS = 4000;
/** Something said once stays at least this long; after that the person's next press on the canvas clears it. */
const NOTICE_STAYS_MS = 6000;
/** A save that fails is tried again this many times, quietly, before the canvas says it is not saved. */
const SAVE_TRIES = 4;

/** A picture's own size, from its file. */
function naturalSize(dataURL: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0 ? { w: image.naturalWidth, h: image.naturalHeight } : null);
    image.onerror = () => resolve(null);
    image.src = dataURL;
  });
}

const NO_OUTBOX: ReadonlyMap<string, OutboxView> = new Map();
/** An Undo's answer (canvasApi.undo), also as a held one's outbox entry carries it. */
type UndoAnswer = { rev?: number; scene?: CanvasScene; kept?: string[]; kept_count?: number; already?: boolean };
const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;

export default function CanvasBoard({ threadId, dark, agent, agentMark, received = false, draft = '', onWords, onSend, outbox = NO_OUTBOX, machine = null, fresh = false }: CanvasBoardProps) {
  useLayoutEffect(withStyles, []);
  useLayoutEffect(leaveOutUnshippedFaces, []);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const stage = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [initial, setInitial] = useState<{ elements: ExcalidrawElement[]; files: BinaryFiles; background: string | undefined } | null>(null);
  const [failed, setFailed] = useState(false);
  /** Every text is wrapped and measured in its own face: the drawing is shown (a moment after the editor mounts). */
  const [settled, setSettled] = useState(true);
  const [selected, setSelected] = useState(0);
  const [empty, setEmpty] = useState(true);
  /** A fresh visit (`fresh`): every element id the board held when it opened, took from the Inbox since, or sent on this visit. */
  const known = useRef(new Set<string>());
  /** Only freehand on the canvas: it is a sketch; with a box, a text or a photo it is a canvas. */
  const [freehand, setFreehand] = useState(true);
  const [words, setWords] = useState('');
  /** Something to say once (an Undo's outcome, a file that is not a picture): it stays until the person's next press on the canvas. */
  /** `ended`: the outbox's words for a change held for that computer that did not land there, which wrap rather than cut off. */
  const [notice, setNoticeNow] = useState<(BoardLine & { at: number }) | null>(null);
  const setNotice = useCallback((next: BoardLine | null) => setNoticeNow(next ? { ...next, at: Date.now() } : null), []);
  /**
   * The save: `saving` while a failed one is tried again, `failed` once it has given up for now; `held` while what the
   * person did waits for the thread's linked computer; `ended`: a save held for it did not land there (the outbox's words).
   */
  const [saveState, setSaveState] = useState<SaveState>(null);
  /** An Undo waiting in the outbox for that computer: the outbox's words for it, until its entry ends (`settleHeld`). */
  const [undoHeld, setUndoHeld] = useState<string | null>(null);
  const [note, setNote] = useState<{ who: string; added: number; changed: number; removed: number; ids: string[]; rev: number } | null>(null);
  /** The selection the person was writing about was removed by someone else. */
  const [lost, setLost] = useState(false);
  const pickedSig = useRef('');
  const pickedBefore = useRef(0);
  /** Sent, and no change from the agent yet: when it was sent (the canvas says "Sent" for a moment, then shows the agent while a session has the reply). */
  const [waiting, setWaiting] = useState<number | null>(null);
  const [justSent, setJustSent] = useState(false);
  /** The thread's delivery mark at the moment of Send: the mark of an older reply is not this one's. */
  const receivedAtSend = useRef(false);
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
    if (waiting === null) return;
    setJustSent(true);
    const brief = setTimeout(() => setJustSent(false), 4000);
    const timer = setTimeout(() => setWaiting(null), 3 * 60_000);
    return () => {
      clearTimeout(brief);
      clearTimeout(timer);
    };
  }, [waiting]);
  // The delivery mark went away (a new reply is on its way): the next one that shows is this reply's.
  useEffect(() => {
    if (!received) receivedAtSend.current = false;
  }, [received]);
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
  const fails = useRef(0);
  const threadGone = useRef(false);
  const [gone, setGone] = useState(false);
  /** When the person last touched the canvas: an agent's change never moves the view under their hands. */
  const lastInput = useRef(0);
  const lastVersion = useRef('');
  const lastCount = useRef(-1);
  /** The pause before a save: longer while a save waits for that computer (`heldSaves`), each change rewrites it there. */
  const saveNow = useRef<() => void>(() => {});
  const [pause] = useState(() => saveTimer(() => saveNow.current(), () => heldSaves.current.size > 0));
  const pictureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const pointerDown = useRef(false);
  /** A button is still down from a press on the canvas (also after the hold was let go for standing still). */
  const pressed = useRef(false);
  const lastMove = useRef(0);
  const live = useRef(true);
  /** Pictures already given a readable size (once each). */
  const sized = useRef(new Set<string>());
  /** Pictures the person just placed, until each has the shape Excalidraw gives it: its file's own size once read (null before it is asked for). */
  const placing = useRef(new Map<string, { w: number; h: number } | null>());
  /** A linked computer's thread: the saves waiting in this Inbox's outbox for it, by key, until each has ended there. */
  const heldSaves = useRef(new Map<string, HeldSave>());
  /** The held keys the window's outbox has listed: one it lists no more has ended (`heldEnd`). */
  const outboxSeen = useRef(new Set<string>());
  /** An Undo waiting in the outbox for that computer, by key. */
  const heldUndo = useRef<string | null>(null);
  /** The outbox's words for the last save held. */
  const heldText = useRef('');
  const outboxNow = useRef(outbox);
  outboxNow.current = outbox;
  const machineNow = useRef(machine);
  machineNow.current = machine;
  /** What a save says while that computer is away (a picture's file goes only while it is there). */
  const awayWords = () => heldWords({ name: machineNow.current?.name ?? 'the other machine', state: 'offline' });

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
      // Something the Inbox brings that this editor never held (an agent's addition) was not drawn on this visit.
      if (!here) known.current.add(remote.id);
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
    // typed go on untouched); only what is taken is made new, in the company of the rest (a label that came without
    // its shape still finds it).
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
   * is taken when the pointer lifts. Each scene is taken after the faces its words are drawn in have arrived, in the
   * order the scenes came.
   */
  const waitingScene = useRef<{ scene: CanvasScene; then?: (taken: Set<string>) => void } | null>(null);
  const takeQueue = useRef<Promise<void>>(Promise.resolve());
  const takeWhenFree = useCallback(
    (scene: CanvasScene, then?: (taken: Set<string>) => void) => {
      takeQueue.current = takeQueue.current
        .then(() => facesReady(scene.elements))
        .catch(() => {})
        .then(() => {
          if (!live.current) return;
          if (pointerDown.current) {
            const before = waitingScene.current?.then;
            waitingScene.current = { scene, then: before && then ? (taken) => (before(taken), then(taken)) : then ?? before };
            return;
          }
          const taken = take(scene);
          then?.(taken);
        });
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

  /** A save that landed (now, or once its outbox entry was delivered): what it carried is what the Inbox has. */
  const landed = useCallback(
    (sent: ReadonlyMap<string, string>, gone: readonly string[], answer: { rev?: unknown; scene?: CanvasScene } | null) => {
      for (const id of gone) synced.current.delete(id);
      for (const [id, value] of sent) synced.current.set(id, value);
      if (answer?.scene) takeWhenFree(answer.scene);
      if (typeof answer?.rev === 'number' && Number.isInteger(answer.rev)) rev.current = Math.max(rev.current, answer.rev);
    },
    [takeWhenFree],
  );

  /**
   * How the saves and the Undo held for the thread's linked computer ended (the outbox's entries): a delivered save is
   * what that computer has; one that did not land leaves what it carried to be saved again, and the bar says why in the
   * outbox's words, as an error. One the window's outbox no longer lists (read again whole after a reconnect, which
   * lists only what waits and what did not land) has ended too: what it carried goes again with the next save, which
   * changes nothing there for what landed (elements merge by version).
   */
  const settleHeld = useRef<(entries: ReadonlyMap<string, OutboxView>) => void>(() => {});

  /** A linked computer's thread: pictures' files first, then only what changed, in parts the outbox holds. */
  const saveFar = async (scene: CanvasScene, keepalive?: boolean): Promise<boolean> => {
    const unsent = Object.keys(scene.files);
    let waiting = new Set<string>();
    if (unsent.length > 0) {
      try {
        await canvasApi.files(threadId, scene.files);
        for (const id of unsent) sentFiles.current.add(id);
      } catch (error) {
        // That computer is away: its new pictures wait here for it, and everything else is saved (held) as ever.
        if (statusOf(error) !== 503) throw error;
        waiting = new Set(unsent);
      }
    }
    const change = farChanges(scene.elements, synced.current, heldSaves.current.values(), waiting, sig);
    for (const part of farParts(change.elements, change.gone)) {
      const sent = new Map(part.elements.map((e) => [e.id, sig(e)]));
      try {
        landed(sent, part.gone, await canvasApi.save(threadId, { ...scene, elements: part.elements, files: {} }, rev.current, { gone: part.gone, partial: true, keepalive }));
      } catch (error) {
        if (!(error instanceof InboxHeldError)) throw error;
        // Saved in this Inbox's outbox: sent when that computer is back. Its entry says how it ends. A save made while
        // one waits is folded into that one there (its key comes back): it carries both.
        heldSaves.current.set(error.outbox.key, joinHeld(heldSaves.current.get(error.outbox.key), { sent, gone: part.gone }));
        heldText.current = error.message;
      }
    }
    // An entry may have ended before its answer got here.
    settleHeld.current(outboxNow.current);
    return change.pictures > 0;
  };

  /** This computer's thread: the whole scene. */
  const saveHere = async (scene: CanvasScene): Promise<boolean> => {
    const sent = new Map(scene.elements.map((e) => [e.id, sig(e)]));
    // What the Inbox holds that this window no longer does (a file loaded over the canvas): gone, not "never seen".
    const gone = [...synced.current.keys()].filter((id) => !sent.has(id));
    const answer = await canvasApi.save(threadId, scene, rev.current, { gone });
    for (const id of Object.keys(scene.files)) sentFiles.current.add(id);
    for (const id of gone) synced.current.delete(id);
    for (const [id, value] of sent) synced.current.set(id, value);
    if (answer.scene) takeWhenFree(answer.scene);
    rev.current = answer.rev;
    return false;
  };

  /**
   * A linked computer's thread: each save goes to this Inbox's outbox at once, naming only what no waiting save
   * carries, and the outbox folds it into the one that waits for that computer (inbox-canvas-fold.ts): one entry.
   */
  const save = useCallback((how: { keepalive?: boolean } = {}): Promise<void> => {
    if (saving.current) {
      again.current = true;
      return saving.current;
    }
    const scene = sceneNow();
    if (!scene) return Promise.resolve();
    const far = !!machineOf(threadId);
    const run = (far ? saveFar(scene, how.keepalive) : saveHere(scene))
      .then((picturesWait) => {
        unsaved.current = again.current || picturesWait;
        fails.current = 0;
        if (live.current) setSaveState(heldSaves.current.size > 0 ? { held: heldText.current } : picturesWait ? { held: awayWords() } : null);
        if (heldSaves.current.size === 0 && !picturesWait) storePicture();
        // Pictures that wait for that computer go once it is back (its state, below), or on this slow retry.
        if (picturesWait && live.current && !retry.current) {
          retry.current = setTimeout(() => {
            retry.current = null;
            void save();
          }, 15_000);
        }
      })
      .catch((error: unknown) => {
        const status = statusOf(error);
        // The thread is gone (deleted in another window): there is nowhere to save to, and trying again will not help.
        const gone = status === 404;
        threadGone.current = gone;
        // That computer is away, and this save could not wait in the outbox (one too large to hold): it waits here.
        const away = far && status === 503;
        // Refused for what it is (too large, not valid): the same again would be refused too. The next change tries again.
        const refused = status === 400 || status === 413 || status === 422;
        unsaved.current = true;
        if (!away) fails.current++;
        if (live.current) {
          if (gone) setGone(true);
          else if (away) setSaveState({ held: awayWords() });
          // Tried again by itself, and only said to have failed once that has not helped.
          else setSaveState(refused || fails.current >= SAVE_TRIES ? 'failed' : 'saving');
        }
        // A few seconds on (longer once it has given up, or while that computer is away), and at once when the network is back.
        if (!gone && !refused && live.current && !retry.current) {
          retry.current = setTimeout(
            () => {
              retry.current = null;
              void save();
            },
            away || fails.current >= SAVE_TRIES ? 15_000 : 4000,
          );
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
    // sceneNow, saveFar and saveHere read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, take, storePicture, landed]);

  settleHeld.current = (entries) => {
    let changed = false;
    let ended: string | null = null;
    for (const [key, held] of [...heldSaves.current]) {
      const entry = entries.get(key);
      const end = heldEnd(entry, machineNow.current, outboxSeen.current.has(key));
      if (entry) outboxSeen.current.add(key);
      if (!end) continue;
      outboxSeen.current.delete(key);
      heldSaves.current.delete(key);
      changed = true;
      if (end.landed) landed(held.sent, held.gone, entry!.answer as { rev?: unknown; scene?: CanvasScene } | null);
      else if (!('words' in end)) unsaved.current = true;
      else {
        // It never landed there: what it carried is still the person's to save, sent with their next change.
        unsaved.current = true;
        ended = end.words;
      }
    }
    const undoKey = heldUndo.current;
    const undoEntry = undoKey ? entries.get(undoKey) : undefined;
    const undoEnd = undoKey ? heldEnd(undoEntry, machineNow.current, outboxSeen.current.has(undoKey)) : null;
    if (undoKey && undoEntry) outboxSeen.current.add(undoKey);
    if (undoEnd) {
      heldUndo.current = null;
      outboxSeen.current.delete(undoKey!);
      // How it ended is not known here any more (neither landed nor refused): only the held words go.
      if (live.current) setUndoHeld(null);
      if (undoEnd.landed) undone(undoEntry!.answer as UndoAnswer | null);
      else if ('words' in undoEnd) setNotice({ text: undoEnd.words, bad: true, ended: true });
    }
    if (!changed || !live.current) return;
    if (ended) setSaveState({ ended });
    else if (heldSaves.current.size === 0) {
      setSaveState((state) => (state && typeof state === 'object' && 'held' in state ? null : state));
      if (unsaved.current && !threadGone.current) void save();
    }
  };
  useEffect(() => settleHeld.current(outbox), [outbox]);
  // That computer is back: what waited for it here (a picture's file, a save too large to hold) goes now.
  useEffect(() => {
    if (machine?.state === 'online' && unsaved.current && !threadGone.current) void save();
  }, [machine?.state, save]);

  saveNow.current = () => void save();
  const saveSoon = useCallback(() => {
    unsaved.current = true;
    pause.soon();
  }, [pause]);

  /** Everything unsaved is in the Inbox when this settles. */
  const flush = useCallback(async () => {
    if (pause.stop()) await save();
    while (saving.current) await saving.current;
  }, [save, pause]);

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
        for (const el of read.scene.elements) known.current.add(el.id);
        for (const id of Object.keys(read.scene.files)) sentFiles.current.add(id);
        const shown = read.scene.elements.filter((e) => !e.isDeleted);
        setEmpty(fresh || shown.length === 0);
        setFreehand(shown.every((e) => e.type === 'freedraw'));
        // Not measured yet: the editor's faces are listed only once it mounts, and text wrapped with a stand-in face
        // is cut off when the real one draws it (Excalidraw also remembers the stand-in's letter widths). `settleText`
        // wraps and measures every text once the faces are in; the drawing is shown then.
        setSettled(!shown.some((e) => e.type === 'text'));
        setInitial({ elements: restoreElements(asExcalidraw(read.scene.elements), null, { refreshDimensions: false, repairBindings: true }) as ExcalidrawElement[], files: read.scene.files as BinaryFiles, background: read.scene.appState.viewBackgroundColor as string | undefined });
      })
      .catch(() => {
        if (!stop.signal.aborted) setFailed(true);
      });
    return () => {
      live.current = false;
      stop.abort();
    };
  }, [threadId]);

  /**
   * Once the editor is up and its faces have arrived: every text is wrapped and measured as it is drawn (the Inbox
   * stores an agent's words whole, with a guessed size). The text a person is typing is left alone.
   */
  const settleText = useCallback(async () => {
    try {
      // The editor hands over its API before it has taken the scene in: wait for the scene, briefly.
      for (let waited = 0; waited < 3000 && live.current && (api.current?.getSceneElementsIncludingDeleted().length ?? 0) === 0; waited += 30) await new Promise((resolve) => setTimeout(resolve, 30));
      const first = api.current?.getSceneElementsIncludingDeleted() ?? [];
      if (!first.some((e) => e.type === 'text' && !e.isDeleted)) return;
      await facesReady(first as unknown as CanvasElement[]);
      const editor = api.current;
      if (!editor || !live.current || pointerDown.current) return;
      const local = editor.getSceneElementsIncludingDeleted();
      const editing = editor.getAppState().editingTextElement?.id ?? null;
      const texts = local.filter((e) => e.type === 'text' && !e.isDeleted && e.id !== editing);
      if (texts.length === 0) return;
      // Measuring changes no version: what was saved stays saved, what was not is still the person's to save.
      const fresh = new Map(restored(asCanvas(texts), local).map((e) => [e.id, e]));
      lastVersion.current = '';
      editor.updateScene({ elements: local.map((e) => fresh.get(e.id) ?? e), captureUpdate: CaptureUpdateAction.NEVER });
    } finally {
      if (live.current) setSettled(true);
    }
  }, []);

  // Open boards answer drawing jobs from what is on screen; leaving saves what is not saved yet.
  useEffect(() => {
    openBoards.set(threadId, () => ({ elements: api.current?.getSceneElements() ?? [], files: api.current?.getFiles() ?? {} }));
    const leaving = () => {
      const whole = sceneNow();
      if (!whole || !unsaved.current || threadGone.current) return;
      // Uncompressed: compressing waits, and a closing page's request must start at once. Only a scene under the
      // browser's 64 KB limit for such a request gets out this way; a larger one relies on the save made as the tab was put away.
      if (!machineOf(threadId)) return void canvasApi.save(threadId, whole, rev.current, { keepalive: true, plain: true }).catch(() => {});
      // A linked computer's thread: what no save waiting for it carries; a new picture, whose file goes first, waits.
      const change = farChanges(whole.elements, synced.current, heldSaves.current.values(), new Set(Object.keys(whole.files)), sig);
      for (const part of farParts(change.elements, change.gone)) void canvasApi.save(threadId, { ...whole, elements: part.elements, files: {} }, rev.current, { gone: part.gone, keepalive: true, plain: true, partial: true }).catch(() => {});
    };
    // A tab put away saves at once (while the page can still wait for the answer); a page going away sends what is left.
    const hidden = () => {
      if (document.visibilityState === 'hidden' && unsaved.current && !threadGone.current) {
        pause.stop();
        // A linked computer's thread: what no save waiting for it carries, folded into that one in the outbox.
        if (machineOf(threadId)) return void save({ keepalive: true });
        const whole = sceneNow();
        if (whole) void canvasApi.save(threadId, whole, rev.current, { keepalive: true }).then((answer) => (rev.current = Math.max(rev.current, answer.rev))).catch(() => {});
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
      pause.stop();
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
      // Anywhere in the canvas's layer (its header too), or nowhere in particular.
      const here = !target || target === document.body || target === document.documentElement || !target.isConnected || !!root.current?.contains(target) || !!target.closest('.excalidraw, [data-canvas-layer]');
      if (here) event.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // A file that is not a picture (a renamed .png): Excalidraw's resizer fails on it twice, once caught and once not.
  // The one nobody catches is taken here, and said.
  useEffect(() => {
    const notPicture = (reason: unknown) => /ImageBlobReduce|failed to create Image/i.test(String((reason as { message?: unknown } | null)?.message ?? reason ?? ''));
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!notPicture(event.reason)) return;
      event.preventDefault();
      setNotice({ text: 'Not a picture', bad: true });
    };
    const onError = (event: ErrorEvent) => {
      if (!notPicture(event.error ?? event.message)) return;
      event.preventDefault();
      setNotice({ text: 'Not a picture', bad: true });
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
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
    } else if (scroll && !inView) {
      // Not all in view: it comes into view by itself. The view slides at the person's own zoom to the change when it
      // fits, else to the shapes it added or changed (an arrow to them may run off the edge); only a change whose
      // shapes fit in no view at this zoom is fitted, never closer than the person's zoom.
      const fits = (box: Box) => box.w * view.zoom.value <= rect.width * 0.9 && box.h * view.zoom.value <= rect.height * 0.8;
      const shapes = changed.filter((e) => e.type !== 'arrow' && e.type !== 'line');
      const target = fits(around) ? changed : shapes.length > 0 && fits(unionBox(asCanvas(shapes).map(boxOf))) ? shapes : null;
      if (target) editor.scrollToContent(target, { fitToViewport: false, animate: !still, duration: 350 });
      else editor.scrollToContent(changed, { fitToViewport: true, viewportZoomFactor: 0.75, maxZoom: view.zoom.value, animate: !still, duration: 350 });
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
            // The selection the person was writing about is gone: the bar must not fall back to the whole canvas unasked.
            const selectedNow = api.current?.getAppState().selectedElementIds ?? {};
            if (pickedBefore.current > 0 && !Object.keys(selectedNow).some((id) => now.get(id) && !now.get(id)!.isDeleted)) setLost(true);
            setWaiting(null);
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
            // What the agent did comes into view by itself, but never under the person's pointer or while they type.
            reveal(ids, !pointerDown.current && !api.current?.getAppState().editingTextElement);
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
      if (frame.thread_id !== threadId) return;
      // This window's own save. One held for a linked computer ends with its outbox entry (`settleHeld`), also when it
      // changed nothing there (no frame) or never landed.
      if (frame.window === CANVAS_WINDOW) return;
      // An agent tried and the Inbox refused it: nothing landed, and the canvas stops saying one is on its way.
      if (frame.refused) {
        setWaiting(null);
        setNotice({ text: `${frame.by ?? 'Agent'}'s change failed` });
        return;
      }
      if (frame.rev <= rev.current) return;
      refresh();
    };
    return subscribeCanvasFrames(onFrame);
  }, [threadId, takeWhenFree, reveal, storePicture]);

  /**
   * What a file or a paste brought in that cannot stay as it is, put right once: a thing nowhere near the rest (a
   * file can hold a box a billion pixels away, and the editor stops drawing) is brought beside the drawing, a place
   * that is not a number is made one, and a long strip of a picture (a tall screenshot, which Excalidraw places a few
   * pixels wide) is given a size it can be read at.
   */
  const tidy = useCallback((elements: readonly ExcalidrawElement[]) => {
    const editor = api.current;
    if (!editor) return;
    const bump = (e: ExcalidrawElement, change: Partial<CanvasElement>) => ({ ...e, ...change, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }) as ExcalidrawElement;
    const fixes = new Map<string, Partial<CanvasElement>>();
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : 0);
    for (const e of elements) {
      const raw = e as unknown as Record<string, unknown>;
      if ([raw.x, raw.y, raw.width, raw.height].some((v) => typeof v !== 'number' || !Number.isFinite(v))) fixes.set(e.id, { x: num(raw.x), y: num(raw.y), width: num(raw.width), height: num(raw.height) });
    }
    const whole = asCanvas(elements).map((e) => (fixes.has(e.id) ? { ...e, ...fixes.get(e.id) } : e));
    if (farElements(whole).size > 0) {
      const tamed = tameFar(whole);
      const by = new Map(tamed.elements.map((e) => [e.id, e]));
      for (const id of tamed.moved) {
        const e = by.get(id);
        if (e) fixes.set(id, { ...fixes.get(id), x: e.x, y: e.y, width: e.width, height: e.height, ...(e.points ? { points: e.points } : {}) });
      }
    }
    if (fixes.size > 0) {
      setTimeout(() => {
        const now = api.current;
        if (!now) return;
        lastVersion.current = '';
        now.updateScene({ elements: now.getSceneElementsIncludingDeleted().map((e) => (fixes.has(e.id) ? bump(e, fixes.get(e.id)!) : e)), captureUpdate: CaptureUpdateAction.NEVER });
        now.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.85, maxZoom: 1, animate: false });
      }, 0);
    }
    // Pictures the person just placed are looked at until each has the size Excalidraw gives it (`fitPictures`).
    for (const e of elements) {
      if (e.isDeleted || e.type !== 'image' || !e.fileId || sized.current.has(e.id) || synced.current.has(e.id) || placing.current.has(e.id)) continue;
      placing.current.set(e.id, null);
    }
  }, []);

  /**
   * A picture the person just placed, far longer than it is wide (or the other way): Excalidraw fits its long side
   * into half the window, which leaves a tall screenshot a few pixels wide. Its short side gets a readable width (its
   * own, up to most of the view); the long side follows, and the top stays where it was put. Once per picture, after
   * Excalidraw has given it its own shape.
   */
  const fitPictures = useCallback(() => {
    const now = api.current;
    const host = stage.current;
    if (!now || !host || placing.current.size === 0) return;
    const files = now.getFiles();
    const all = now.getSceneElementsIncludingDeleted();
    const changes = new Map<string, Partial<CanvasElement>>();
    for (const [id, natural] of placing.current) {
      const el = all.find((x) => x.id === id);
      if (!el || el.isDeleted || el.type !== 'image') {
        placing.current.delete(id);
        continue;
      }
      if (!natural) {
        const file = el.fileId ? files[el.fileId] : undefined;
        if (!file?.dataURL) continue;
        // Asked once; the answer comes back through here.
        placing.current.set(id, { w: 0, h: 0 });
        void naturalSize(file.dataURL).then((size) => {
          if (!size) placing.current.delete(id);
          else placing.current.set(id, size);
          fitPictures();
        });
        continue;
      }
      if (natural.w === 0 || el.width < 1 || el.height < 1) continue;
      // Still the placeholder Excalidraw draws while it reads the file: its shape is not the picture's yet.
      if (Math.abs(el.width / el.height - natural.w / natural.h) > 0.02 * (natural.w / natural.h)) continue;
      placing.current.delete(id);
      sized.current.add(id);
      const long = Math.max(natural.w, natural.h);
      const short = Math.min(natural.w, natural.h);
      if (long / short < 3) continue;
      const zoom = now.getAppState().zoom.value;
      const rect = host.getBoundingClientRect();
      const tall = natural.h >= natural.w;
      const room = ((tall ? rect.width : rect.height) * 0.7) / zoom;
      const wantShort = Math.min(short, Math.max(240, room));
      const haveShort = Math.min(el.width, el.height);
      if (haveShort >= wantShort * 0.9) continue;
      const k = wantShort / haveShort;
      const width = el.width * k;
      const height = el.height * k;
      // The top (a tall picture) or the left end (a wide one) stays where it was put.
      changes.set(id, { width, height, x: tall ? el.x + el.width / 2 - width / 2 : el.x, y: tall ? el.y : el.y + el.height / 2 - height / 2 });
    }
    if (changes.size === 0) return;
    lastVersion.current = '';
    now.updateScene({
      elements: all.map((e) => (changes.has(e.id) ? ({ ...e, ...changes.get(e.id), version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } as ExcalidrawElement) : e)),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

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
        setNotice({ text: 'Not a picture', bad: true });
        setTimeout(() => api.current?.updateScene({ elements: api.current.getSceneElementsIncludingDeleted().map((e) => (ids.has(e.id) ? { ...e, isDeleted: true, version: e.version + 1 } : e)), captureUpdate: CaptureUpdateAction.NEVER }), 0);
      }
      // Nothing to send: no element, or only a speck (a stray tap of the pen).
      const shown = asCanvas(elements.filter((e) => !e.isDeleted));
      // A fresh visit: only what was drawn on it counts (Send carries only that).
      const counted = fresh ? asCanvas(drawnThisVisit(elements, known.current)) : shown;
      const all = unionBox(counted.map(boxOf));
      setEmpty(counted.length === 0 || (counted.every((e) => e.type === 'freedraw') && all.w < 4 && all.h < 4));
      setFreehand(counted.every((e) => e.type === 'freedraw'));
      // How many elements the editor holds and is not deleted, for a browser test to compare with the Inbox's.
      stage.current?.setAttribute('data-held', String(shown.length));
      // Something new came in (a file opened, a paste, a picture): looked over once, when the count changes.
      const files2 = Object.keys(files).length;
      if (elements.length + files2 !== lastCount.current) {
        lastCount.current = elements.length + files2;
        tidy(elements);
      }
      if (placing.current.size > 0) setTimeout(fitPictures, 0);
      // The scene as the Inbox has it (just read, or just taken from it): nothing of the person's to save.
      if (elements.length === synced.current.size && elements.every((e) => synced.current.get(e.id) === sig(e)) && Object.keys(files).every((id) => sentFiles.current.has(id))) return;
      saveSoon();
    },
    [saveSoon, tidy, fitPictures, fresh],
  );

  /** An Undo that landed: now, or once its outbox entry was delivered to the thread's linked computer. */
  function undone(answer: UndoAnswer | null): void {
    if (!live.current) return;
    if (answer?.scene && Array.isArray(answer.scene.elements)) {
      takeWhenFree(answer.scene);
      // A fresh visit counts only its own drawing: the editor's next change says whether any is left.
      if (!fresh) setEmpty(!answer.scene.elements.some((e) => !e.isDeleted));
    }
    if (typeof answer?.rev === 'number') rev.current = Math.max(rev.current, answer.rev);
    setNote(null);
    const kept = answer?.kept_count ?? answer?.kept?.length ?? 0;
    setNotice({ text: answer?.already ? 'Already undone' : kept > 0 ? `Undone. Yours kept: ${NUMBER.format(kept)}` : 'Undone' });
    storePicture();
  }
  /** Take back the agent's change: what it changed is as it was, what it added is gone; what the person did since stays. */
  const undo = async (change: number) => {
    try {
      await flush();
      undone(await canvasApi.undo(threadId, change));
    } catch (error) {
      // A linked computer that is away: the Undo waits in the outbox and lands when it is back; its entry says how it ended (`settleHeld`).
      // Said as a held save is (`boardLine`), following that computer's state, and kept until its entry ends.
      if (error instanceof InboxHeldError) {
        heldUndo.current = error.outbox.key;
        setNotice(null);
        setUndoHeld(error.message);
        settleHeld.current(outboxNow.current);
      } else setNotice({ text: "Can't undo", bad: true });
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

  /**
   * The press is over, however it ended: the pointer lifted (anywhere, the header or another window included), the
   * browser cancelled it, the window lost focus or was put away mid-press, or it has not moved for a few seconds.
   * A press that never lifts must not hold an agent's change back until some later press does.
   */
  const pressOver = useCallback((ended: boolean | Event = true) => {
    if (ended !== false) pressed.current = false;
    if (!pointerDown.current) return;
    pointerDown.current = false;
    lastInput.current = Date.now();
    // After Excalidraw has finished the press: the frame is put back, and what arrived meanwhile is taken.
    setTimeout(() => {
      releaseFrames();
      pointerLifted();
    }, 0);
    // releaseFrames reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointerLifted]);
  useEffect(() => {
    const away = () => {
      if (document.visibilityState === 'hidden') pressOver();
    };
    const idle = setInterval(() => {
      if (pointerDown.current && Date.now() - lastMove.current > PRESS_IDLE_MS) pressOver(false);
    }, 1000);
    window.addEventListener('pointerup', pressOver, true);
    window.addEventListener('pointercancel', pressOver, true);
    window.addEventListener('blur', pressOver);
    document.addEventListener('visibilitychange', away);
    return () => {
      clearInterval(idle);
      window.removeEventListener('pointerup', pressOver, true);
      window.removeEventListener('pointercancel', pressOver, true);
      window.removeEventListener('blur', pressOver);
      document.removeEventListener('visibilitychange', away);
    };
  }, [pressOver]);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const editor = api.current;
    if (!editor || busy || empty) return;
    setBusy(true);
    setNotice({ text: 'Sending…' });
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
      // A long strip (a tall screenshot) also goes as pieces that can each be read, in order.
      const strip = async (elements: readonly ExcalidrawElement[], stem: string) => {
        const parts = await pieces(elements, files, 6);
        parts.forEach((part, i) => out.push(new File([part], `${stem}-part-${i + 1}-of-${parts.length}.png`, { type: 'image/png' })));
      };
      // A fresh visit with nothing selected: only what was drawn on it, read and pictured as a sketch of those things.
      const visit = fresh && picked.size === 0 ? drawnThisVisit(all, known.current) : null;
      if (picked.size > 0) {
        const chosen = all.filter((e) => picked.has(e.id));
        const drawn = await draw(chosen, files);
        if (drawn) png(drawn, 'canvas-selection.png');
        await strip(chosen, 'canvas-selection');
        sceneFile(chosen, 'canvas-selection.excalidraw');
        onSend({ words: words.trim(), files: out, sketch: { kind: 'selection', elements: [...picked], pictures } });
      } else {
        const sent = visit ?? all;
        const whole = await drawPlaced(sent, files);
        if (whole) png(whole, 'canvas.png');
        await strip(sent, 'canvas');
        // Each freehand drawing as its own picture, so nobody groups a face by hand and no model has to find it in the whole;
        // a fresh visit's canvas.png is already just the new drawing, so it is the one picture (freshVisit.ts).
        const things = thingsOf({ type: 'excalidraw', version: 2, source: '', elements: asCanvas(sent), appState: {}, files: {} });
        const { own, whole: inWhole } = sketchPictures(things, !!visit);
        for (const id of inWhole) if (whole) pictures[id] = 'canvas.png';
        for (const [i, sketch] of own.entries()) {
          const part = whole ? await cut(whole, sketch.box) : null;
          if (!part) continue;
          const name = `sketch-${i + 1}.png`;
          out.push(new File([part], name, { type: 'image/png' }));
          pictures[sketch.id] = name;
        }
        sceneFile(sent, 'canvas.excalidraw');
        onSend({ words: words.trim(), files: out, sketch: { kind: 'sketch', elements: visit ? visit.map((e) => e.id) : [], pictures } });
        // Sent: the next Send of this visit carries only what is drawn after it.
        if (visit) {
          for (const e of visit) known.current.add(e.id);
          setEmpty(true);
          setFreehand(true);
        }
      }
      setWords('');
      setLost(false);
      // What was picked has gone with the reply: the selection (and Excalidraw's panel for it) steps aside for the answer.
      if (picked.size > 0) editor.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
      setNotice(null);
      setNote(null);
      receivedAtSend.current = received;
      setWaiting(Date.now());
    } catch {
      setNotice({ text: 'Not sent', bad: true });
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

  // One line of state: the thread is gone, something to say once, a save that is not through, or what waits for that computer.
  const state = boardLine(gone, notice, saveState, undoHeld, machine ?? null);
  // A running session has the reply: the agent's icon, working. Before that, "Sent" for a moment and then nothing.
  const working = waiting !== null && received && !receivedAtSend.current;
  const sentChip = waiting !== null && !note && (working || justSent);
  // The pill names who changed the canvas: the thread's agent by its icon (its name beside it where there is room).
  const noteMark = note && agentMark && note.who === agent ? agentMark : null;
  const sendAll = lost && selected === 0;

  return (
    <div
      className="ibc-root"
      data-canvas-board={threadId}
      data-canvas-fresh={fresh ? '' : undefined}
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
          pressed.current = true;
          lastInput.current = Date.now();
          lastMove.current = Date.now();
          // Said once, and seen: the person is back at the drawing.
          // (Not at once: the press that places a picture comes right after the file that was no picture.)
          if (event.target instanceof HTMLCanvasElement) setNoticeNow((now) => (now && now.text !== 'Sending…' && Date.now() - now.at > NOTICE_STAYS_MS ? null : now));
          if (event.button === 0 && event.target instanceof HTMLCanvasElement) overFrame(event.clientX, event.clientY);
        }}
        onPointerMoveCapture={(event) => {
          // A press that stood still and was let go of, moving again: it is a stroke once more.
          if (pressed.current && event.buttons !== 0) pointerDown.current = true;
          if (pointerDown.current) lastMove.current = Date.now();
        }}
      >
        {!initial ? (
          <div className="ibc-wait" aria-busy="true" />
        ) : (
          <div className="excalidraw-host" data-settling={settled ? undefined : ''}>
            <Excalidraw
              excalidrawAPI={(next) => {
                api.current = next;
                // The whole drawing in view, never larger than life; a fresh visit opens on a clear spot beside it.
                const spot = fresh ? clearSpotView(unionBox(asCanvas(initial.elements.filter((e) => !e.isDeleted)).map(boxOf))) : null;
                setTimeout(() => (spot ? next.updateScene({ appState: { ...spot, zoom: { value: 1 as AppState['zoom']['value'] } }, captureUpdate: CaptureUpdateAction.NEVER }) : next.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.85, maxZoom: 1, animate: false })), 0);
                if (initial.elements.some((e) => !e.isDeleted && e.type === 'text')) void settleText();
                try {
                  if (performance.getEntriesByName('canvas:open').length > 0 && performance.getEntriesByName('canvas:ready').length === 0) performance.measure('canvas:ready', 'canvas:open');
                } catch {
                  // No timing: nothing to do.
                }
              }}
              initialData={{ elements: initial.elements, files: initial.files, appState: { viewBackgroundColor: initial.background ?? '#ffffff' }, scrollToContent: !fresh }}
              onChange={onChange}
              theme={dark ? 'dark' : 'light'}
              name="canvas"
              // The drawing has the keys from the start: R, then a drag, draws a rectangle without a click first.
              autoFocus
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
                  <WelcomeScreen.Center.Heading>Sketch or select, then Send</WelcomeScreen.Center.Heading>
                </WelcomeScreen.Center>
              </WelcomeScreen>
            </Excalidraw>
          </div>
        )}
        {flashes.map((flash) => (
          <span key={flash.key} className="ibc-flash" aria-hidden="true" style={{ left: flash.box.x, top: flash.box.y, width: flash.box.w, height: flash.box.h }} />
        ))}
        {sentChip && (
          <div className="ibc-note ibc-waiting" role="status" data-canvas-waiting={working ? 'working' : 'sent'} aria-label={working ? `${agent ?? 'The agent'} has it` : 'Sent'}>
            {working ? (
              <>
                {agentMark ? <span className="ibc-mark" aria-hidden="true">{agentMark}</span> : null}
                <span className="ibc-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              </>
            ) : (
              <b className="ibc-who">Sent</b>
            )}
          </div>
        )}
        {note && (
          <div className="ibc-note" role="status" data-canvas-note="" aria-label={`${note.who}: ${[note.added ? `added ${note.added}` : '', note.changed ? `changed ${note.changed}` : '', note.removed ? `removed ${note.removed}` : ''].filter(Boolean).join(', ')}`}>
            {noteMark ? <span className="ibc-mark" title={note.who} aria-hidden="true">{noteMark}</span> : null}
            <b className="ibc-who" data-marked={noteMark ? '' : undefined} title={note.who}>
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
        <span className="ibc-what" data-on={selected > 0 ? '' : undefined} data-lost={sendAll ? '' : undefined} data-canvas-what="" aria-live="polite">
          {selected > 0 ? `${NUMBER.format(selected)} selected` : lost ? 'Selection gone' : fresh ? 'New drawing' : 'Whole canvas'}
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
          onKeyDown={(event) => {
            // The reply box's own Send key: Enter with Cmd or Ctrl. Enter alone is a new line, as it is there.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.stopPropagation();
              void send();
            }
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
          <span className="ibc-state" role="status" data-bad={state.bad ? '' : undefined} data-held={state.held ? '' : undefined} data-ended={state.ended ? '' : undefined} title={state.text}>
            {state.text}
          </span>
        )}
        {/* A request written about a selection that was then removed goes about the whole canvas only when the person says so: the button says "Send all". */}
        <button type="submit" className="ibc-send" disabled={busy || empty || !initial || gone} data-canvas-send="">
          {selected > 0 ? 'Send selection' : sendAll ? 'Send all' : freehand ? 'Send sketch' : 'Send canvas'}
        </button>
      </form>
    </div>
  );
}
