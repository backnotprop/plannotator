/**
 * Shape: the living board. One shape's four views (Picture, How it works,
 * Requirements, Code) with fades between them, the dock, live marking with
 * two intents (Change it / Ask, on a part or on the whole board), numbered
 * references that open in the real viewers, and one floating panel (Ask ·
 * Thread · References) over the board's right side.
 *
 * Host-neutral: everything comes through `host` (ShapeHost, types.ts). Lifted
 * from the approved prototype; what changed and why is in the PR.
 *
 * Keys: Esc only (owner-approved): it closes the panel, or skips the drawing
 * while it plays. The composer, lightbox and popouts take their own Esc first.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  diffShapeVersions,
  isShapeProjectPath,
  shapeLinkUrl,
  shapeNoteWaits,
  shapeUrlAllowed,
  shapeViewLabel,
  SHAPE_VIEWS,
  type ShapeCodeTarget,
  type ShapeNote,
  type ShapeNoteInput,
  type ShapeRef,
  type ShapeVersion,
  type ShapeViewId,
} from '@plannotator/core/shape';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { AnnotationToolstrip } from '../AnnotationToolstrip';
import { CommentPopover } from '../CommentPopover';
import { DocumentAIChatPanel } from '../ai/DocumentAIChatPanel';
import { SparklesIcon } from '../SparklesIcon';
import { RefHoverCards } from '../RefHoverCard';
import { CodeFilePopout, type CodeFileAnnotationInput } from '../CodeFilePopout';
import { ImageLightbox } from '../ImageLightbox';
import { PopoutDialog } from '../PopoutDialog';
import type { AIChatEntry } from '../../hooks/useAIChat';
import type { AIProviderOption } from '../../utils/aiProvider';
import type { CodeAnnotation, EditorMode, InputMethod } from '../../types';
import { Pebble, useReducedMotion } from './Pebble';
import { NO_MARKS, ShapeDrawn, type MarkState } from './ShapeDrawn';
import { ShapeRequirements } from './ShapeRequirements';
import { ShapeCode, ShapePatch, type ShapeFileTarget } from './ShapeCode';
import { RefList, RefsCtx, type RefsState } from './refs';
import { useShapeFollow } from './ShapeFollow';
import { ShapeInline } from './inline';
import type { ShapeEvent, ShapeHost, ShapeLoaded, ShapePanelTab, ShapeSessionStatus, ShapeSurfaceProps } from './types';

const DRAW_MS = 1500; // the longest draw-in, for Esc
const DRAWN_MS = DRAW_MS + 1400; // when a view counts as drawn (its draw-in class is dropped)
const ERASE_MS = 420;

const PHONE_MAX = 640;

/**
 * The phone layout (a bottom sheet, short labels) goes by the board's own
 * width, not the window's: a narrow Inbox pane on a desktop gets it too.
 */
function usePhone(el: HTMLElement | null) {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth <= PHONE_MAX);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setPhone(el.clientWidth <= PHONE_MAX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return phone;
}

const ViewIcon = ({ id }: { id: ShapeViewId }) => {
  const p = { width: 14, height: 14, fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (id === 'picture') return <svg {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 15l3-3 3 3 2-2 3 3" /></svg>;
  if (id === 'how') return <svg {...p}><rect x="2.5" y="9" width="6" height="6" rx="1.5" /><rect x="15.5" y="4" width="6" height="6" rx="1.5" /><rect x="15.5" y="14" width="6" height="6" rx="1.5" /><path d="M8.5 12h3.5M12 12V7h3.5M12 12v5h3.5" /></svg>;
  if (id === 'reqs') return <svg {...p}><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth={3} /></svg>;
  return <svg {...p}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /></svg>;
};
/** The globe Plannotator draws on its "Global comment" buttons. */
const GlobeIcon = () => (
  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true" style={{ flex: 'none' }}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
  </svg>
);
const ChatIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>;
const RefsIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="3" /><path d="M13 7h8M13 17h8" /><circle cx="7" cy="17" r="3" /></svg>;

const SHORT: Record<ShapeViewId, string> = { picture: 'Picture', how: 'How', reqs: 'Reqs', code: 'Code' };

function asOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
  return `${date}, ${time} UTC`;
}

type Viewer =
  | { kind: 'image'; ref: ShapeRef }
  | { kind: 'file'; path: string; contents: string; line?: number; token: number }
  | { kind: 'diff'; path: string; patch: string }
  | null;

/** A part the person chose: its element, view and id (null: the whole board, or the whole view). */
interface Target {
  el: HTMLElement;
  view: ShapeViewId | null;
  id: string | null;
  text: string;
}

const key = (view: string, id: string) => `${view}/${id}`;

/**
 * The composer's draft key (CommentPopover `draftKey`): one draft per shape and
 * target. A part is its view, mark id and the words chosen; the whole board or
 * a whole view has no id and no words.
 */
const shapeCommentDraftKey = (shapeId: string, t: Pick<Target, 'view' | 'id' | 'text'>) =>
  `shape:${shapeId}:${t.view ?? 'board'}:${t.id ?? ''}:${t.text}`;

function marksFor(all: MarkState, view: ShapeViewId): MarkState {
  const pick = (s: ReadonlySet<string>) => new Set([...s].filter((k) => k.startsWith(`${view}/`)).map((k) => k.slice(view.length + 1)));
  return { fresh: pick(all.fresh), erasing: pick(all.erasing), noted: pick(all.noted) };
}

const without = (s: ReadonlySet<string>, drop: readonly string[]) => new Set([...s].filter((x) => !drop.includes(x)));

/** The Ask panel's words once the session ended: what answers a question then depends on the host. */
export function shapeEndedLabel(host: Pick<ShapeHost, 'askWaitsWhenEnded'>): string {
  return host.askWaitsWhenEnded ? 'Session ended · your question waits for the agent' : 'Session ended · Ask AI answers; changes wait for the agent';
}

export function ShapeSurface({ host, id, onClose, CodeGuide, CodeHoverCard, renderThread, initialView, initialPanel, onNavigate }: ShapeSurfaceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const attachRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setRootEl(el);
  }, []);
  const phone = usePhone(rootEl);
  const reduce = useReducedMotion();

  const [loaded, setLoaded] = useState<ShapeLoaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [version, setVersion] = useState<ShapeVersion | null>(null);
  const [notes, setNotes] = useState<ShapeNote[]>([]);
  const [session, setSession] = useState<ShapeSessionStatus>({ state: 'gone', agent: 'the agent' });
  const versionRef = useRef<ShapeVersion | null>(null);
  versionRef.current = version;

  // ── views: erase the old one, draw the new one ──
  const views = useMemo(() => SHAPE_VIEWS.filter((v) => version?.views[v.id]), [version]);
  const [view, setView] = useState<ShapeViewId>(initialView ?? 'picture');
  const viewRef = useRef(view);
  viewRef.current = view;
  const [leaving, setLeaving] = useState<ShapeViewId | null>(null);
  const [drawKey, setDrawKey] = useState(0);
  const [drawnKey, setDrawnKey] = useState('');
  const [skip, setSkip] = useState(false);
  const drawingUntil = useRef(0);

  const [marks, setMarks] = useState<MarkState>(NO_MARKS);
  const [behind, setBehind] = useState<Partial<Record<ShapeViewId, string[]>>>({});
  const [agentDrawing, setAgentDrawing] = useState(false);
  const [inFlight, setInFlight] = useState<string[]>([]);
  const [updated, setUpdated] = useState<string | null>(null);
  const busy = agentDrawing || inFlight.length > 0;

  const [inputMethod, setInputMethod] = useState<InputMethod>('pinpoint');
  const [mode, setMode] = useState<EditorMode>('selection');
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const [target, setTarget] = useState<Target | null>(null);

  const [panel, setPanel] = useState<ShapePanelTab | null>(initialPanel ?? null);
  const [lastTab, setLastTab] = useState<ShapePanelTab>('ask');
  const [answerReady, setAnswerReady] = useState(false);
  const [streams, setStreams] = useState<Record<string, { prompt: string; scope: AIChatEntry['question']['scope']; text: string; at: number; done?: boolean }>>({});
  const [msgFlash, setMsgFlash] = useState<string | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;

  const [refHover, setRefHover] = useState<number | null>(null);
  const [refFlash, setRefFlash] = useState<number | null>(null);
  const [viewer, setViewer] = useState<Viewer>(null);
  const [file, setFile] = useState<ShapeFileTarget | null>(null);
  const [codeNotes, setCodeNotes] = useState<CodeAnnotation[]>([]);
  const [copied, setCopied] = useState(false);
  // The How it works drawing, for "Follow an example" (its examples light their path on it).
  const [howBoard, setHowBoard] = useState<HTMLElement | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => onNavigate?.({ view, panel }), [view, panel]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPanel = useCallback((tab: ShapePanelTab) => {
    setPanel(tab);
    setLastTab(tab);
    if (tab === 'ask') setAnswerReady(false);
  }, []);
  const closePanel = useCallback(() => setPanel(null), []);

  const upsertNote = useCallback((note: ShapeNote) => {
    setNotes((all) => {
      const at = all.findIndex((n) => n.id === note.id);
      if (at < 0) return [...all, note];
      const next = all.slice();
      next[at] = note;
      return next;
    });
  }, []);

  // ── a new version: erase what changed here, redraw it, dot the other views ──
  const applyVersion = useCallback((next: ShapeVersion, fromSeen = false) => {
    const current = versionRef.current;
    if (!current || next.n === current.n) {
      setVersion(next);
      return;
    }
    const diff = diffShapeVersions(current, next);
    const here = viewRef.current;
    const changedHere = diff.changes.filter((c) => c.view === here);
    const erase = changedHere.filter((c) => c.kind !== 'added').map((c) => key(c.view, c.id));
    const fresh = changedHere.filter((c) => c.kind !== 'removed').map((c) => key(c.view, c.id));
    const headerFresh = diff.changes.filter((c) => c.view === 'header').map((c) => key('header', c.id));
    const elsewhere = diff.views.filter((v) => v !== here);
    const wholeView = diff.views.includes(here) && changedHere.length === 0;

    setMarks((m) => ({ ...m, erasing: new Set([...m.erasing, ...erase]) }));
    drawingUntil.current = Date.now() + 2400;
    later(() => {
      setVersion(next);
      if (wholeView) setDrawKey((k) => k + 1);
      setMarks((m) => ({ erasing: without(m.erasing, erase), fresh: new Set([...m.fresh, ...fresh, ...headerFresh]), noted: new Set() }));
      setBehind((b) => {
        const out = { ...b };
        for (const v of elsewhere) out[v] = [...new Set([...(out[v] ?? []), ...diff.changes.filter((c) => c.view === v).map((c) => key(c.view, c.id))])];
        return out;
      });
      const names = diff.views.map((v) => shapeViewLabel(v));
      setUpdated(fromSeen
        ? `Since you looked · v${current.n} → v${next.n}${names.length ? ` · ${names.join(', ')}` : ''}`
        : names.length ? `Board updated · ${names.join(', ')}` : `Board updated · v${next.n}`);
      later(() => setMarks((m) => ({ ...m, fresh: without(m.fresh, [...fresh, ...headerFresh]) })), 2600);
      later(() => setUpdated(null), fromSeen ? 6000 : 4200);
    }, reduce || fromSeen ? 0 : ERASE_MS);
  }, [later, reduce]);

  // ── load, and follow the host's events ──
  useEffect(() => {
    let live = true;
    setLoaded(null);
    setFailed(null);
    host.load(id).then(
      async (data) => {
        if (!live) return;
        setNotes(data.notes);
        setSession(data.session);
        setAgentDrawing(!!data.shape.drawing && Date.parse(data.shape.drawing.until) > Date.now());
        setLoaded(data);
        // "What changed since you looked": open on the version you saw, then move to the latest.
        if (data.seen && data.seen < data.version.n) {
          const old = await host.version(id, data.seen).catch(() => null);
          if (!live) return;
          if (old) {
            versionRef.current = old;
            setVersion(old);
            later(() => applyVersion(data.version, true), reduce ? 0 : DRAW_MS);
            return;
          }
        }
        setVersion(data.version);
      },
      (error) => live && setFailed(error instanceof Error ? error.message : String(error)),
    );
    const off = host.events(id, (event: ShapeEvent) => {
      if (!live) return;
      if (event.type === 'version') {
        setLoaded((l) => (l ? { ...l, shape: event.shape } : l));
        setAgentDrawing(false);
        setInFlight([]);
        applyVersion(event.version);
      } else if (event.type === 'drawing') {
        setAgentDrawing(!!event.until && Date.parse(event.until) > Date.now());
      } else if (event.type === 'note') {
        upsertNote(event.note);
        if (event.note.kind === 'answer') {
          setInFlight((f) => f.filter((x) => x !== event.note.re));
          if (event.note.re && panelRef.current !== 'ask') setAnswerReady(true);
          setMarks((m) => ({ ...m, noted: new Set() }));
        }
      } else if (event.type === 'state') {
        setLoaded((l) => (l ? { ...l, shape: event.shape } : l));
      } else if (event.type === 'session') {
        setSession(event.session);
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [host, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seen: once the latest version has drawn in.
  useEffect(() => {
    if (!version || !loaded || version.n < loaded.version.n) return;
    if (drawnKey !== `${view}-${drawKey}`) return;
    host.seen(id, version.n);
  }, [drawnKey, version, loaded, host, id, view, drawKey]);

  // Keep the view on one the board has.
  useEffect(() => {
    if (version && !version.views[view] && views[0]) setView(views[0].id);
  }, [version, view, views]);

  useEffect(() => {
    const k = `${view}-${drawKey}`;
    const t = window.setTimeout(() => setDrawnKey(k), skip ? 0 : DRAWN_MS);
    return () => clearTimeout(t);
  }, [view, drawKey, skip]);

  const go = useCallback((next: ShapeViewId) => {
    if (next === view) return;
    setTarget(null);
    setHoverRect(null);
    setLeaving(view);
    setView(next);
    setSkip(false);
    setDrawKey((k) => k + 1);
    drawingUntil.current = Date.now() + DRAW_MS;
    later(() => setLeaving((l) => (l === view ? null : l)), reduce ? 160 : ERASE_MS + 40);
    const pending = behind[next];
    if (pending?.length) {
      later(() => {
        setMarks((m) => ({ ...m, fresh: new Set([...m.fresh, ...pending]) }));
        later(() => setMarks((m) => ({ ...m, fresh: without(m.fresh, pending) })), 2600);
      }, reduce ? 0 : 900);
    }
    if (behind[next]) setBehind((b) => ({ ...b, [next]: undefined }));
  }, [view, behind, reduce, later]);

  const openCode = useCallback((path: string, line: number) => {
    setFile({ path, line, token: Date.now() });
    go('code');
  }, [go]);

  // The host reads files in the project only: a board from anywhere cannot ask for /etc or ../.
  const readProjectFile = useCallback(
    async (path: string) => (isShapeProjectPath(path) ? (await host.readFile?.(id, path)) ?? null : null),
    [host, id],
  );

  // A drawn part with `data-code`: the Code view's whole file when it has one, else the file viewer.
  const openCodeTarget = useCallback(async (at: ShapeCodeTarget) => {
    const v = versionRef.current;
    if (v?.views.code && host.readFile && (v.views.code.files ?? []).some((f) => f.path === at.path)) {
      openCode(at.path, at.line);
      return;
    }
    const contents = await readProjectFile(at.path);
    if (contents != null) setViewer({ kind: 'file', path: at.path, contents, line: at.line, token: Date.now() });
  }, [readProjectFile, host, openCode]);

  // Esc: close the panel; otherwise skip the drawing while it plays.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || target || viewer) return;
      // What the board uses Escape for is marked used, so the host's own Escape (the Inbox's: close the board) waits.
      if (panelRef.current) {
        e.preventDefault();
        setPanel(null);
        return;
      }
      if (Date.now() > drawingUntil.current) return;
      e.preventDefault();
      setSkip(true);
      setLeaving(null);
      drawingUntil.current = 0;
    };
    // Capture: before a host's window listener, which closes the board on an Escape the board did not use.
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [target, viewer]);

  // ── Change it and Ask ──
  const shapeState = loaded?.shape.state ?? 'active';
  const finished = shapeState === 'finished';

  const sendChange = useCallback(async (input: Omit<ShapeNoteInput, 'kind' | 'v'>) => {
    const v = versionRef.current;
    if (!v || finished) return;
    if (input.part && input.view) {
      const k = key(input.view, input.part);
      setMarks((m) => ({ ...m, noted: new Set([...m.noted, k]) }));
    }
    try {
      const note = await host.note(id, { ...input, kind: 'change', v: v.n });
      upsertNote(note);
      if (session.state !== 'gone') setInFlight((f) => [...f, note.id]);
    } catch {
      setMarks((m) => ({ ...m, noted: new Set() }));
    }
  }, [host, id, finished, session.state, upsertNote]);

  const sendAsk = useCallback(async (input: Omit<ShapeNoteInput, 'kind' | 'v'>, scope: AIChatEntry['question']['scope']) => {
    const v = versionRef.current;
    if (!v || finished) return;
    openPanel('ask');
    const temp = `pending-${Date.now()}`;
    setStreams((s) => ({ ...s, [temp]: { prompt: input.text, scope, text: '', at: Date.now() } }));
    try {
      const result = await host.ask(id, { ...input, kind: 'ask', v: v.n }, (text) => setStreams((s) => (s[temp] ? { ...s, [temp]: { ...s[temp]!, text } } : s)));
      upsertNote(result.question);
      if (result.answer) upsertNote(result.answer);
    } finally {
      setStreams((s) => {
        const { [temp]: _gone, ...rest } = s;
        return rest;
      });
      if (panelRef.current !== 'ask') setAnswerReady(true);
    }
  }, [host, id, finished, openPanel, upsertNote]);

  // ── references ──
  const refs = useMemo(() => version?.refs ?? [], [version]);
  const assetUrl = useCallback((src: string) => host.assetUrl?.(id, src) ?? src, [host, id]);

  const openRef = useCallback(async (n: number) => {
    const r = refs.find((x) => x.n === n);
    if (!r) return;
    if (r.kind === 'message') {
      if (!renderThread) return;
      openPanel('thread');
      later(() => {
        rootRef.current?.querySelector(`[data-shape-message="${CSS.escape(r.target)}"]`)?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
        setMsgFlash(r.target);
        later(() => setMsgFlash(null), 1800);
      }, 260);
    } else if (r.kind === 'image') {
      // Only an image the board keeps (files/…) or carries (data:image); nothing from outside.
      if (shapeUrlAllowed(r.target)) setViewer({ kind: 'image', ref: { ...r, images: r.images?.filter((im) => shapeUrlAllowed(im.src)) } });
    } else if (r.kind === 'file') {
      const contents = await readProjectFile(r.target);
      if (contents != null) setViewer({ kind: 'file', path: r.target, contents, line: r.line, token: Date.now() });
    } else if (r.kind === 'diff') {
      const patch = versionRef.current?.views.code?.patch;
      const one = patch ? parseDiffToFiles(patch).find((f) => f.path === r.target) : undefined;
      if (one) setViewer({ kind: 'diff', path: one.path, patch: one.patch });
    } else {
      const url = shapeLinkUrl(r.target);
      if (url) window.open(url, '_blank', 'noreferrer');
    }
  }, [refs, renderThread, openPanel, later, reduce, readProjectFile]);

  const canOpen = useCallback((r: ShapeRef) => {
    if (r.kind === 'message') return !!renderThread;
    if (r.kind === 'file') return !!host.readFile;
    if (r.kind === 'diff') return !!version?.views.code?.patch;
    return true;
  }, [renderThread, host, version]);

  /** The view a bubble sits on, so a list row can bring it up. */
  const homeOf = useCallback((n: number): ShapeViewId | 'header' | null => {
    const v = versionRef.current;
    if (!v) return null;
    const cite = new RegExp(`\\[\\^${n}\\]`);
    const tag = new RegExp(`data-ref\\s*=\\s*["']?${n}\\b`);
    if (cite.test(v.claim)) return 'header';
    if (view !== 'code' && v.views[view] && JSON.stringify(v.views[view]).match(view === 'reqs' ? cite : tag)) return view;
    if (tag.test(v.views.picture?.html ?? '') || tag.test(v.views.picture?.tall?.html ?? '')) return 'picture';
    if (tag.test(v.views.how?.html ?? '') || tag.test(v.views.how?.tall?.html ?? '')) return 'how';
    if (v.views.reqs && cite.test(JSON.stringify(v.views.reqs))) return 'reqs';
    return null;
  }, [view]);

  const flashRef = useCallback((n: number) => {
    if (phone) setPanel(null);
    const home = homeOf(n);
    const needView = home && home !== 'header' && home !== view ? home : null;
    if (needView) go(needView);
    later(() => {
      if (home === 'header' || home === 'reqs') rootRef.current?.querySelector(`.shp-surface [data-ref="${n}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      setRefFlash(n);
      later(() => setRefFlash((f) => (f === n ? null : f)), 1700);
    }, needView ? (reduce ? 200 : 1100) : phone ? 280 : 0);
  }, [phone, homeOf, view, go, later, reduce]);

  const refsState = useMemo<RefsState>(() => ({ refs, hover: refHover, flash: refFlash, onHover: setRefHover, onOpen: openRef }), [refs, refHover, refFlash, openRef]);

  // ── pointing at the board ──
  const pickMark = useCallback((el: HTMLElement, v: ShapeViewId, text?: string) => {
    setTarget({ el, view: v, id: el.getAttribute('data-mark'), text: (text ?? el.innerText).replace(/\s+/g, ' ').trim() });
    setHoverRect(null);
  }, []);
  const hoverMark = useCallback((el: HTMLElement | null) => {
    if (target || inputMethod !== 'pinpoint') return setHoverRect(null);
    setHoverRect(el ? el.getBoundingClientRect() : null);
  }, [target, inputMethod]);

  // Requirements are the board's own markup: point at them here.
  const onReqsMove = (e: React.PointerEvent) => {
    if (view !== 'reqs' || inputMethod !== 'pinpoint' || target || (e.target as Element).closest('.shp-rb,.shp-to-code')) return hoverRect && setHoverRect(null);
    const el = (e.target as Element).closest<HTMLElement>('[data-mark]');
    setHoverRect(el ? el.getBoundingClientRect() : null);
  };
  const onReqsClick = (e: React.MouseEvent) => {
    if (view !== 'reqs' || inputMethod !== 'pinpoint') return;
    if ((e.target as Element).closest('a,button,select')) return;
    const el = (e.target as Element).closest<HTMLElement>('[data-mark]');
    if (el) pickMark(el, 'reqs');
  };
  const onReqsMouseUp = () => {
    if (view !== 'reqs' || inputMethod !== 'drag') return;
    requestAnimationFrame(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!sel || sel.isCollapsed || !text) return;
      const el = (sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest<HTMLElement>('[data-mark]');
      if (el && stageRef.current?.contains(el)) pickMark(el, 'reqs', text);
    });
  };

  // A click on the board closes the panel, and does only that. Bubbles and the dock keep working.
  const onShapeClickCapture = (e: React.MouseEvent) => {
    if (!panel) return;
    const t = (e.nativeEvent.composedPath()[0] ?? e.target) as Element;
    if (t instanceof Element && t.closest('.shp-dock, .shp-rb, .shp-pill, .shp-general, .shp-ex-card')) return;
    e.stopPropagation();
    e.preventDefault();
    setPanel(null);
  };

  const quoteLabel = (t: Target) => {
    const where = t.view ? shapeViewLabel(t.view) : 'Board';
    return `${where} · “${t.text.length > 48 ? `${t.text.slice(0, 46)}…` : t.text}”`;
  };

  // ── global comments: the whole board, or the whole Code view ──
  // The words, globe and look of Plannotator's other "Global comment" buttons.
  const [general, setGeneral] = useState<{ el: HTMLElement; view: ShapeViewId | null } | null>(null);
  const generalButton = (forView: ShapeViewId | null) => (
    <button
      type="button"
      className="shp-general"
      disabled={finished}
      onClick={(e) => {
        setTarget(null);
        setGeneral({ el: e.currentTarget, view: forView });
      }}
      title="Add global comment"
      aria-haspopup="dialog"
    >
      <GlobeIcon />
      <span>Global comment</span>
    </button>
  );

  const codeInput = (kind: 'change' | 'ask') => (input: CodeFileAnnotationInput) => {
    const quote = input.originalCode ?? null;
    const part = `${input.filePath}:${input.lineStart}`;
    const label = `${input.filePath.split('/').pop()}, line ${input.lineStart}`;
    if (kind === 'change') {
      setCodeNotes((c) => [...c, {
        id: `c${Date.now()}`, type: 'COMMENT' as CodeAnnotation['type'], scope: 'line', filePath: input.filePath,
        lineStart: input.lineStart, lineEnd: input.lineEnd, text: input.text, side: 'new', createdAt: Date.now(), originalCode: input.originalCode,
      } as CodeAnnotation]);
      void sendChange({ view: 'code', part, quote, text: input.text });
    } else {
      void sendAsk({ view: 'code', part, quote, text: input.text }, { kind: 'selection', label, text: quote ?? undefined });
    }
  };

  // ── the Ask tab's entries: every Change it and Ask, with its answer ──
  const agent = session.agent;
  const entries = useMemo<AIChatEntry[]>(() => {
    const answers = new Map(notes.filter((n) => n.kind === 'answer' && n.re).map((n) => [n.re!, n]));
    const out: AIChatEntry[] = notes
      .filter((n) => n.from === 'you' && (n.kind === 'change' || n.kind === 'ask'))
      .map((q) => {
        const a = answers.get(q.id);
        const where = q.view ? shapeViewLabel(q.view) : 'The whole board';
        const scope: AIChatEntry['question']['scope'] = q.part
          ? { kind: 'selection', label: `${where} · “${(q.quote ?? '').slice(0, 46)}”`, text: q.quote ?? undefined }
          : { kind: 'general', label: q.view ? `${where} · general` : where };
        const at = Date.parse(q.at);
        const status = q.kind !== 'change' || a
          ? undefined
          : shapeNoteWaits(q) && session.state === 'gone' ? 'Waits for the agent' : q.delivered ? `${agent} has it` : `Sent to ${agent}`;
        return {
          question: { id: q.id, prompt: q.kind === 'change' ? `Change: ${q.text}` : q.text, createdAt: at, scope },
          response: { questionId: q.id, text: a?.text ?? '', isStreaming: false, createdAt: a ? Date.parse(a.at) : at, ...(status ? { notice: status } : {}) },
        };
      });
    for (const [tid, s] of Object.entries(streams)) {
      out.push({
        question: { id: tid, prompt: s.prompt, createdAt: s.at, scope: s.scope },
        response: { questionId: tid, text: s.text, isStreaming: true, createdAt: s.at },
      });
    }
    return out;
  }, [notes, streams, session.state, agent]);
  const streaming = Object.keys(streams).length > 0;

  const provider = useMemo<AIProviderOption[]>(() => [{
    id: 'shape-session',
    name: 'session-bridge',
    label: session.state === 'gone' ? shapeEndedLabel(host) : `Ask this session · ${agent}`,
    sessionBridge: { host: agent, status: session.state === 'gone' ? 'gone' : session.state === 'busy' ? 'busy' : 'ready', modes: { turn: true, transient: true } },
  }], [session.state, agent, host]);

  const waiting = notes.filter(shapeNoteWaits).length;
  const bringUpToDate = async () => {
    if (!host.refresh) return;
    setAgentDrawing(true);
    try {
      await host.refresh(id);
    } catch {
      setAgentDrawing(false);
    }
  };

  const follow = useShapeFollow({
    examples: version?.views.how?.examples,
    board: howBoard,
    active: view === 'how',
    phone,
    reduce,
    surface: rootEl,
    onCode: (at) => void openCodeTarget(at),
    canOpen: (path) => !!host.readFile && isShapeProjectPath(path),
  });

  const copyPrompt = async () => {
    const text = host.resumePrompt?.(id);
    if (!text) return;
    await host.copy?.(text);
    setCopied(true);
    later(() => setCopied(false), 1800);
  };

  if (failed) return <div className="shp-surface shp-failed" role="alert">This board could not be opened: {failed}</div>;
  if (!loaded || !version) return <div className="shp-surface shp-loading" aria-busy="true"><Pebble alive reshaping size={28} /></div>;

  const renderView = (v: ShapeViewId, phase: 'entering' | 'drawn' | 'leaving') => {
    const vm = marksFor(marks, v);
    if (v === 'picture' || v === 'how') {
      const drawn = version.views[v];
      if (!drawn) return null;
      return (
        <ShapeDrawn
          drawn={drawn}
          phase={phase}
          skip={skip}
          reduce={reduce}
          pinpoint={inputMethod === 'pinpoint' && phase !== 'leaving' && !target}
          select={inputMethod === 'drag'}
          marks={vm}
          refs={refs}
          refHover={refHover}
          refFlash={refFlash}
          onRefHover={setRefHover}
          onRefOpen={(n) => void openRef(n)}
          resolveSrc={assetUrl}
          onHoverMark={phase === 'leaving' ? () => {} : hoverMark}
          onPickMark={(el, text) => pickMark(el, v, text)}
          onCode={phase === 'leaving' ? undefined : openCodeTarget}
          onBoard={v === 'how' && phase !== 'leaving' ? setHowBoard : undefined}
        />
      );
    }
    if (v === 'reqs') {
      const reqs = version.views.reqs;
      return reqs ? <ShapeRequirements reqs={reqs} marks={vm} onCode={version.views.code ? openCode : undefined} /> : null;
    }
    const code = version.views.code;
    if (!code) return null;
    return (
      <ShapeCode
        code={code}
        CodeGuide={CodeGuide}
        CodeHoverCard={CodeHoverCard}
        file={phase === 'leaving' ? null : file}
        onOpenFile={(path, line) => setFile({ path, line, token: Date.now() })}
        onCloseFile={() => setFile(null)}
        readFile={host.readFile ? readProjectFile : undefined}
        codeHover={host.codeHover ? (req) => host.codeHover!(id, req) : undefined}
        annotations={codeNotes}
        onComment={codeInput('change')}
        onAsk={codeInput('ask')}
        generalComment={phase === 'leaving' ? null : generalButton('code')}
        phone={phone}
      />
    );
  };

  const fresh = (id2: string) => (marks.fresh.has(key('header', id2)) ? ' shp-fresh-text' : '');
  const pinpointing = inputMethod === 'pinpoint' && view !== 'code';
  const chatOn = panel === 'ask' || panel === 'thread';

  return (
    <RefsCtx.Provider value={refsState}>
      <div ref={attachRoot} className={`shp-root${phone ? ' phone' : ''}${panel ? ' panel-open' : ''}${follow.sheet ? ' follow-sheet' : ''}`}>
        <RefHoverCards rootRef={rootRef} />

        <section className="shp-surface" aria-label="Shape" onClickCapture={onShapeClickCapture}>
          <header className="shp-head">
            <div className="shp-top">
              {onClose ? (
                <button type="button" className="shp-hb open" onClick={onClose} title="Close Shape" aria-label="Close Shape">
                  <Pebble alive reshaping={busy} />
                </button>
              ) : (
                <span className="shp-hb open" aria-hidden="true"><Pebble alive reshaping={busy} /></span>
              )}
              <span className="shp-eyebrow">
                {loaded.shape.project.name} · Shape · {busy && agentDrawing ? `${agent} is drawing v${version.n + 1}…` : `as of ${asOf(version.asOf ?? version.at)}`}
                {finished ? ' · Finished' : ''}
              </span>
              <span className="shp-versions" title={`Version ${version.n}`} aria-label={`Version ${version.n}`}>
                {Array.from({ length: Math.min(version.n, 12) }, (_, i) => <i key={i} className={i === Math.min(version.n, 12) - 1 ? 'cur' : ''} />)}
              </span>
              <span className="shp-grow" />
              {!phone && generalButton(null)}
              {host.refresh && !finished && (
                <button type="button" className="shp-quiet-btn" onClick={() => void bringUpToDate()} disabled={busy}>Bring it up to date</button>
              )}
            </div>
            <h1 className={fresh('title').trim()}>{version.title}</h1>
            <p className={`shp-claim${fresh('claim')}`}><ShapeInline text={version.claim} /></p>
          </header>

          <div
            ref={stageRef}
            className={`shp-stage${skip ? ' skip' : ''}${reduce ? ' reduce' : ''}${pinpointing ? ' pinpointing' : ''}`}
            onPointerMove={onReqsMove}
            onPointerLeave={() => setHoverRect(null)}
            onClick={onReqsClick}
            onMouseUp={onReqsMouseUp}
          >
            {leaving && leaving !== view && version.views[leaving] && (
              <div className={`shp-view v-${leaving} leaving`} aria-hidden="true">{renderView(leaving, 'leaving')}</div>
            )}
            <div key={`${view}-${drawKey}`} className={`shp-view v-${view}${drawnKey === `${view}-${drawKey}` ? ' drawn' : ' entering'}`}>
              {renderView(view, drawnKey === `${view}-${drawKey}` ? 'drawn' : 'entering')}
            </div>
          </div>

          {updated ? (
            <div className="shp-pill" role="status"><Pebble alive reshaping={busy} size={16} />{updated}</div>
          ) : waiting > 0 && session.state === 'gone' ? (
            <div className="shp-pill waits" role="status">
              <Pebble alive={false} size={16} />
              {waiting === 1 ? '1 change waits for the agent' : `${waiting} changes wait for the agent`}
              {host.resumePrompt && (
                <button type="button" onClick={() => void copyPrompt()}>{copied ? 'Copied' : 'Copy prompt'}</button>
              )}
            </div>
          ) : null}

          <div className="shp-dock" role="toolbar" aria-label="Shape toolbar">
            <div className="shp-tgroup" role="group" aria-label="Views">
              {views.map((v) => (
                <button key={v.id} type="button" className={`shp-tbtn${view === v.id ? ' on' : ''}`} onClick={() => go(v.id)} aria-pressed={view === v.id} title={v.label}>
                  <ViewIcon id={v.id} />
                  {(!phone || view === v.id) && <span className="tl">{phone ? SHORT[v.id] : v.label}</span>}
                  {behind[v.id]?.length ? <span className="shp-tdot" aria-label="changed" /> : null}
                </button>
              ))}
            </div>
            {follow.button && (
              <div className="shp-tgroup" role="group" aria-label="Examples">
                {follow.button}
              </div>
            )}
            {view !== 'code' && !phone && (
              <div className="shp-tstrip">
                <AnnotationToolstrip
                  inputMethod={inputMethod}
                  onInputMethodChange={setInputMethod}
                  mode={mode}
                  onModeChange={setMode}
                  compact
                  iconOnly
                  showHelpLink={false}
                  hideQuickLabel
                  hideRedline
                />
              </div>
            )}
            <div className="shp-tgroup side" role="group" aria-label="Panel">
              <button type="button" className={`shp-tbtn${panel === 'refs' ? ' on' : ''}`} onClick={() => (panel === 'refs' ? closePanel() : openPanel('refs'))} aria-pressed={panel === 'refs'} title="References">
                <RefsIcon />
                {!phone && <span className="tl">References</span>}
                {refs.length > 0 && <span className="shp-tcount">{refs.length}</span>}
              </button>
              <button
                type="button"
                className={`shp-tbtn chat${chatOn ? ' on' : ''}${answerReady ? ' ready' : ''}`}
                onClick={() => (chatOn ? closePanel() : openPanel(answerReady ? 'ask' : lastTab === 'refs' || (lastTab === 'thread' && !renderThread) ? 'ask' : lastTab))}
                aria-pressed={chatOn}
                title={answerReady ? 'Answer ready' : 'Chat'}
              >
                <ChatIcon />
                {(!phone || answerReady) && <span className="tl">{answerReady ? (phone ? 'Answer' : 'Answer ready') : 'Chat'}</span>}
                {answerReady && <span className="shp-ready-dot" aria-hidden="true" />}
              </button>
              {phone && (
                <button type="button" className="shp-tbtn" onClick={(e) => { setTarget(null); setGeneral({ el: e.currentTarget, view: null }); }} title="Add global comment" aria-label="Global comment" disabled={finished}>
                  <GlobeIcon />
                </button>
              )}
            </div>
          </div>

          {follow.card}

          {hoverRect && <div className="shp-pin-hover" style={{ left: hoverRect.left - 4, top: hoverRect.top - 3, width: hoverRect.width + 8, height: hoverRect.height + 6 }} />}

          {target && !finished && (
            <CommentPopover
              anchorEl={target.el}
              contextText={quoteLabel(target)}
              isGlobal={false}
              allowImages={false}
              // The words typed for this part survive a close (Escape, X) and come back when it is chosen again.
              draftKey={shapeCommentDraftKey(id, target)}
              submitLabel="Change it"
              askAILabel="Ask"
              onSubmit={(text) => {
                void sendChange({ view: target.view, part: target.id, quote: target.text, text });
                setTarget(null);
              }}
              onAskAI={(question) => {
                void sendAsk({ view: target.view, part: target.id, quote: target.text, text: question }, { kind: 'selection', label: quoteLabel(target), text: target.text });
                setTarget(null);
                return true;
              }}
              askAIContext={{ kind: 'selection', label: quoteLabel(target), text: target.text }}
              onClose={() => setTarget(null)}
            />
          )}
          {general && !finished && (
            <CommentPopover
              anchorEl={general.el}
              contextText=""
              isGlobal
              headerText={general.view ? `${shapeViewLabel(general.view)} · the whole guide` : 'The whole board'}
              allowImages={false}
              draftKey={shapeCommentDraftKey(id, { view: general.view, id: null, text: '' })}
              submitLabel="Change it"
              askAILabel="Ask"
              onSubmit={(text) => {
                void sendChange({ view: general.view, part: null, quote: null, text });
                setGeneral(null);
              }}
              onAskAI={(question) => {
                const label = general.view ? `${shapeViewLabel(general.view)} · general` : 'The whole board';
                void sendAsk({ view: general.view, part: null, quote: null, text: question }, { kind: 'general', label });
                setGeneral(null);
                return true;
              }}
              askAIContext={{ kind: 'general' }}
              onClose={() => setGeneral(null)}
            />
          )}
        </section>

        {phone && panel && <div className="shp-scrim" onClick={closePanel} aria-hidden="true" />}
        <aside
          className={`shp-sidep${phone ? ' sheet' : ''}${panel ? ' open' : ''}`}
          aria-label="Chat and references"
          aria-hidden={!panel}
          inert={!panel}
          onClickCapture={(e) => {
            // A `code:path#L12` link in an answer opens the code there.
            const a = (e.target as Element).closest('a');
            const m = a?.getAttribute('href')?.match(/^code:([^#]+)#L(\d+)/);
            if (m) {
              e.preventDefault();
              openCode(m[1]!, Number(m[2]));
            }
          }}
        >
          {phone && <div className="shp-grab" aria-hidden="true" />}
          <div className="shp-sidep-head">
            <div className="shp-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={panel === 'ask'} className={panel === 'ask' ? 'on' : ''} onClick={() => openPanel('ask')}><SparklesIcon className="w-3.5 h-3.5" />Ask</button>
              {renderThread && (
                <button type="button" role="tab" aria-selected={panel === 'thread'} className={panel === 'thread' ? 'on' : ''} onClick={() => openPanel('thread')}><ChatIcon />Thread</button>
              )}
              <button type="button" role="tab" aria-selected={panel === 'refs'} className={panel === 'refs' ? 'on' : ''} onClick={() => openPanel('refs')}><RefsIcon />References</button>
            </div>
            <button type="button" className="shp-icon-btn" onClick={closePanel} aria-label="Close panel" title="Close (Esc)">×</button>
          </div>
          <div className="shp-sidep-body">
            {panel === 'ask' && (
              <DocumentAIChatPanel
                messages={entries}
                isCreatingSession={false}
                isStreaming={streaming}
                onAskGeneral={finished ? undefined : (text) => void sendAsk({ view: null, part: null, quote: null, text }, { kind: 'general', label: 'The whole board' })}
                aiProviders={provider}
              />
            )}
            {panel === 'thread' && renderThread && <div className="shp-thread-in">{renderThread({ flash: msgFlash })}</div>}
            {panel === 'refs' && <RefList onShow={flashRef} canOpen={canOpen} />}
          </div>
        </aside>

        {viewer?.kind === 'image' && (
          <ImageLightbox
            src={assetUrl(viewer.ref.target)}
            alt={viewer.ref.title}
            images={viewer.ref.images?.map((i) => ({ src: assetUrl(i.src), alt: i.alt }))}
            swipe={phone}
            onClose={() => setViewer(null)}
          />
        )}
        {viewer?.kind === 'file' && (
          <CodeFilePopout open onClose={() => setViewer(null)} filepath={viewer.path} contents={viewer.contents} line={viewer.line} revealKey={viewer.token} />
        )}
        {viewer?.kind === 'diff' && (
          <PopoutDialog open onClose={() => setViewer(null)} title={viewer.path}>
            <div className="shp-diff-pop"><ShapePatch patch={viewer.patch} /></div>
          </PopoutDialog>
        )}
      </div>
    </RefsCtx.Provider>
  );
}

