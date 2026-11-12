import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { imageRegionFileName, imageRegionLocationLines, parseImageRegion, type ImageRegion } from '@plannotator/core/image-region';
import { AnnotationType, type Annotation, type ImageAttachment } from '../types';
import type { MentionSource } from '../utils/mentions';
import { getIdentity } from '../utils/identity';
import { THUMBS_UP_LABEL } from '../utils/quickLabels';
import { hashDraftScope } from '../utils/draftScopeHash';
import { AnnotationPanel } from './AnnotationPanel';
import { CommentPopover, type CommentAskAIHandler } from './CommentPopover';
import { ImagePeek, type ImagePeekHandle, type ImagePeekRow } from './ImagePeek';
import { RegionBoxLayer, RegionToolStrip, regionOf, type RegionBoxItem } from './ImageRegions';
import { ImageZoomStage, type ImageZoomStageHandle, type WheelHintGate, type ZoomDraw, type ZoomMode } from './ImageZoomStage';
import { canPanToward, type NaturalBox, type ZoomSize, type ZoomViewport } from './imageZoom';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSwipeStep } from '../hooks/useSwipeStep';

export interface LightboxImage {
  src: string;
  alt: string;
  name?: string;
  section?: string | null;
  writtenSrc?: string;
  line?: number | null;
  blockId?: string;
}

export interface LightboxRegionComments {
  annotations: readonly Annotation[];
  canCreate: boolean;
  onAdd: (annotation: Annotation) => void;
  onDelete?: (id: string) => void;
  onEdit?: (id: string, updates: Partial<Annotation>) => void;
  focusId?: string | null;
  onAskAI?: CommentAskAIHandler;
  mentionSource?: MentionSource;
}

function imageRegionDraftScope(writtenSrc: string): string {
  return writtenSrc.startsWith('data:') ? `data:${hashDraftScope(writtenSrc)}` : writtenSrc;
}

function regionHeader(n: number, box: NaturalBox): string {
  return `Region ${n} · ${box.w} × ${box.h} px`;
}

function newRegionAnnotationId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

export function lightboxImageName(image: Pick<LightboxImage, 'src' | 'alt' | 'name'>): string {
  if (image.name) return image.name;
  try {
    const base = typeof window !== 'undefined' && /^https?:/.test(window.location.href) ? window.location.href : 'http://localhost/';
    const url = new URL(image.src, base);
    const named = url.searchParams.get('path') ?? (url.protocol === 'data:' || url.protocol === 'blob:' ? '' : url.pathname);
    const last = named.split(/[\\/]/).filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
  }
  return image.alt || 'Image';
}

export function collectDocumentImages(container: ParentNode | null): LightboxImage[] {
  if (!container) return [];
  const out: LightboxImage[] = [];
  let section: string | null = null;
  for (const el of container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, img')) {
    if (el.tagName !== 'IMG') {
      section = (el.textContent ?? '').trim() || section;
      continue;
    }
    const img = el as HTMLImageElement;
    if (!img.classList.contains('cursor-zoom-in') && !img.hasAttribute('data-zoomable')) continue;
    const src = img.getAttribute('src');
    if (!src || out.some((i) => i.src === src)) continue;
    const image: LightboxImage = { src, alt: img.getAttribute('alt') ?? '', section };
    const written = img.getAttribute('data-image-src');
    const blockId = img.closest<HTMLElement>('[data-block-id]')?.dataset.blockId;
    if (written && blockId) {
      image.writtenSrc = written;
      image.blockId = blockId;
    }
    out.push(image);
  }
  return out;
}

const ICON = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const ImageLightbox: React.FC<{
  src: string;
  alt: string;
  onClose: () => void;
  images?: readonly LightboxImage[];
  regions?: LightboxRegionComments;
  swipe?: boolean;
  at?: number;
}> = ({ src, alt, onClose, images, regions, swipe, at }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const list = images && images.length > 0 && (images.length > 1 || images[0]!.src === src) ? images : undefined;
  const stepping = !!list && list.length > 1;
  const [index, setIndex] = useState(() => {
    if (!list) return 0;
    const focus = regions?.focusId ? regions.annotations.find((a) => a.id === regions.focusId) : undefined;
    const focusSrc = focus ? regionOf(focus)?.src : undefined;
    const byFocus = focusSrc ? list.findIndex((i) => i.writtenSrc === focusSrc) : -1;
    const named = at !== undefined && list[at]?.src === src ? at : -1;
    return Math.max(0, byFocus >= 0 ? byFocus : named >= 0 ? named : list.findIndex((i) => i.src === src));
  });
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit');
  const [scale, setScale] = useState<number | null>(null);
  const [peekOpen, setPeekOpen] = useState(false);
  const [endNote, setEndNote] = useState<string | null>(null);
  const [announced, setAnnounced] = useState('');
  const peekRef = useRef<ImagePeekHandle>(null);
  const stageRef = useRef<ImageZoomStageHandle>(null);
  const wheelHint = useRef<WheelHintGate>({ shown: false }).current;
  const refocusStage = useRef(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current: LightboxImage = list ? list[index]! : { src, alt, section: null };
  const name = lightboxImageName(current);

  const phone = useIsMobile();
  const regionsOn = !!regions && !!current.writtenSrc && !!current.blockId;
  const framed = stepping || regionsOn;
  const canDraw = regionsOn && regions!.canCreate;
  const [tool, setTool] = useState<'move' | 'region'>('move');
  const [draft, setDraft] = useState<NaturalBox | null>(null);
  const [pending, setPending] = useState<NaturalBox | null>(null);
  const [pendingEl, setPendingEl] = useState<HTMLDivElement | null>(null);
  const hasPending = pending !== null;
  const regionDraftScope = useMemo(
    () => (hasPending && current.writtenSrc ? imageRegionDraftScope(current.writtenSrc) : null),
    [hasPending, current.writtenSrc],
  );
  const [drawerOpen, setDrawerOpen] = useState(() => !!regions?.focusId);
  const [scope, setScope] = useState<'image' | 'all'>('image');
  const [selectedId, setSelectedId] = useState<string | null>(() => regions?.focusId ?? null);
  const [view, setView] = useState<{ view: ZoomViewport; stage: ZoomSize; eased: boolean } | null>(null);
  const [dims, setDims] = useState<ZoomSize | null>(null);
  const zoomOnLoad = useRef<string | null>(regions?.focusId ?? null);
  const countRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const drawerId = useId();

  const allRegions = useMemo(() => {
    const out: Array<{ ann: Annotation; region: ImageRegion }> = [];
    for (const ann of regions?.annotations ?? []) {
      const region = regionOf(ann);
      if (region) out.push({ ann, region });
    }
    return out.sort((a, b) => a.ann.createdA - b.ann.createdA);
  }, [regions?.annotations]);
  const here = useMemo(
    () => (regionsOn ? allRegions.filter((r) => r.region.src === current.writtenSrc) : []),
    [allRegions, current.writtenSrc, regionsOn],
  );
  const boxes = useMemo<RegionBoxItem[]>(() => here.map((r, i) => ({ id: r.ann.id, n: i + 1, box: r.region.box, text: r.ann.text })), [here]);
  const writtenToLoaded = useMemo(() => {
    const map = new Map<string, string>();
    for (const image of list ?? [current]) if (image.writtenSrc && !map.has(image.writtenSrc)) map.set(image.writtenSrc, image.src);
    return map;
  }, [list, current]);
  const drawerAnnotations = useMemo(
    () => (scope === 'image' ? here : allRegions.filter((r) => writtenToLoaded.has(r.region.src))).map((r) => r.ann),
    [allRegions, here, scope, writtenToLoaded],
  );
  const thumbFor = useMemo(() => (written: string) => writtenToLoaded.get(written) ?? null, [writtenToLoaded]);

  const zoomToComment = (id: string, animate = true) => {
    const hit = here.find((r) => r.ann.id === id);
    if (hit) stageRef.current?.zoomTo(hit.region.box, animate);
  };

  useEffect(() => {
    if (!dims || !zoomOnLoad.current) return;
    const id = zoomOnLoad.current;
    if (!here.some((r) => r.ann.id === id)) return;
    zoomOnLoad.current = null;
    zoomToComment(id, false);
  }, [dims, here]);

  const lastFocus = useRef(regions?.focusId ?? null);
  useEffect(() => {
    const focus = regions?.focusId ?? null;
    if (focus === lastFocus.current) return;
    lastFocus.current = focus;
    if (focus) pickComment(focus);
  }, [regions?.focusId]);

  const pickComment = (id: string) => {
    const hit = allRegions.find((r) => r.ann.id === id);
    if (!hit || waitingComment()) return;
    setSelectedId(id);
    setPending(null);
    setDraft(null);
    if (hit.region.src === current.writtenSrc) {
      zoomToComment(id);
      return;
    }
    const target = list?.findIndex((i) => i.writtenSrc === hit.region.src) ?? -1;
    if (target < 0) return;
    zoomOnLoad.current = id;
    go(target);
  };

  const onDraw = (event: ZoomDraw) => {
    if (pending) return;
    if (event.phase === 'move') {
      setSelectedId(null);
      setPending(null);
      setDraft(event.box);
    } else if (event.phase === 'end' && event.box) {
      setDraft(null);
      setPending(event.box);
      setAnnounced(`Box drawn, ${event.box.w} by ${event.box.h} pixels. Write the comment.`);
    } else {
      setDraft(null);
    }
  };

  const boxFromScreen = () => {
    const box = stageRef.current?.visibleBox();
    if (!box) return;
    setSelectedId(null);
    setPending(box);
    setAnnounced(`Commenting on the part of the image on screen, ${box.w} by ${box.h} pixels.`);
  };

  const saveRegion = (text: string, attachments?: ImageAttachment[], mentions?: readonly string[], quick = false) => {
    if (!regions || !pending || !dims || !current.writtenSrc || !current.blockId) return;
    const region = parseImageRegion({
      v: 1,
      src: current.writtenSrc,
      sourceLine: current.line ?? null,
      box: pending,
      naturalWidth: dims.width,
      naturalHeight: dims.height,
    });
    if (!region) return;
    const n = here.length + 1;
    const annotation: Annotation = {
      id: newRegionAnnotationId(),
      blockId: current.blockId,
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.COMMENT,
      text,
      originalText: current.writtenSrc,
      createdA: Date.now(),
      author: getIdentity(),
      ...(attachments && attachments.length > 0 ? { images: attachments } : {}),
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
      ...(quick ? { isQuickLabel: true } : {}),
      imageRegion: region,
    };
    regions.onAdd(annotation);
    setPending(null);
    setAnnounced(`Comment saved on region ${n}.${tool === 'region' ? ' Region is still on: drag to draw another box, or press Escape for Move.' : ''}`);
  };

  const askAI: CommentAskAIHandler | undefined = regions?.onAskAI
    ? async (question, context) => {
        const accepted = await regions.onAskAI!(question, context);
        if (accepted !== false) onCloseRef.current();
        return accepted;
      }
    : undefined;

  const showNote = (note: string) => {
    setEndNote(note);
    setAnnounced(note);
    if (endTimer.current) clearTimeout(endTimer.current);
    endTimer.current = setTimeout(() => setEndNote(null), 1800);
  };
  const waitingComment = () => {
    if (!pending) return false;
    showNote('Save or close the comment first');
    return true;
  };
  const step = (dir: 1 | -1) => {
    if (!stepping) return;
    const next = index + dir;
    if (next < 0 || next >= list!.length) {
      showNote(dir > 0 ? 'Last image in this document' : 'First image in this document');
      return;
    }
    go(next);
  };
  const go = (next: number) => {
    if (waitingComment()) return;
    refocusStage.current = !!stageRef.current?.element && document.activeElement === stageRef.current.element;
    setIndex(next);
    setZoomMode('fit');
    setScale(null);
    setDims(null);
    setView(null);
    setDraft(null);
    setPending(null);
    if (zoomOnLoad.current === null) setSelectedId(null);
    const image = list![next]!;
    setAnnounced(`${next + 1} of ${list!.length}, ${lightboxImageName(image)}${image.section ? `, in “${image.section}”` : ''}`);
  };
  useLayoutEffect(() => {
    if (!refocusStage.current) return;
    refocusStage.current = false;
    stageRef.current?.element?.focus({ preventScroll: true });
  }, [index]);
  const stepRef = useRef(step);
  stepRef.current = step;
  const swipeAreaRef = useRef<HTMLDivElement>(null);
  const swipeTrackRef = useRef<HTMLDivElement>(null);
  const tracked = (stage: React.ReactNode) =>
    swipe ? (
      <div ref={swipeTrackRef} className="absolute inset-0" data-lightbox-track="">
        {stage}
      </div>
    ) : (
      stage
    );
  const dimsRef = useRef(dims);
  dimsRef.current = dims;
  const zoomModeRef = useRef(zoomMode);
  zoomModeRef.current = zoomMode;
  useSwipeStep(framed ? swipeAreaRef : overlayRef, {
    enabled: !!swipe && !(canDraw && tool === 'region') && !peekOpen && !drawerOpen,
    canStep: (dir) => stepping && index + dir >= 0 && index + dir < (list?.length ?? 0),
    move: () => [swipeTrackRef.current],
    onStep: (dir) => stepRef.current(dir),
    wouldAsk: () => pending !== null,
    keeps: (dir) => !stepping || canPanToward(stageRef.current?.visibleBox() ?? null, dimsRef.current?.width ?? 0, dir),
    dismiss: {
      can: () => {
        if (zoomModeRef.current !== 'fit') return false;
        const box = stageRef.current?.visibleBox() ?? null;
        return box === null || box.y <= 1;
      },
      onDismiss: () => onCloseRef.current(),
      onProgress: (share) => {
        const overlay = overlayRef.current;
        if (!overlay) return;
        const veil = framed ? `color-mix(in oklch, var(--background) ${Math.round((1 - share) * 100)}%, transparent)` : `rgb(0 0 0 / ${(0.8 * (1 - share)).toFixed(3)})`;
        overlay.style.backgroundColor = share > 0 ? veil : '';
      },
    },
  });
  const steppingRef = useRef(stepping);
  steppingRef.current = stepping;
  const peekOpenRef = useRef(peekOpen);
  peekOpenRef.current = peekOpen;
  const regionKeys = useRef({ pending: false, draft: false, tool, drawerOpen, canDraw, boxFromScreen, setTool, setDrawerOpen, setPending, setDraft });
  regionKeys.current = { pending: pending !== null, draft: draft !== null, tool, drawerOpen, canDraw, boxFromScreen, setTool, setDrawerOpen, setPending, setDraft };

  useEffect(() => () => {
    if (endTimer.current) clearTimeout(endTimer.current);
  }, []);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (e: KeyboardEvent) => {
      if (peekOpenRef.current) {
        e.stopImmediatePropagation();
        if (peekRef.current?.handleKey({ key: e.key, isComposing: e.isComposing })) e.preventDefault();
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.preventDefault();
        return;
      }
      if (e.key === 'Tab') return;
      const target = e.target instanceof Element ? e.target : null;
      const r = regionKeys.current;
      if (target?.closest('[data-comment-popover]')) return;
      const inOwnUi = target?.closest('[data-region-strip], [data-region-drawer]');
      if (inOwnUi && (isTextField(target) || (e.key !== 'Escape' && !(e.key === 'Enter' && (e.metaKey || e.ctrlKey))))) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
      }
      if (e.key === 'Escape') {
        if (r.draft || r.pending) {
          r.setDraft(null);
          r.setPending(null);
          return;
        }
        if (r.drawerOpen && target?.closest('[data-region-drawer]')) {
          r.setDrawerOpen(false);
          countRef.current?.focus({ preventScroll: true });
          return;
        }
        if (r.tool === 'region') {
          r.setTool('move');
          setAnnounced('Move: drag moves the image.');
          return;
        }
        if (r.drawerOpen) {
          r.setDrawerOpen(false);
          return;
        }
        onCloseRef.current();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const stage = stageRef.current;
      if (e.key === 'Enter' && r.canDraw && r.tool === 'region' && stage?.element && e.target === stage.element) {
        e.preventDefault();
        r.boxFromScreen();
        return;
      }
      if (stage?.element && e.target === stage.element && stage.scrollKey(e.key, e.shiftKey, !steppingRef.current)) {
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === ']') {
        e.preventDefault();
        stepRef.current(1);
      } else if (e.key === 'ArrowLeft' || e.key === '[') {
        e.preventDefault();
        stepRef.current(-1);
      } else if (e.key === 'ArrowDown' && e.target === pillRef.current) {
        e.preventDefault();
        setPeekOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    const onGesture = (e: Event) => e.preventDefault();
    overlay.addEventListener('wheel', onWheel, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) overlay.addEventListener(type, onGesture, { passive: false });
    return () => {
      overlay.removeEventListener('wheel', onWheel);
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) overlay.removeEventListener(type, onGesture);
    };
  }, [framed]);

  const rows = useMemo<ImagePeekRow[]>(() => {
    if (!stepping) return [];
    const out: ImagePeekRow[] = [];
    list!.forEach((image, i) => {
      const label = image.section ?? 'Document';
      let row = out.at(-1);
      if (!row || row.label !== label) {
        row = { key: `row-${i}`, label, items: [] };
        out.push(row);
      }
      row.items.push({ key: String(i), name: lightboxImageName(image), thumb: image.src });
    });
    return out;
  }, [stepping, list]);

  if (!framed) {
    return (
      <div
        ref={overlayRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={alt || 'Image'}
        data-image-lightbox=""
        className="fixed inset-0 z-[200] bg-black/80 text-white backdrop-blur-sm outline-none"
      >
        {tracked(
          <ImageZoomStage
            ref={stageRef}
            key={src}
            src={src}
            alt={alt}
            label={alt ? `Image: ${alt}` : 'Image'}
            mode={zoomMode}
            onModeChange={setZoomMode}
            inset={{ x: 0.9, y: 0.85 }}
            onBackgroundTap={onClose}
            className="absolute inset-0"
            imageClassName="shadow-2xl"
            radius={8}
            stageAttributes={{ 'data-lightbox-stage': zoomMode }}
            wheelHint={wheelHint}
          />
        )}
        {alt && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[2.5vh] mx-auto max-w-[90vw] truncate text-center text-sm text-white/70">{alt}</div>
        )}
      </div>
    );
  }

  const total = list?.length ?? 1;
  const first = index === 0;
  const last = index === total - 1;
  const circle = 'flex h-11 w-11 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-sm hover:bg-muted disabled:opacity-40 aria-disabled:opacity-35';
  const drawing = canDraw && tool === 'region';
  const pendingNumber = here.length + 1;
  const strip = regionsOn ? (
    <RegionToolStrip
      tool={tool}
      onToolChange={(next) => {
        setTool(next);
        setDraft(null);
        if (next === 'region') setSelectedId(null);
        setAnnounced(next === 'region'
          ? 'Region: drag on the image to draw a box. Escape goes back to Move.'
          : 'Move: drag moves the image.');
      }}
      canDraw={canDraw}
      count={here.length}
      drawerOpen={drawerOpen}
      onToggleDrawer={() => setDrawerOpen((v) => !v)}
      drawerId={drawerId}
      phone={phone}
      countRef={countRef}
    />
  ) : null;
  const drawer = regionsOn && drawerOpen ? (
    <aside
      ref={drawerRef}
      id={drawerId}
      data-region-drawer=""
      aria-label="Comments on this image"
      className={phone
        ? 'fixed inset-x-0 bottom-0 z-[205] flex h-[46vh] flex-col rounded-t-2xl border-t border-border bg-card shadow-[0_-12px_40px_-16px_rgb(0_0_0/0.5)]'
        : 'flex w-[320px] flex-none flex-col border-l border-border/50 bg-card'}
    >
      {phone && <div className="mx-auto mb-0.5 mt-2 h-[5px] w-9 flex-none rounded-full bg-border" aria-hidden="true" />}
      <div className="flex h-11 flex-none items-center gap-2 border-b border-border/50 px-3">
        <h2 className="text-[13px] font-medium">{phone ? 'Comments on this image' : 'Comments'}</h2>
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary/10 px-1 font-mono text-[10px] font-medium tabular-nums text-primary">
          {drawerAnnotations.length}
        </span>
        {stepping && (
          <div role="group" aria-label="Show comments on" className="ml-auto flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
            {(['image', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                data-region-scope={value}
                aria-pressed={scope === value}
                onClick={() => setScope(value)}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${scope === value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {value === 'image' ? 'This image' : 'All'}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-label="Close comments"
          data-region-drawer-close=""
          onClick={() => {
            setDrawerOpen(false);
            countRef.current?.focus({ preventScroll: true });
          }}
          className={`${stepping ? '' : 'ml-auto '}flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground`}
        >
          <svg {...ICON} width={14} height={14}>
            <path d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <AnnotationPanel
          presentation="embedded"
          isOpen
          annotations={drawerAnnotations}
          blocks={[]}
          selectedId={selectedId}
          onSelect={pickComment}
          onDelete={(id) => {
            regions!.onDelete?.(id);
            if (id === selectedId) setSelectedId(null);
          }}
          onEdit={regions!.onEdit}
          readOnly={!regions!.onDelete}
          imageRegionSrc={thumbFor}
          mentionSource={regions!.mentionSource}
          emptyHint={canDraw ? 'Choose Region, then drag over the image to comment on part of it' : 'No comments on this image'}
        />
      </div>
    </aside>
  ) : null;

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={stepping ? `${name}, image ${index + 1} of ${total}` : name}
      data-image-lightbox=""
      data-image-lightbox-stepping={stepping ? '' : undefined}
      className={`fixed inset-0 z-[200] flex flex-col bg-background text-foreground outline-none ${phone && drawer ? 'pb-[46vh]' : ''}`}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex h-14 flex-none items-center gap-3 px-5">
        {stepping ? (
          <span className="text-[15px] font-semibold tabular-nums" data-lightbox-count="">
            {index + 1} of {total}
          </span>
        ) : (
          <span className="min-w-0 truncate text-[15px] font-semibold" data-lightbox-name="">
            {name}
          </span>
        )}
        {current.section && (
          <span className="min-w-0 truncate text-[14px] text-muted-foreground" data-lightbox-section="">
            in “{current.section}”
          </span>
        )}
        <span className="flex-1" />
        {scale !== null && (
          <span className="text-[13px] tabular-nums text-muted-foreground" data-lightbox-zoom="">
            <span className="sr-only">Zoom </span>
            {Math.round(scale * 100)}%
          </span>
        )}
        <button
          type="button"
          className="h-9 whitespace-nowrap rounded-md border border-border bg-card px-3 text-[13.5px] hover:bg-muted"
          onClick={() => setZoomMode((m) => (m === 'fit' ? 'actual' : 'fit'))}
          aria-pressed={zoomMode !== 'fit'}
          data-lightbox-fit=""
        >
          {zoomMode === 'fit' ? 'Actual size' : 'Fit'}
        </button>
        <button type="button" className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card hover:bg-muted" onClick={onClose} aria-label="Close" data-lightbox-close="">
          <svg {...ICON}>
            <path d="M6 18 18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 items-center gap-3 px-4">
            {stepping && (
              <button type="button" className={circle} onClick={() => step(-1)} aria-label="Previous image" aria-disabled={first || undefined} data-lightbox-prev="">
                <svg {...ICON}>
                  <path d="m15.75 19.5-7.5-7.5 7.5-7.5" />
                </svg>
              </button>
            )}
            <div ref={swipeAreaRef} className="relative min-h-0 min-w-0 flex-1 self-stretch" data-lightbox-swipe={swipe ? '' : undefined}>
              {tracked(
                <ImageZoomStage
                  ref={stageRef}
                  key={`${index}:${current.src}`}
                  src={current.src}
                  alt={current.alt}
                  label={`Image: ${name}`}
                  description={drawing ? 'Region: drag to draw a box and comment on it. Or frame the spot with Actual size and the scroll keys, then press Enter to comment on what is on screen.' : undefined}
                  mode={zoomMode}
                  onModeChange={setZoomMode}
                  onScaleChange={setScale}
                  onImageLoad={setDims}
                  onBackgroundTap={!stepping && !drawing ? onClose : undefined}
                  onViewChange={regionsOn ? (v, stage, eased) => setView({ view: v, stage, eased }) : undefined}
                  drawing={drawing}
                  onDraw={drawing ? onDraw : undefined}
                  className="absolute inset-0"
                  imageClassName="shadow-xl"
                  stageAttributes={{ 'data-lightbox-stage': zoomMode, ...(regionsOn ? { 'data-region-tool-active': tool } : {}) }}
                  wheelHint={wheelHint}
                >
                  {regionsOn && (
                    <RegionBoxLayer
                      view={view?.view ?? null}
                      stage={view?.stage ?? null}
                      eased={view?.eased ?? false}
                      regions={boxes}
                      selectedId={selectedId}
                      draft={draft}
                      pending={pending ? { box: pending, n: pendingNumber } : null}
                      interactive={!drawing}
                      onPick={(id) => {
                        setDrawerOpen(true);
                        setSelectedId(id);
                      }}
                      pendingRef={setPendingEl}
                    />
                  )}
                </ImageZoomStage>
              )}
              {strip && (
                <div className={`pointer-events-none absolute inset-x-0 z-[3] flex justify-center ${phone ? 'bottom-2.5' : 'top-2.5'}`}>{strip}</div>
              )}
              {regionsOn && phone && drawing && (
                <div className="pointer-events-none absolute left-1/2 top-2.5 z-[3] -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-popover px-3 py-1.5 text-[12px] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.4)]" data-region-hint="">
                  One finger draws · two fingers move the image
                </div>
              )}
            </div>
            {stepping && (
              <button type="button" className={circle} onClick={() => step(1)} aria-label="Next image" aria-disabled={last || undefined} data-lightbox-next="">
                <svg {...ICON}>
                  <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex flex-none flex-col items-center gap-2 px-4 pb-4 pt-3">
            {current.alt && <div className="max-w-[90vw] truncate text-[14px] font-medium">{current.alt}</div>}
            {stepping && (
              <div className="relative flex items-center gap-3">
                <span className="inline-flex items-center gap-px rounded-lg border border-border/70 bg-muted/40 p-0.5">
                  <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted" onClick={() => step(-1)} aria-label="Previous image" tabIndex={-1}>
                    <svg {...ICON} width={14} height={14}>
                      <path d="m15.75 19.5-7.5-7.5 7.5-7.5" />
                    </svg>
                  </button>
                  <button
                    ref={pillRef}
                    type="button"
                    className="flex h-7 max-w-[60vw] items-center gap-1.5 rounded-md px-2 text-[13.5px] hover:bg-muted"
                    aria-haspopup="grid"
                    aria-expanded={peekOpen}
                    aria-label={`${index + 1} of ${total}, ${name}. Show every image in this document`}
                    onClick={() => setPeekOpen((v) => !v)}
                    data-peek-opener=""
                    data-lightbox-pill=""
                  >
                    <span className="tabular-nums text-muted-foreground">
                      {index + 1} of {total}
                    </span>
                    <span className="text-muted-foreground" aria-hidden="true">
                      ·
                    </span>
                    <span className="truncate font-semibold">{name}</span>
                    <svg {...ICON} width={13} height={13} className={peekOpen ? 'rotate-180' : ''}>
                      <path d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                    </svg>
                  </button>
                  <button type="button" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted" onClick={() => step(1)} aria-label="Next image" tabIndex={-1}>
                    <svg {...ICON} width={14} height={14}>
                      <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                    </svg>
                  </button>
                </span>
                <span className={`whitespace-nowrap rounded-md bg-muted px-2 py-1 text-[12px] text-muted-foreground transition-opacity ${endNote ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" data-lightbox-end-note="">
                  {endNote}
                </span>
                {peekOpen && (
                  <div className="absolute bottom-[calc(100%+8px)] left-1/2 z-10 -translate-x-1/2">
                    <ImagePeek
                      ref={peekRef}
                      rows={rows}
                      current={String(index)}
                      label="Images in this document"
                      onPick={(key) => {
                        setPeekOpen(false);
                        go(Number(key));
                        pillRef.current?.focus({ preventScroll: true });
                      }}
                      onClose={(reason) => {
                        setPeekOpen(false);
                        if (reason === 'key') pillRef.current?.focus({ preventScroll: true });
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {drawer}
      </div>
      {regionsOn && pending && pendingEl && canDraw && (
        <CommentPopover
          key={`${pending.x},${pending.y},${pending.w},${pending.h}`}
          anchorEl={pendingEl}
          contextText={current.writtenSrc!}
          headerText={regionHeader(pendingNumber, pending)}
          isGlobal={false}
          placement="side"
          zIndex={210}
          allowImages={false}
          draftKey={`image-region:${regionDraftScope}:${pending.x},${pending.y},${pending.w},${pending.h}`}
          mentionSource={regions!.mentionSource}
          onAskAI={askAI}
          askAIContext={askAI ? {
            kind: 'selection',
            label: `Region ${pendingNumber} of ${imageRegionFileName(current.writtenSrc!)}`,
            text: current.writtenSrc!,
            detail: imageRegionLocationLines({
              v: 1,
              src: current.writtenSrc!,
              sourceLine: current.line ?? null,
              box: pending,
              naturalWidth: dims?.width ?? pending.x + pending.w,
              naturalHeight: dims?.height ?? pending.y + pending.h,
            }),
            ...(current.line ? { lineStart: current.line, lineEnd: current.line } : {}),
          } : undefined}
          onSubmit={(text, attachments, mentions) => saveRegion(text, attachments, mentions)}
          onQuickLookGood={() => saveRegion(`${THUMBS_UP_LABEL.emoji} ${THUMBS_UP_LABEL.text}`, undefined, undefined, true)}
          onClose={() => setPending(null)}
        />
      )}
      <div className="sr-only" aria-live="polite" data-lightbox-live="">
        {announced}
      </div>
    </div>
  );
};
