import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  diffShapeVersions,
  isShapeProjectPath,
  shapeLinkUrl,
  shapeNoteWaits,
  shapeUrlAllowed,
  shapeViewContent,
  shapeViewNow,
  type ShapeCodeTarget,
  type ShapeNote,
  type ShapeNoteInput,
  type ShapeRef,
  type ShapeVersion,
  type ShapeViewId,
} from '@plannotator/core/shape';
import { parseDiffToFiles } from '@plannotator/core/diff-files';
import { AnnotationToolstrip } from '../AnnotationToolstrip';
import { CommentPopover, type CommentExtraAction } from '../CommentPopover';
import { partName } from './partName';
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
import { ShapeCode, ShapePatch, type ShapeFileTarget } from './ShapeCode';
import { RefList, RefPeek, RefsCtx, shapeRefPicture, type RefsState } from './refs';
import { useShapeFollow } from './ShapeFollow';
import { useShapeStack } from './ShapeStack';
import { CodeSpanContext } from '../LocalLinkContext';
import { ShapeInline } from './inline';
import { boxNoteInput, captureBox, pictureRect, placeBox, readBox, useBoxDrag, type KeptBox, type ShapeBoxSelection } from './boxSelect';
import type { ShapeEvent, ShapeHost, ShapeLoaded, ShapePanelTab, ShapeSessionStatus, ShapeShowMeInput, ShapeSurfaceProps, ShapeSurfaceReview } from './types';

const DRAW_MS = 1500;
const DRAWN_MS = DRAW_MS + 1400;
const ERASE_MS = 420;

const PHONE_MAX = 640;

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
  return <svg {...p}><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /></svg>;
};
const GlobeIcon = () => (
  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true" style={{ flex: 'none' }}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
  </svg>
);
const ChatIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" /></svg>;
const PenIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>;
const CrosshairIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 2.5v6.5M12 15v6.5M2.5 12H9M15 12h6.5" /></svg>;
const RefsIcon = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7" cy="7" r="3" /><path d="M13 7h8M13 17h8" /><circle cx="7" cy="17" r="3" /></svg>;

const noteNow = (note: ShapeNote): ShapeNote => (shapeViewNow(note.view) === note.view ? note : { ...note, view: 'know' });

const TABS: readonly { id: ShapeViewId; label: string; short: string }[] = [
  { id: 'picture', label: 'Shape', short: 'Shape' },
  { id: 'how', label: 'How it works', short: 'How' },
  { id: 'code', label: 'Code', short: 'Code' },
];
const shapeTab = <T,>(view: T): T | 'picture' => (view === 'know' || view === 'changed' ? 'picture' : view);
const tabLabel = (view: ShapeViewId) => TABS.find((t) => t.id === shapeTab(view))?.label ?? view;

type Viewer =
  | { kind: 'image'; ref: ShapeRef }
  | { kind: 'file'; path: string; contents: string; line?: number; token: number }
  | { kind: 'diff'; path: string; patch: string }
  | null;

interface Target {
  el: HTMLElement;
  view: ShapeViewId | null;
  id: string | null;
  text: string;
  retry?: { text: string; error: string };
  box?: ShapeBoxSelection;
  boxPart?: Omit<ShapeShowMeInput, 'words'>;
}

function boxShowMePart(scope: ParentNode, sel: ShapeBoxSelection): Omit<ShapeShowMeInput, 'words'> {
  const els = sel.parts.map((part) => scope.querySelector<HTMLElement>(`[data-mark="${CSS.escape(part)}"]`));
  const names = sel.parts.map((part, i) => (els[i] ? partName(els[i]!) : '') || part).slice(0, 40);
  if (names.length === 1) {
    const el = els[0];
    const code = (el?.closest('[data-code]') ?? el?.querySelector('[data-code]'))?.getAttribute('data-code') ?? sel.code[0];
    return { name: names[0]!, ...(code ? { code } : {}), picture: sel.picture };
  }
  return { name: 'A part of the board', ...(names.length > 1 ? { parts: names } : {}), picture: sel.picture };
}

export const SHAPE_CHANGE_NOT_SENT = "Your change wasn't saved. Press Change it to try again.";

export const SHAPE_ASK_NOT_SENT = 'That question did not go through. Try again.';

const key = (view: string, id: string) => `${view}/${id}`;

const shapeCommentDraftKey = (shapeId: string, t: Pick<Target, 'view' | 'id' | 'text'>) =>
  `shape:${shapeId}:${t.view ?? 'board'}:${t.id ?? ''}:${t.text}`;

function marksFor(all: MarkState, view: ShapeViewId): MarkState {
  const pick = (s: ReadonlySet<string>) => new Set([...s].filter((k) => k.startsWith(`${view}/`)).map((k) => k.slice(view.length + 1)));
  return { fresh: pick(all.fresh), erasing: pick(all.erasing), noted: pick(all.noted) };
}

const without = (s: ReadonlySet<string>, drop: readonly string[]) => new Set([...s].filter((x) => !drop.includes(x)));

function partWords(el: HTMLElement): string {
  const bubbles = [...el.querySelectorAll<HTMLElement>('.shp-rb')];
  const was = bubbles.map((b) => b.style.display);
  for (const b of bubbles) b.style.display = 'none';
  try {
    if (el.innerText !== undefined) return el.innerText;
    const labels = [...el.querySelectorAll('text')].map((t) => t.textContent ?? '');
    return labels.length ? labels.join(' ') : el.textContent ?? '';
  } finally {
    bubbles.forEach((b, i) => (b.style.display = was[i]!));
  }
}

export function shapeEndedLabel(host: Pick<ShapeHost, 'askWaitsWhenEnded'>): string {
  return host.askWaitsWhenEnded ? 'Session ended · your question waits for the agent' : 'Session ended · Ask AI answers; changes wait for the agent';
}

function shapeBoxPart(target: { el: HTMLElement; view: string | null; id: string | null; text: string }): { name: string; code?: string } {
  const whole = partWords(target.el).replace(/\s+/g, ' ').trim();
  const words = !!target.text && target.text !== whole;
  const name = (words ? target.text || whole : partName(target.el)) || target.id || 'A part of the board';
  const code = (target.el.closest('[data-code]') ?? target.el.querySelector('[data-code]'))?.getAttribute('data-code') ?? undefined;
  return { name: Array.from(name).slice(0, 600).join(''), ...(code ? { code } : {}) };
}

export function ShapeSurface({ host, id, onClose, onCode, CodeGuide, CodeHoverCard, renderThread, readFirst = false, initialView, initialPanel, onNavigate, headStart, headSide, codeView = true, review = null, boxSelect, darkContrast = false, stackBadges = false, dockRef, pillRef }: ShapeSurfaceProps) {
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

  const views = useMemo(() => TABS.filter((t) => version && (codeView || t.id !== 'code') && shapeViewContent(version.views, t.id)), [version, codeView]);
  const [view, setView] = useState<ShapeViewId>(shapeTab(shapeViewNow(initialView)) ?? 'picture');
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
  const [annotating, setAnnotating] = useState(!readFirst);
  const codeSpan = React.useContext(CodeSpanContext);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const hoverEl = useRef<HTMLElement | null>(null);
  const [more, setMore] = useState(false);
  const moreRef = useRef(more);
  moreRef.current = more;
  const toggleMoreRef = useRef(() => {});
  const [leavingMore, setLeavingMore] = useState<boolean | null>(null);
  const [target, setTarget] = useState<Target | null>(null);

  const [panel, setPanel] = useState<ShapePanelTab | null>(initialPanel ?? null);
  const [lastTab, setLastTab] = useState<ShapePanelTab>('ask');
  const [answerReady, setAnswerReady] = useState(false);
  const [streams, setStreams] = useState<Record<string, { prompt: string; scope: AIChatEntry['question']['scope']; text: string; at: number; done?: boolean; failed?: boolean }>>({});
  const [msgFlash, setMsgFlash] = useState<string | null>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;

  const [refHover, setRefHover] = useState<number | null>(null);
  const [peek, setPeek] = useState<{ n: number; anchor: DOMRect; bounds: DOMRect; obstacles: { rect: DOMRect; number: boolean }[]; pinned: boolean } | null>(null);
  const peekRef = useRef(peek);
  peekRef.current = peek;
  const peekTimer = useRef<number | undefined>(undefined);
  const [refFlash, setRefFlash] = useState<number | null>(null);
  const [viewer, setViewer] = useState<Viewer>(null);
  const [file, setFile] = useState<ShapeFileTarget | null>(null);
  const [codeNotes, setCodeNotes] = useState<CodeAnnotation[]>([]);
  const [copied, setCopied] = useState(false);
  const [howBoard, setHowBoard] = useState<HTMLElement | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  useEffect(() => onNavigate?.({ view, panel }), [view, panel]);

  const openPanel = useCallback((tab: ShapePanelTab) => {
    setPanel(tab);
    setLastTab(tab);
    if (tab === 'ask') setAnswerReady(false);
  }, []);
  const closePanel = useCallback(() => setPanel(null), []);

  const upsertNote = useCallback((saved: ShapeNote) => {
    const note = noteNow(saved);
    setNotes((all) => {
      const at = all.findIndex((n) => n.id === note.id);
      if (at < 0) return [...all, note];
      const next = all.slice();
      next[at] = note;
      return next;
    });
  }, []);

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
      const names = diff.views.map(tabLabel);
      setUpdated(fromSeen
        ? `Since you looked · v${current.n} → v${next.n}${names.length ? ` · ${names.join(', ')}` : ''}`
        : names.length ? `Board updated · ${names.join(', ')}` : `Board updated · v${next.n}`);
      later(() => setMarks((m) => ({ ...m, fresh: without(m.fresh, [...fresh, ...headerFresh]) })), 2600);
      later(() => setUpdated(null), fromSeen ? 6000 : 4200);
    }, reduce || fromSeen ? 0 : ERASE_MS);
  }, [later, reduce]);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setFailed(null);
    host.load(id).then(
      async (data) => {
        if (!live) return;
        setNotes(data.notes.map(noteNow));
        setSession(data.session);
        setAgentDrawing(!!data.shape.drawing && Date.parse(data.shape.drawing.until) > Date.now());
        setLoaded(data);
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
  }, [host, id]);

  useEffect(() => {
    if (!version || !loaded || version.n < loaded.version.n) return;
    if (drawnKey !== `${view}-${drawKey}`) return;
    host.seen(id, version.n);
  }, [drawnKey, version, loaded, host, id, view, drawKey]);

  useEffect(() => {
    if (version && !views.some((v) => v.id === view) && views[0]) setView(views[0].id);
  }, [version, view, views]);

  useEffect(() => {
    const k = `${view}-${drawKey}`;
    const t = window.setTimeout(() => setDrawnKey(k), skip ? 0 : DRAWN_MS);
    return () => clearTimeout(t);
  }, [view, drawKey, skip]);

  const clearHover = useCallback(() => {
    hoverEl.current = null;
    setHoverRect(null);
  }, []);

  const go = useCallback((next: ShapeViewId) => {
    if (next === view) return;
    setTarget(null);
    clearHover();
    setPeek(null);
    setMore(false);
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

  const readProjectFile = useCallback(
    async (path: string) => (isShapeProjectPath(path) ? (await host.readFile?.(id, path)) ?? null : null),
    [host, id],
  );

  const boardReview = useMemo<ShapeSurfaceReview | null>(
    () =>
      review && {
        ...review,
        open: async (at) => {
          const ok = await Promise.resolve().then(() => review.open(at)).then((r) => r === true, () => false);
          if (ok) setPeek(null);
          return ok;
        },
      },
    [review],
  );

  const openCodeTarget = useCallback(async (at: ShapeCodeTarget, el?: HTMLElement) => {
    const v = versionRef.current;
    if (el && onCode?.(at, el, v)) return;
    const declined = !!el && !!onCode;
    if (codeView && v?.views.code && host.readFile && (v.views.code.files ?? []).some((f) => f.path === at.path)) {
      openCode(at.path, at.line);
      return;
    }
    if (!declined && boardReview && (await boardReview.open({ path: at.path, line: at.line }))) return;
    const contents = await readProjectFile(at.path);
    if (contents != null) setViewer({ kind: 'file', path: at.path, contents, line: at.line, token: Date.now() });
  }, [readProjectFile, host, openCode, codeView, boardReview, onCode]);
  const showCode = useCallback((path: string, line: number) => {
    if (codeView) openCode(path, line);
    else void openCodeTarget({ path, line });
  }, [codeView, openCode, openCodeTarget]);

  const stack = useShapeStack({ enabled: stackBadges, version, phone, root: rootEl, review: boardReview, readFile: host.readFile ? readProjectFile : undefined });
  const stackOpen = useRef(false);
  stackOpen.current = stack.open;

  const stopFollowRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || target || viewer || boxDragging.current || stackOpen.current) return;
      if (rootRef.current?.closest('[inert]')) return;
      if (document.querySelector('[role="menu"]')) return;
      if (peekRef.current) {
        e.preventDefault();
        setPeek(null);
        return;
      }
      if (panelRef.current) {
        e.preventDefault();
        setPanel(null);
        return;
      }
      if (moreRef.current) {
        e.preventDefault();
        toggleMoreRef.current();
        return;
      }
      if (stopFollowRef.current) {
        e.preventDefault();
        stopFollowRef.current();
        return;
      }
      if (Date.now() > drawingUntil.current) return;
      e.preventDefault();
      setSkip(true);
      setLeaving(null);
      drawingUntil.current = 0;
    };
    window.addEventListener('keydown', on, true);
    return () => window.removeEventListener('keydown', on, true);
  }, [target, viewer]);

  const shapeState = loaded?.shape.state ?? 'active';
  const finished = shapeState === 'finished';

  const sendChange = useCallback(async (input: Omit<ShapeNoteInput, 'kind' | 'v'>): Promise<boolean> => {
    const v = versionRef.current;
    if (!v || finished) return true;
    if (input.part && input.view && !input.box) {
      const k = key(input.view, input.part);
      setMarks((m) => ({ ...m, noted: new Set([...m.noted, k]) }));
    }
    try {
      const note = await host.note(id, { ...input, kind: 'change', v: v.n });
      upsertNote(note);
      if (session.state !== 'gone') setInFlight((f) => [...f, note.id]);
      return true;
    } catch {
      setMarks((m) => ({ ...m, noted: new Set() }));
      return false;
    }
  }, [host, id, finished, session.state, upsertNote]);

  const sendAsk = useCallback(async (input: Omit<ShapeNoteInput, 'kind' | 'v'>, scope: AIChatEntry['question']['scope']) => {
    const v = versionRef.current;
    if (!v || finished) return;
    openPanel('ask');
    const temp = `pending-${Date.now()}`;
    setStreams((s) => ({ ...s, [temp]: { prompt: input.text, scope, text: '', at: Date.now() } }));
    let failed = false;
    try {
      const result = await host.ask(id, { ...input, kind: 'ask', v: v.n }, (text) => setStreams((s) => (s[temp] ? { ...s, [temp]: { ...s[temp]!, text } } : s)));
      upsertNote(result.question);
      if (result.answer) upsertNote(result.answer);
    } catch {
      failed = true;
      setStreams((s) => (s[temp] ? { ...s, [temp]: { ...s[temp]!, text: '', failed: true } } : s));
    } finally {
      if (!failed) {
        setStreams((s) => {
          const { [temp]: _gone, ...rest } = s;
          return rest;
        });
      }
      if (panelRef.current !== 'ask') setAnswerReady(true);
    }
  }, [host, id, finished, openPanel, upsertNote]);

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
      if (shapeUrlAllowed(r.target)) setViewer({ kind: 'image', ref: { ...r, images: r.images?.filter((im) => shapeUrlAllowed(im.src)) } });
    } else if ((r.kind === 'pr' || r.kind === 'link') && shapeRefPicture(r)) {
      const images = r.images!.filter((im) => shapeUrlAllowed(im.src));
      setViewer({ kind: 'image', ref: { ...r, target: images[0]!.src, images } });
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

  const fileAction = useCallback((file: { path: string; line?: number }) => host.fileAction?.(id, file) ?? null, [host, id]);
  const refFileAction = useCallback(
    (r: ShapeRef) => (r.kind === 'file' || r.kind === 'diff' ? fileAction({ path: r.target, line: r.line }) : null),
    [fileAction],
  );

  const canOpen = useCallback((r: ShapeRef) => {
    if (r.kind === 'message') return !!renderThread;
    if (r.kind === 'file') return !!host.readFile;
    if (r.kind === 'diff') return !!version?.views.code?.patch;
    return true;
  }, [renderThread, host, version]);

  const homeOf = useCallback((n: number): ShapeViewId | 'header' | null => {
    const v = versionRef.current;
    if (!v) return null;
    const cite = new RegExp(`\\[\\^${n}\\]`);
    const tag = new RegExp(`data-ref\\s*=\\s*["']?${n}\\b`);
    if (cite.test(v.claim)) return 'header';
    if (view !== 'code' && JSON.stringify(shapeViewContent(v.views, view) ?? null).match(tag)) return view;
    if (tag.test(v.views.picture?.html ?? '') || tag.test(v.views.picture?.tall?.html ?? '')) return 'picture';
    if (tag.test(v.views.how?.html ?? '') || tag.test(v.views.how?.tall?.html ?? '')) return 'how';
    return null;
  }, [view]);

  const flashRef = useCallback((n: number) => {
    if (phone) setPanel(null);
    const home = homeOf(n);
    const needView = home && home !== 'header' && home !== view ? home : null;
    if (needView) go(needView);
    later(() => {
      if (home === 'header') rootRef.current?.querySelector(`.shp-surface [data-ref="${n}"]`)?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
      setRefFlash(n);
      later(() => setRefFlash((f) => (f === n ? null : f)), 1700);
    }, needView ? (reduce ? 200 : 1100) : phone ? 280 : 0);
  }, [phone, homeOf, view, go, later, reduce]);

  const closePeek = useCallback(() => {
    window.clearTimeout(peekTimer.current);
    setPeek(null);
    setRefHover(null);
  }, []);
  const holdPeek = useCallback(() => window.clearTimeout(peekTimer.current), []);
  const leavePeek = useCallback(() => {
    window.clearTimeout(peekTimer.current);
    if (peekRef.current?.pinned) return;
    peekTimer.current = window.setTimeout(() => setPeek(null), 180);
  }, []);
  const onRefPeek = useCallback((n: number | null, el: HTMLElement, how: 'hover' | 'focus' | 'tap') => {
    window.clearTimeout(peekTimer.current);
    if (n === null) return leavePeek();
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const show = () => {
      const whole = bounds.width * bounds.height;
      const obstacles = [...(el.getRootNode() as ParentNode).querySelectorAll('[data-ref],[data-mark]')]
        .filter((o) => o !== el && !o.contains(el))
        .map((o) => ({ rect: o.getBoundingClientRect(), number: o.hasAttribute('data-ref') }))
        .filter((o) => o.rect.width * o.rect.height < whole * 0.25);
      setPeek({ n, anchor: el.getBoundingClientRect(), bounds, obstacles, pinned: how === 'tap' });
    };
    if (how === 'tap') {
      if (peekRef.current?.n === n && peekRef.current.pinned) {
        closePeek();
        void openRef(n);
        return;
      }
      setRefHover(n);
      show();
    } else if (peekRef.current || how === 'focus') show();
    else peekTimer.current = window.setTimeout(show, 90);
  }, [closePeek, leavePeek, openRef]);
  useEffect(() => {
    if (!peek?.pinned) return;
    const away = (e: PointerEvent) => {
      const onIt = e.composedPath().some((t) => t instanceof Element && (t.classList.contains('shp-peek') || t.classList.contains('shp-rb')));
      if (!onIt) closePeek();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [peek?.pinned, closePeek]);

  const refsState = useMemo<RefsState>(() => ({ refs, hover: refHover, flash: refFlash, onHover: setRefHover, onOpen: openRef, onPeek: readFirst ? onRefPeek : undefined }), [refs, refHover, refFlash, openRef, onRefPeek, readFirst]);

  const showMeAction = (part: { name: string; code?: string }): CommentExtraAction | undefined =>
    host.showMe && !finished
      ? { label: 'Show me', icon: <Pebble alive={false} size={13} />, onAction: (words) => host.showMe!(id, { ...part, words }) }
      : undefined;

  const pickMark = useCallback((el: HTMLElement, v: ShapeViewId, text?: string) => {
    setTarget({ el, view: v, id: el.getAttribute('data-mark'), text: (text ?? partWords(el)).replace(/\s+/g, ' ').trim() });
    clearHover();
  }, [clearHover]);
  const hoverMark = useCallback((el: HTMLElement | null) => {
    const next = annotating && !target && inputMethod === 'pinpoint' && !boxSelect ? el : null;
    if (hoverEl.current === next) return;
    hoverEl.current = next;
    setHoverRect(next ? next.getBoundingClientRect() : null);
  }, [annotating, target, inputMethod, boxSelect]);

  const onShapeClickCapture = (e: React.MouseEvent) => {
    if (!panel) return;
    const t = (e.nativeEvent.composedPath()[0] ?? e.target) as Element;
    if (t instanceof Element && t.closest('.shp-dock, .shp-rb, .shp-pill, .shp-general, .shp-ex-card')) return;
    if (boxSelect && (!(e.target instanceof Node) || !e.currentTarget.contains(e.target))) return;
    e.stopPropagation();
    e.preventDefault();
    setPanel(null);
  };

  const quoteLabel = (t: Target) => {
    const where = t.view ? tabLabel(t.view) : 'Board';
    if (!boxSelect) return `${where} · “${t.text.length > 48 ? `${t.text.slice(0, 46)}…` : t.text}”`;
    if (t.box && t.box.parts.length > 1) return `${where} · ${t.box.parts.length} parts`;
    if (!t.text) return where;
    return `${where} · “${t.text.length > 40 ? `${t.text.slice(0, 38).trimEnd()}…` : t.text}”`;
  };

  const [general, setGeneral] = useState<{ el: HTMLElement; view: ShapeViewId | null; retry?: Target['retry'] } | null>(null);
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

  const boxScope = (): HTMLElement | null =>
    stageRef.current?.querySelector('.shp-view:not(.leaving) .shp-drawn-host')?.shadowRoot?.querySelector<HTMLElement>('.board') ?? null;
  const boxDragging = useBoxDrag({
    stageRef,
    enabled: !!boxSelect && annotating && inputMethod === 'pinpoint' && view !== 'code' && !target && !general && !finished,
    onStart: () => {
      closePeek();
      clearHover();
    },
    onEnd: (rect) => {
      const scope = boxScope();
      const v = versionRef.current;
      const read = scope && readBox(scope, rect);
      if (!scope || !v || !read || !read.box.w || !read.box.h) return;
      const tall = !!(scope.getRootNode() as ShadowRoot).host?.closest('.shp-drawn.tall');
      const box = { ...read.box, ...(tall ? { tall: true as const } : {}), ...(more && view === 'picture' ? { more: true as const } : {}) };
      const k = scope.offsetWidth ? scope.getBoundingClientRect().width / scope.offsetWidth : 1;
      const selection: ShapeBoxSelection = { view, v: v.n, parts: read.parts, words: read.words, code: read.code, box, picture: captureBox(scope, pictureRect(scope, rect, read.parts), boxSelect?.readAsset, rect) };
      setTarget({
        el: placeBox(scope, box, k),
        view,
        id: read.parts.join(',') || null,
        text: read.words,
        box: selection,
        boxPart: boxShowMePart(scope, selection),
      });
    },
  });
  const boxSent = useRef(new Set<HTMLElement>());
  useEffect(() => {
    const el = target?.box ? target.el : null;
    return () => {
      if (el && !boxSent.current.has(el)) el.remove();
    };
  }, [target]);
  const sentBox = (el: HTMLElement) => boxSent.current.add(el);
  const boxSettled = (el: HTMLElement) => {
    boxSent.current.delete(el);
    requestAnimationFrame(() => el.remove());
  };

  const keptBoxes = useMemo(() => {
    if (!boxSelect) return [];
    const answered = new Set(notes.filter((n) => n.kind === 'answer' && n.re).map((n) => n.re!));
    return notes.filter((n) => n.box && n.from === 'you' && n.v === version?.n && !answered.has(n.id));
  }, [notes, version?.n, boxSelect]);
  const boxesOn = useMemo(() => {
    const of = (v: ShapeViewId, onMore: boolean): KeptBox[] =>
      keptBoxes.filter((n) => n.view === v && !!n.box!.more === onMore).map((n) => ({ id: n.id, box: n.box!, text: n.text }));
    const main = { picture: of('picture', false), how: of('how', false), know: [] as KeptBox[], changed: [] as KeptBox[], code: [] as KeptBox[] };
    const onMore = of('picture', true);
    return (v: ShapeViewId, showMore: boolean) => (showMore ? onMore : main[v]);
  }, [keptBoxes]);

  const agent = session.agent;
  const entries = useMemo<AIChatEntry[]>(() => {
    const answers = new Map(notes.filter((n) => n.kind === 'answer' && n.re).map((n) => [n.re!, n]));
    const out: AIChatEntry[] = notes
      .filter((n) => n.from === 'you' && (n.kind === 'change' || n.kind === 'ask'))
      .map((q) => {
        const a = answers.get(q.id);
        const where = q.view ? tabLabel(q.view) : 'The whole board';
        const scope: AIChatEntry['question']['scope'] = !boxSelect
          ? (q.part
            ? { kind: 'selection', label: `${where} · “${(q.quote ?? '').slice(0, 46)}”`, text: q.quote ?? undefined }
            : { kind: 'general', label: q.view ? `${where} · general` : where })
          : q.part || q.box
          ? { kind: 'selection', label: q.quote ? `${where} · “${q.quote.slice(0, 46)}”` : where, text: q.quote ?? undefined }
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
        response: { questionId: tid, text: s.text, isStreaming: !s.failed, createdAt: s.at, ...(s.failed ? { error: SHAPE_ASK_NOT_SENT } : {}) },
      });
    }
    return out;
  }, [notes, streams, session.state, agent, boxSelect]);
  const streaming = Object.values(streams).some((s) => !s.failed);

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
    panel: !!panel,
    annotating: readFirst && annotating,
  });
  stopFollowRef.current = follow.stop;

  const copyPrompt = async () => {
    const text = host.resumePrompt?.(id);
    if (!text) return;
    await host.copy?.(text);
    setCopied(true);
    later(() => setCopied(false), 1800);
  };

  if (failed) return <div className="shp-surface shp-failed" role="alert">This board could not be opened: {failed}</div>;
  if (!loaded || !version) return <div className="shp-surface shp-loading" aria-busy="true"><Pebble alive reshaping size={28} /></div>;

  const renderView = (v: ShapeViewId, phase: 'entering' | 'drawn' | 'leaving', showMore = more) => {
    const vm = marksFor(marks, v);
    if (v === 'picture' || v === 'how') {
      const main = version.views[v];
      if (!main) return null;
      const drawn = v === 'picture' && showMore && main.more ? { ...main.more, css: main.more.css ?? main.css } : main;
      return (
        <ShapeDrawn
          drawn={drawn}
          phase={phase}
          skip={skip}
          reduce={reduce}
          pinpoint={annotating && inputMethod === 'pinpoint' && phase !== 'leaving' && !target}
          boxable={boxing && phase !== 'leaving'}
          boxes={phase === 'leaving' || !boxSelect ? undefined : boxesOn(v, v === 'picture' && showMore)}
          select={annotating && inputMethod === 'drag'}
          marks={vm}
          refs={refs}
          refHover={refHover}
          refFlash={refFlash}
          onRefHover={setRefHover}
          onRefOpen={(n) => void openRef(n)}
          onRefPeek={readFirst ? onRefPeek : undefined}
          pan={readFirst}
          top={readFirst}
          resolveSrc={assetUrl}
          darkContrast={darkContrast}
          onHoverMark={phase === 'leaving' ? () => {} : hoverMark}
          onPickMark={(el, text) => pickMark(el, v, text)}
          onCode={phase === 'leaving' ? undefined : openCodeTarget}
          onBoard={phase === 'leaving' ? undefined : v === 'how' ? (stackBadges ? (b) => { setHowBoard(b); stack.boardFor('how')(b); } : setHowBoard) : stackBadges ? stack.boardFor('picture') : undefined}
          scenes={version.scenes}
          sceneLook="technical"
        />
      );
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
        lineAction={(lines) => showMeAction({ name: `${lines.filePath.split('/').pop()} ${lines.lineStart === lines.lineEnd ? `line ${lines.lineStart}` : `lines ${lines.lineStart}–${lines.lineEnd}`}`, code: `${lines.filePath}#L${lines.lineStart}${lines.lineEnd !== lines.lineStart ? `-L${lines.lineEnd}` : ''}` })}
        generalComment={phase === 'leaving' ? null : generalButton('code')}
        phone={phone}
        fileAction={host.fileAction ? fileAction : undefined}
      />
    );
  };

  const fresh = (id2: string) => (marks.fresh.has(key('header', id2)) ? ' shp-fresh-text' : '');
  const pinpointing = annotating && inputMethod === 'pinpoint' && view !== 'code';
  const boxing = !!boxSelect && pinpointing && !finished && !target && !general;
  const canMore = view === 'picture' && !!version.views.picture?.more;
  const toggleMore = () => {
    setPeek(null);
    clearHover();
    setTarget(null);
    setLeavingMore(more);
    setMore(!more);
    setSkip(false);
    setDrawKey((k) => k + 1);
    later(() => setLeavingMore(null), reduce ? 160 : ERASE_MS + 40);
  };
  toggleMoreRef.current = toggleMore;
  const peekRefData = peek ? refs.find((r) => r.n === peek.n) : undefined;
  const chatOn = panel === 'ask' || panel === 'thread';

  return (
    <RefsCtx.Provider value={refsState}>
    <CodeSpanContext.Provider value={annotating ? null : codeSpan}>
      <div ref={attachRoot} className={`shp-root${phone ? ' phone' : ''}${panel ? ' panel-open' : ''}${follow.sheet ? ' follow-sheet' : ''}`}>
        <RefHoverCards rootRef={rootRef} />

        <section className="shp-surface" aria-label="Shape" onClickCapture={onShapeClickCapture}>
          <header className="shp-head">
            <div className="shp-title-row">
              {headStart && <div className="shp-head-start">{headStart}</div>}
              <h1 className={fresh('title').trim()}>{version.title}</h1>
              <div className="shp-head-side">
                {agentDrawing && (
                  <span className="shp-drawing" role="status" title={`${agent} is drawing v${version.n + 1}…`}>
                    <Pebble alive reshaping size={16} />
                    <span className={phone ? 'shp-sr' : undefined}>{`${agent} is drawing v${version.n + 1}…`}</span>
                  </span>
                )}
                {finished && <span className="shp-finished">Finished</span>}
                {headSide}
                {!phone && generalButton(null)}
                {host.refresh && !finished && (
                  <button type="button" className="shp-quiet-btn" onClick={() => void bringUpToDate()} disabled={busy}>{host.refreshLabel ?? 'Bring it up to date'}</button>
                )}
                {onClose && (
                  <button type="button" className="shp-icon-btn shp-close" onClick={onClose} aria-label="Close Shape" title="Close Shape">×</button>
                )}
              </div>
            </div>
            <p className={`shp-claim${fresh('claim')}`}><ShapeInline text={version.claim} /></p>
            {stack.row}
          </header>

          <div
            ref={stageRef}
            className={`shp-stage${skip ? ' skip' : ''}${reduce ? ' reduce' : ''}${pinpointing ? ' pinpointing' : ''}${boxing ? ' boxing' : ''}`}
            onPointerLeave={clearHover}
            onScrollCapture={() => {
              clearHover();
              if (peekRef.current) closePeek();
            }}
          >
            {leaving && leaving !== view && !!shapeViewContent(version.views, leaving) && (
              <div className={`shp-view v-${leaving} leaving`} aria-hidden="true">{renderView(leaving, 'leaving')}</div>
            )}
            {leavingMore !== null && view === 'picture' && (
              <div className="shp-view v-picture leaving" aria-hidden="true">{renderView('picture', 'leaving', leavingMore)}</div>
            )}
            <div key={`${view}-${drawKey}`} className={`shp-view v-${view}${drawnKey === `${view}-${drawKey}` ? ' drawn' : ' entering'}`}>
              {renderView(view, drawnKey === `${view}-${drawKey}` ? 'drawn' : 'entering')}
            </div>
          </div>

          {updated ? (
            <div ref={pillRef} className="shp-pill" role="status"><Pebble alive reshaping={busy} size={16} />{updated}</div>
          ) : waiting > 0 && session.state === 'gone' ? (
            <div ref={pillRef} className="shp-pill waits" role="status">
              <Pebble alive={false} size={16} />
              {waiting === 1 ? '1 change waits for the agent' : `${waiting} changes wait for the agent`}
              {host.resumePrompt && (
                <button type="button" onClick={() => void copyPrompt()}>{copied ? 'Copied' : 'Copy prompt'}</button>
              )}
            </div>
          ) : null}

          {canMore && (
            <button type="button" className="shp-more" onClick={toggleMore} aria-pressed={more}>
              {more ? 'Back to the main board' : 'Show more'}
            </button>
          )}

          <div ref={dockRef} className="shp-dock" role="toolbar" aria-label="Shape toolbar">
            {views.length > 0 && <div className="shp-tgroup" role="group" aria-label="Views">
              {views.map((v) => (
                <button key={v.id} type="button" className={`shp-tbtn${view === v.id ? ' on' : ''}`} onClick={() => go(v.id)} aria-pressed={view === v.id} title={v.label}>
                  <ViewIcon id={v.id} />
                  {(!phone || view === v.id) && <span className="tl">{phone ? v.short : v.label}</span>}
                  {behind[v.id]?.length ? <span className="shp-tdot" aria-label="changed" /> : null}
                </button>
              ))}
            </div>}
            {follow.button && (
              <div className="shp-tgroup" role="group" aria-label="Examples">
                {follow.button}
              </div>
            )}
            {view !== 'code' && !readFirst && !phone && (
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
            {view !== 'code' && readFirst && boxSelect && (
              <div className="shp-tstrip">
                <button
                  type="button"
                  className={`shp-tbtn shp-cross-btn${annotating ? ' on' : ''}`}
                  aria-pressed={annotating}
                  aria-label="Comment"
                  title={annotating ? 'Stop commenting' : 'Comment: click a part, or drag across what you mean'}
                  disabled={finished}
                  onClick={() => {
                    setAnnotating(!annotating);
                    setInputMethod('pinpoint');
                    setTarget(null);
                    clearHover();
                  }}
                >
                  <CrosshairIcon />
                </button>
              </div>
            )}
            {view !== 'code' && readFirst && !boxSelect && (
              <div className="shp-tstrip">
                <button
                  type="button"
                  className={`shp-tbtn${annotating ? ' on' : ''}`}
                  aria-pressed={annotating}
                  title={annotating ? 'Stop annotating' : 'Annotate: point at a part to change it or ask about it'}
                  disabled={finished}
                  onClick={() => {
                    setAnnotating(!annotating);
                    setTarget(null);
                    clearHover();
                  }}
                >
                  <PenIcon />
                  {!phone && <span className="tl">Annotate</span>}
                </button>
                {annotating && !phone && (
                  <AnnotationToolstrip
                    inputMethod={inputMethod}
                    onInputMethodChange={setInputMethod}
                    mode="selection"
                    onModeChange={() => {}}
                    compact
                    iconOnly
                    showHelpLink={false}
                    hideActionModes
                  />
                )}
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
              contextText={boxSelect ? target.text : quoteLabel(target)}
              headerText={boxSelect ? quoteLabel(target) : undefined}
              placement={target.box ? 'side' : undefined}
              extraActions={target.box ? [
                ...(boxSelect?.onAddToReply ? [{
                  label: 'Add to reply',
                  spends: true,
                  onSelect: (text: string) => {
                    boxSelect.onAddToReply!({ ...target.box!, label: quoteLabel(target) }, text);
                    setTarget(null);
                  },
                }] : []),
              ] : undefined}
              isGlobal={false}
              allowImages={false}
              draftKey={shapeCommentDraftKey(id, target)}
              submitLabel="Change it"
              askAILabel="Ask"
              extraAction={showMeAction(target.boxPart ?? shapeBoxPart(target))}
              allowCard={false}
              initialText={target.retry?.text}
              errorText={target.retry?.error}
              onSubmit={(text) => {
                const sent = target;
                if (sent.box) sentBox(sent.el);
                const sending = sent.box ? boxNoteInput(sent.box, text).then(sendChange) : sendChange({ view: sent.view, part: sent.id, quote: sent.text, text });
                void sending.then((ok) => {
                  if (sent.box && ok) boxSettled(sent.el);
                  if (!ok) setTarget((open) => open ?? { ...sent, retry: { text, error: SHAPE_CHANGE_NOT_SENT } });
                });
                setTarget(null);
              }}
              onAskAI={(question) => {
                const asked = target;
                const scope: AIChatEntry['question']['scope'] = { kind: 'selection', label: quoteLabel(asked), text: asked.text };
                if (asked.box) {
                  sentBox(asked.el);
                  void boxNoteInput(asked.box, question).then((input) => sendAsk(input, scope)).finally(() => boxSettled(asked.el));
                } else void sendAsk({ view: asked.view, part: asked.id, quote: asked.text, text: question }, scope);
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
              headerText={general.view ? `${tabLabel(general.view)} · the whole guide` : 'The whole board'}
              allowImages={false}
              draftKey={shapeCommentDraftKey(id, { view: general.view, id: null, text: '' })}
              submitLabel="Change it"
              askAILabel="Ask"
              extraAction={showMeAction({ name: 'The whole board' })}
              allowCard={false}
              initialText={general.retry?.text}
              errorText={general.retry?.error}
              onSubmit={(text) => {
                const sent = general;
                void sendChange({ view: sent.view, part: null, quote: null, text }).then((ok) => {
                  if (!ok) setGeneral((open) => open ?? { ...sent, retry: { text, error: SHAPE_CHANGE_NOT_SENT } });
                });
                setGeneral(null);
              }}
              onAskAI={(question) => {
                const label = general.view ? `${tabLabel(general.view)} · general` : 'The whole board';
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
            const a = (e.target as Element).closest('a');
            const m = a?.getAttribute('href')?.match(/^code:([^#]+)#L(\d+)/);
            if (m) {
              e.preventDefault();
              showCode(m[1]!, Number(m[2]));
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
                hideProviderBar={host.sessionless}
              />
            )}
            {panel === 'thread' && renderThread && <div className="shp-thread-in">{renderThread({ flash: msgFlash })}</div>}
            {panel === 'refs' && <RefList onShow={flashRef} canOpen={canOpen} fileAction={refFileAction} />}
          </div>
        </aside>

        {peek && peekRefData && (
          <RefPeek
            key={peek.n}
            reference={peekRefData}
            anchor={peek.anchor}
            bounds={peek.bounds}
            obstacles={peek.obstacles}
            canOpen={canOpen(peekRefData)}
            resolveSrc={assetUrl}
            readFile={host.readFile ? readProjectFile : undefined}
            onOpen={() => {
              closePeek();
              void openRef(peekRefData.n);
            }}
            onOpenLink={() => {
              const url = shapeLinkUrl(peekRefData.target);
              closePeek();
              if (url) window.open(url, '_blank', 'noreferrer');
            }}
            onEnter={holdPeek}
            onLeave={leavePeek}
            fileAction={refFileAction(peekRefData)}
          />
        )}

        {viewer?.kind === 'image' && (
          <ImageLightbox
            src={assetUrl(viewer.ref.target)}
            alt={viewer.ref.title}
            images={viewer.ref.images?.map((i) => ({ src: assetUrl(i.src), alt: i.alt }))}
            swipe={phone}
            onClose={() => setViewer(null)}
          />
        )}
        {stack.overlay}
        {viewer?.kind === 'file' && (
          <CodeFilePopout open onClose={() => setViewer(null)} filepath={viewer.path} contents={viewer.contents} line={viewer.line} revealKey={viewer.token} headerAction={fileAction({ path: viewer.path, line: viewer.line })} />
        )}
        {viewer?.kind === 'diff' && (
          <PopoutDialog open onClose={() => setViewer(null)} title={viewer.path}>
            <div className="shp-diff-pop">
              {host.fileAction && <div className="shp-diff-pop-acts">{fileAction({ path: viewer.path })}</div>}
              <ShapePatch patch={viewer.patch} />
            </div>
          </PopoutDialog>
        )}
      </div>
    </CodeSpanContext.Provider>
    </RefsCtx.Provider>
  );
}

