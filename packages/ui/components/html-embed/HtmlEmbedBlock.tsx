/**
 * A ```html fence drawn as a live page in the document (approval
 * "inbox-inline-html", 2026-10-28; the policy and the page's protocol are
 * @plannotator/core/html-embed). Only for a host that serves embed documents
 * (`HtmlEmbedHost`, the Viewer's `htmlEmbeds`); without one a fence stays
 * code, as before.
 *
 * A sandboxed frame, as T3 Code draws an agent's HTML: an opaque origin, its
 * height and theme by message (checked against the frame's own window), and
 * a web link opened only while the person is using the frame (it has focus
 * and the window has the person's activation).
 *
 * The look is the owner's: the page sits in the text with no card, border or
 * background of its own (its document is transparent and takes the host's
 * theme and color-scheme), as tall as its page up to `EMBED_CLIP_PX`, then a
 * fade and "Show more". Under it one quiet line: "HTML · sandboxed", Code
 * (the fence's source in place of the page) and Full screen (the same page in
 * ui's popout, scrolling).
 *
 * Comments in place (the owner's pick "A · In place", 2026-11-20; a host
 * that passes `annotate`): a pen at the right end of that line. On, a click
 * on an element of the page boxes it and opens the comment box beside it; a
 * saved comment leaves a numbered marker on its element. The page is then
 * framed from a second document, `AnnotatableEmbedFrame`: the same page with
 * the annotation bridge inlined, under the same sandbox and policy. That
 * document loads only once the pen is turned on or the block has a comment
 * to show; until then the block is exactly the frame above.
 */

import { Code, PenLine } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMBED_SANDBOX,
  EMBED_THEME_TOKENS,
  embedFragment,
  embedIdFromUrl,
  embedThemeMessage,
  readEmbedMessage,
  type EmbedMode,
  type EmbedTheme,
} from '@plannotator/core/html-embed';
import { buildHtmlBlockAnchor, matchHtmlBlockAnchor, parseHtmlBlockAnchor } from '@plannotator/core/html-block-anchor';
import type { Annotation, Block } from '../../types';
import { blockEndLine } from '../../utils/parser';
import { CodeBlock } from '../blocks/CodeBlock';
import { HostTitle } from '../HostTitle';
import { PopoutDialog } from '../PopoutDialog';
import { useTheme } from '../ThemeProvider';
import { acquireEmbedLoad, claimEmbedLive, onEmbedLiveFreed, releaseEmbedLive, useNearViewport } from './loadGate';
import { sourceLineAttrs } from '../../utils/sourceLineAttrs';

/** A host that can serve embed documents (the Inbox: POST /api/inbox/embeds). */
export interface HtmlEmbedHost {
  /**
   * Keep `html` and give the URL of its embed document, served under
   * `EMBED_RESPONSE_CSP`. Null (or a rejection) shows the fence as code.
   */
  frameUrl(html: string): Promise<string | null>;
  /** Who wrote the page ("Claude Code"), for the caption's hover text. */
  author?: string;
  /**
   * Opt-in: comments on the page's elements, in place (the pen in the
   * caption). Absent: no pen and no second document, the block as before.
   */
  annotate?: HtmlEmbedAnnotate;
}

/** What a host that takes comments on a block's elements gives the block (`HtmlEmbedHost.annotate`). */
export interface HtmlEmbedAnnotate {
  /**
   * Keep the block's annotatable document (the page with the annotation
   * bridge inlined, built by ui's HtmlViewer) and give the URL it is served
   * from, under the embed's own policy (`EMBED_RESPONSE_CSP`) and nothing
   * wider. Null (or a rejection): the frame stays empty.
   */
  frameUrl(document: string): Promise<string | null>;
  /**
   * The block's place among the document's live html blocks, from 1
   * (`HtmlBlockAnchor.index`). 0: not a block the host takes comments on, so
   * it shows no pen.
   */
  indexOf(block: Block): number;
  /**
   * The document's comments that name an html block (`htmlBlockAnchor`), in
   * the order the host lists them. Each block draws its own, numbered in
   * this order.
   */
  annotations: readonly Annotation[];
  /**
   * A new comment, with `blockId` and `htmlBlockAnchor` set. Answers false
   * when the host did not keep it: its marker then leaves the page.
   */
  onAdd(annotation: Annotation): Promise<boolean> | boolean | void;
  /** The comment the host points at: its block opens past its clip and its marker is shown selected. */
  selectedId?: string | null;
  /** A marker was pressed (null: the selection was cleared). */
  onSelect?(id: string | null): void;
  /**
   * Which of a block's comments it tried to draw, and which of those found
   * no element (or were made on another source): the complete verdict for
   * `attempted`, as the Viewer's `onRestoreReport`.
   */
  onRestoreReport?(report: { attempted: readonly string[]; unanchored: readonly string[] }): void;
  /** False: the comment box has no image button. Absent: it has one. */
  allowImages?: boolean;
}

/**
 * The block drawn on its own, big (the Inbox's Artifacts: a block's tile opens it): the Full screen popout's frame
 * and title bar, the page whole at its own height (no clip), and the caption's tools in the title bar (Code, the
 * pen), the same state and comments as the block in the text. Absent: the block in the text, as always.
 */
export interface HtmlEmbedOpen {
  onClose(): void;
}

/** The annotatable frame (ui's HtmlViewer and its bridge): fetched only when a block is first annotated. */
const AnnotatableEmbedFrame = lazy(async () => ({ default: (await import('./AnnotatableEmbedFrame')).AnnotatableEmbedFrame }));

/** How tall a page shows in the text before "Show more" (30rem). */
export const EMBED_CLIP_PX = 480;
/** The frame's height until its page reports one. */
export const EMBED_FIRST_HEIGHT = 120;

/** The host's theme, read from the page's tokens once they have applied. */
function useEmbedTheme(): EmbedTheme {
  const { colorTheme, resolvedMode } = useTheme();
  const read = useCallback((): EmbedTheme => {
    const style = getComputedStyle(document.documentElement);
    const vars: Record<string, string> = {};
    for (const name of EMBED_THEME_TOKENS) {
      const value = style.getPropertyValue(name).trim();
      if (value) vars[name] = value;
    }
    return { vars, scheme: resolvedMode === 'light' ? 'light' : 'dark' };
  }, [resolvedMode]);
  const [theme, setTheme] = useState<EmbedTheme>(read);
  useEffect(() => {
    // The provider writes the tokens in its own effect, after this one: read on the next frame.
    const frame = requestAnimationFrame(() => setTheme(read()));
    return () => cancelAnimationFrame(frame);
  }, [colorTheme, read]);
  return theme;
}

/** How long a page has to speak (its bootstrap reports a height) before the block shows its code. */
let readyTimeoutMs = 10_000;
/** Tests only. */
export function setEmbedReadyTimeoutForTests(ms: number): void {
  readyTimeoutMs = ms;
}

/**
 * A link an embed's page asks for opens only while the person is using its
 * frame: it has focus, and the window has the person's activation (as T3 Code).
 */
export function openEmbedLink(frame: HTMLIFrameElement, url: string): void {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (document.activeElement !== frame || activation?.isActive === false) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * An embed frame's messages (its height, a web link, Escape), read only from
 * that frame's own window and only through `readEmbedMessage`. `frameOf`
 * names the frame at each message. `onReady` runs at its first message.
 */
export function useEmbedMessages(
  frameOf: () => HTMLIFrameElement | null,
  handlers: { onHeight?: (height: number) => void; onEscape: (frame: HTMLIFrameElement | null) => void; onReady?: () => void },
): void {
  const frameOfRef = useRef(frameOf);
  frameOfRef.current = frameOf;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const spoke = useRef(false);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only this frame's own page: every other window (another embed, a page it framed) is ignored.
      const frame = frameOfRef.current();
      if (!frame || event.source !== frame.contentWindow) return;
      const message = readEmbedMessage(event.data);
      if (!message) return;
      if (!spoke.current) {
        spoke.current = true;
        handlersRef.current.onReady?.();
      }
      if (message.kind === 'height') handlersRef.current.onHeight?.(message.height);
      else if (message.kind === 'link') openEmbedLink(frame, message.url);
      else handlersRef.current.onEscape(frame);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
}

/** One embed frame and its messages. `onLoaded` runs on its load. */
function EmbedFrame({
  url,
  theme,
  mode,
  title,
  height,
  onHeight,
  onEscape,
  onLoaded,
  onReady,
}: {
  url: string;
  theme: EmbedTheme;
  mode: EmbedMode;
  title: string;
  height?: number;
  onHeight?: (height: number) => void;
  onEscape: (frame: HTMLIFrameElement | null) => void;
  onLoaded?: () => void;
  onReady?: () => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  // The theme the page starts with rides in the URL (no flash); later ones go by message.
  const [src] = useState(() => url + embedFragment(theme, mode));
  const handlers = useRef({ onLoaded });
  handlers.current = { onLoaded };
  useEmbedMessages(() => ref.current, { onHeight, onEscape, onReady });

  useEffect(() => {
    if (loaded.current) ref.current?.contentWindow?.postMessage(embedThemeMessage(theme), '*');
  }, [theme]);

  return (
    <iframe
      ref={ref}
      allowFullScreen
      src={src}
      sandbox={EMBED_SANDBOX}
      referrerPolicy="no-referrer"
      loading="lazy"
      title={title}
      data-html-embed-frame={mode}
      onLoad={() => {
        if (loaded.current) return;
        loaded.current = true;
        handlers.current.onLoaded?.();
      }}
      style={{
        display: 'block',
        width: '100%',
        height: mode === 'full' ? '100%' : `${height ?? EMBED_FIRST_HEIGHT}px`,
        border: 0,
        background: 'transparent',
        // Must match the page's own color-scheme, or the browser paints an opaque backdrop behind it.
        colorScheme: theme.scheme,
      }}
    />
  );
}

type Phase = 'far' | 'waiting' | 'loading' | 'ready' | 'failed';

export function HtmlEmbedBlock({ block, host, open }: { block: Block; host: HtmlEmbedHost; open?: HtmlEmbedOpen }) {
  const figureRef = useRef<HTMLElement>(null);
  // Open big (`open`): on screen by definition, and never waiting for a live slot.
  const big = open !== undefined;
  const near = useNearViewport(figureRef) || big;
  const theme = useEmbedTheme();
  const [showCode, setShowCode] = useState(false);
  const [phase, setPhase] = useState<Phase>('far');
  const [url, setUrl] = useState<string | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false);
  const [forced, setForced] = useState(false);
  const releaseLoad = useRef<(() => void) | null>(null);
  // The host is read when a page is asked for: a new host object (a re-render) never reloads the page.
  const hostRef = useRef(host);
  hostRef.current = host;

  // Comments in place (`host.annotate`). The block's own comments are the ones that name its place; they are
  // drawn only when they were made on this source (the embed id, known once the page's URL is).
  const annotate = host.annotate;
  const index = annotate ? annotate.indexOf(block) : 0;
  const embedId = url === null ? null : embedIdFromUrl(url);
  const [armed, setArmed] = useState(false);
  const mine = useMemo(() => {
    const own: Annotation[] = [];
    const changed: string[] = [];
    let pending = false;
    if (index > 0) {
      for (const annotation of annotate?.annotations ?? []) {
        const anchor = parseHtmlBlockAnchor(annotation.htmlBlockAnchor);
        if (!anchor) continue;
        const match = matchHtmlBlockAnchor(anchor, { index, id: embedId });
        if (match === 'own') own.push(annotation);
        else if (match === 'changed') changed.push(annotation.id);
        else if (match === 'pending') pending = true;
      }
    }
    return { own, changed, pending };
  }, [annotate?.annotations, index, embedId]);
  // The annotatable document, once asked for (the pen, or a comment to show), stays: going back would load the page again.
  const [annotatable, setAnnotatable] = useState(false);
  // A host that could not keep the annotatable document: the block goes back to its light frame, pen off, until
  // the pen is pressed again (never a blank box).
  const [refused, setRefused] = useState(false);
  const wantsAnnotatable = index > 0 && !refused && (armed || mine.own.length > 0 || mine.pending);
  useEffect(() => {
    if (wantsAnnotatable) setAnnotatable(true);
  }, [wantsAnnotatable]);
  const annotatableUrl = useCallback(async (document: string): Promise<string | null> => {
    let next: string | null = null;
    try {
      next = (await hostRef.current.annotate?.frameUrl(document)) ?? null;
    } catch {
      next = null;
    }
    if (next === null) {
      setRefused(true);
      setAnnotatable(false);
      setArmed(false);
    }
    return next;
  }, []);
  // The page's own verdict on the comments it was given (null until its first), and the block's report to the host.
  const [missing, setMissing] = useState<readonly string[] | null>(null);
  useEffect(() => {
    if (embedId === null || (mine.own.length === 0 && mine.changed.length === 0)) return;
    if (mine.own.length > 0 && missing === null) {
      if (mine.changed.length > 0) hostRef.current.annotate?.onRestoreReport?.({ attempted: mine.changed, unanchored: mine.changed });
      return;
    }
    const lost = new Set(missing ?? []);
    const own = mine.own.map((annotation) => annotation.id);
    hostRef.current.annotate?.onRestoreReport?.({ attempted: [...own, ...mine.changed], unanchored: [...own.filter((id) => lost.has(id)), ...mine.changed] });
  }, [embedId, mine, missing]);
  const selectedId = annotate?.selectedId != null && mine.own.some((annotation) => annotation.id === annotate.selectedId) ? annotate.selectedId : null;
  // The comment the host points at may sit under the clip: the block opens.
  useEffect(() => {
    if (selectedId !== null) setExpanded(true);
  }, [selectedId]);
  const addComment = useCallback(
    async (annotation: Annotation): Promise<boolean> => {
      const add = hostRef.current.annotate?.onAdd;
      const first = typeof block.startLine === 'number' && block.startLine >= 1 ? block.startLine : null;
      const anchor = embedId === null ? null : buildHtmlBlockAnchor(index, embedId, first === null ? null : [first, Math.max(first, blockEndLine(block))]);
      if (!add || !anchor) return false;
      // Back to Interact once a comment is added (the owner's decision): the pen is for one comment at a time.
      setArmed(false);
      const kept = await add({ ...annotation, blockId: block.id, htmlBlockAnchor: anchor });
      return kept !== false;
    },
    [block, embedId, index],
  );
  // A marker's click names a comment by id, and the page can post any id: only this block's own are opened.
  const ownIdsRef = useRef<ReadonlySet<string>>(new Set());
  ownIdsRef.current = useMemo(() => new Set(mine.own.map((annotation) => annotation.id)), [mine]);
  const selectComment = useCallback((id: string | null) => {
    if (id !== null && !ownIdsRef.current.has(id)) return;
    hostRef.current.annotate?.onSelect?.(id);
  }, []);
  const disarm = useCallback(() => setArmed(false), []);

  // Near the screen: take a live slot (or wait for one), a load permit, then the page's URL.
  useEffect(() => {
    if (!near || showCode) return;
    let cancelled = false;
    let holdsLive = false;
    let stopWaiting: (() => void) | null = null;
    const start = () => {
      if (cancelled) return;
      if (!claimEmbedLive(forced || big)) {
        setPhase('waiting');
        stopWaiting = onEmbedLiveFreed(() => {
          stopWaiting?.();
          stopWaiting = null;
          start();
        });
        return;
      }
      holdsLive = true;
      setPhase('loading');
      void acquireEmbedLoad().then(async (release) => {
        if (cancelled) return release();
        releaseLoad.current = release;
        let next: string | null = null;
        try {
          next = await hostRef.current.frameUrl(block.content);
        } catch {
          next = null;
        }
        if (cancelled) return release();
        if (next === null) {
          release();
          setPhase('failed');
          return;
        }
        setUrl(next);
      });
    };
    start();
    return () => {
      cancelled = true;
      stopWaiting?.();
      releaseLoad.current?.();
      releaseLoad.current = null;
      if (holdsLive) releaseEmbedLive();
      setUrl(null);
    };
  }, [near, showCode, forced, big, block.content]);

  // Loaded: the load permit goes back. Ready only once the page speaks (a frame the browser
  // refused loads too, blank, and never speaks).
  const loaded = useCallback(() => {
    releaseLoad.current?.();
    releaseLoad.current = null;
  }, []);
  const ready = useCallback(() => {
    releaseLoad.current?.();
    releaseLoad.current = null;
    setPhase((now) => (now === 'loading' ? 'ready' : now));
  }, []);

  // A page that never speaks (the frame was refused, or the Inbox lost it): its code instead.
  useEffect(() => {
    if (phase !== 'loading' || url === null) return;
    const timer = setTimeout(() => setPhase((now) => (now === 'loading' ? 'failed' : now)), readyTimeoutMs);
    return () => clearTimeout(timer);
  }, [phase, url]);

  const escapeInline = useCallback((frame: HTMLIFrameElement | null) => {
    // Escape in the page hands the keyboard back to the document (the host's own Escape comes next).
    if (frame && document.activeElement === frame) frame.blur();
  }, []);
  // Open big: Escape in the page turns the pen off, else closes, as Full screen's page does.
  const openRef = useRef(open);
  openRef.current = open;
  const armedRef = useRef(armed);
  armedRef.current = armed;
  const escapeBig = useCallback(() => {
    if (armedRef.current) setArmed(false);
    else openRef.current?.onClose();
  }, []);
  const escapePage = big ? escapeBig : escapeInline;

  const clipped = !big && !expanded && height !== undefined && height > EMBED_CLIP_PX;
  const title = host.author ? `HTML from ${host.author}` : 'HTML page';
  const caption = host.author ? `From ${host.author}. It runs in a sandbox and can load from the web.` : 'It runs in a sandbox and can load from the web.';
  const live = !showCode && url !== null;
  const penShown = annotate !== undefined && index > 0;
  const penOn = armed && live;
  // The pen is off with the page: its code, or no page yet.
  useEffect(() => {
    if (!live) setArmed(false);
  }, [live]);

  // The annotatable document has to speak too, as the light frame does: one that never does (the host lost
  // it, the browser refused it) is never a blank box. The block goes back to its light frame, pen off, which
  // has its own wait before its code is shown.
  const annotatableShown = live && annotatable && annotate !== undefined;
  const [annotatableSpoke, setAnnotatableSpoke] = useState(false);
  useEffect(() => {
    setAnnotatableSpoke(false);
  }, [annotatableShown, url]);
  const annotatableReady = useCallback(() => {
    setAnnotatableSpoke(true);
    ready();
  }, [ready]);
  useEffect(() => {
    if (!annotatableShown || annotatableSpoke) return;
    const timer = setTimeout(() => {
      setRefused(true);
      setAnnotatable(false);
      setArmed(false);
      setPhase((now) => (now === 'ready' ? 'loading' : now));
    }, readyTimeoutMs);
    return () => clearTimeout(timer);
  }, [annotatableShown, annotatableSpoke, url]);

  const body = useMemo(() => {
    if (showCode || phase === 'failed') return <CodeBlock block={block} isHovered={false} />;
    if (phase === 'waiting') {
      return (
        <button
          type="button"
          data-html-embed-waiting=""
          className="flex w-full items-center justify-center rounded-lg border border-dashed border-border py-6 text-xs text-muted-foreground hover:text-foreground"
          style={{ minHeight: height ? Math.min(height, EMBED_CLIP_PX) : EMBED_FIRST_HEIGHT }}
          onClick={() => setForced(true)}
        >
          Show page
        </button>
      );
    }
    return null;
  }, [showCode, phase, block, height]);

  const page = body ?? (
        <div className="relative">
          <div
            data-html-embed-clip=""
            style={{
              maxHeight: clipped ? EMBED_CLIP_PX : undefined,
              overflow: 'hidden',
              // A fade that needs no background color: the message shows through it.
              maskImage: clipped ? 'linear-gradient(to bottom, black calc(100% - 72px), transparent)' : undefined,
              WebkitMaskImage: clipped ? 'linear-gradient(to bottom, black calc(100% - 72px), transparent)' : undefined,
            }}
          >
            {live && annotatable && annotate ? (
              <Suspense fallback={<div aria-hidden="true" style={{ height: height ?? EMBED_FIRST_HEIGHT }} />}>
                <AnnotatableEmbedFrame
                  key={url}
                  html={block.content}
                  frameUrl={annotatableUrl}
                  theme={theme}
                  title={title}
                  height={height}
                  onHeight={setHeight}
                  onEscape={escapePage}
                  onReady={annotatableReady}
                  armed={penOn}
                  onDisarm={disarm}
                  annotations={mine.own}
                  onAdd={addComment}
                  selectedId={selectedId}
                  onSelect={selectComment}
                  onUnanchored={setMissing}
                  allowImages={annotate.allowImages !== false}
                />
              </Suspense>
            ) : live ? (
              <EmbedFrame
                key={url}
                url={url}
                theme={theme}
                mode="inline"
                title={title}
                height={height}
                onHeight={setHeight}
                onEscape={escapePage}
                onLoaded={loaded}
                onReady={ready}
              />
            ) : (
              <div aria-hidden="true" style={{ height: height ?? EMBED_FIRST_HEIGHT }} />
            )}
          </div>
          {clipped && (
            <div className="absolute inset-x-0 bottom-1 flex justify-center">
              <button
                type="button"
                data-html-embed-more=""
                className="rounded-full border border-border bg-background px-3.5 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-muted"
                onClick={() => setExpanded(true)}
              >
                Show more
              </button>
            </div>
          )}
        </div>
  );
  const codeButton = (
        <button
          type="button"
          data-html-embed-code=""
          aria-pressed={showCode}
          className={`rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground ${showCode ? 'bg-muted text-foreground' : ''}`}
          onClick={() => setShowCode((value) => !value)}
        >
          Code
        </button>
  );
  const pen = penShown && (
          // On: its name says what a press does next, as the pen over an attached page.
          <HostTitle title={penOn ? 'Interact' : 'Annotate'} name>
            <button
              type="button"
              data-html-embed-annotate=""
              aria-pressed={penOn}
              disabled={!live}
              className={`rounded px-1.5 py-[3px] disabled:pointer-events-none disabled:opacity-50 max-sm:-my-2 max-sm:px-2.5 max-sm:py-2.5 ${penOn ? 'bg-primary text-primary-foreground' : 'hover:bg-muted hover:text-foreground'}`}
              onClick={() => {
                setRefused(false);
                setArmed((value) => !value);
              }}
            >
              <PenLine aria-hidden="true" className="h-3.5 w-3.5" />
            </button>
          </HostTitle>
  );
  const phaseAttr = showCode ? 'code' : phase;
  const commentsAttr = mine.own.length > 0 ? mine.own.map((annotation) => annotation.id).join(' ') : undefined;

  if (open) {
    // Big: Full screen's popout and title bar, the page whole below it, the caption's tools in the bar.
    return (
      <PopoutDialog open onClose={open.onClose} title={title} className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none" dataAttributes={{ 'data-html-embed-open': '' }}>
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pl-4 pr-12 text-xs font-medium text-foreground">
          <span className="min-w-0 flex-1 truncate">{title}</span>
          <span className="flex shrink-0 items-center gap-1 font-normal text-muted-foreground">
            {codeButton}
            {pen}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4">
          <figure ref={figureRef} data-block-id={block.id} data-html-embed="" data-html-embed-phase={phaseAttr} data-html-embed-comments={commentsAttr} className="relative my-4">
            {page}
          </figure>
        </div>
      </PopoutDialog>
    );
  }

  return (
    <figure ref={figureRef} data-block-id={block.id} data-html-embed="" data-html-embed-phase={phaseAttr} data-html-embed-comments={commentsAttr} className="relative my-4" {...(showCode || phase === 'failed' ? undefined : sourceLineAttrs(block))}>
      {page}
      <figcaption data-html-embed-caption="" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <Code aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <HostTitle title={caption}>
          <span className="truncate">HTML · sandboxed</span>
        </HostTitle>
        <span className="flex-1" />
        {expanded && !showCode && (
          <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => setExpanded(false)}>
            Show less
          </button>
        )}
        {codeButton}
        <button
          type="button"
          data-html-embed-full=""
          disabled={url === null || showCode}
          className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={() => setFull(true)}
        >
          Full screen
        </button>
        {pen}
      </figcaption>
      {full && url !== null && (
        <PopoutDialog
          open
          onClose={() => setFull(false)}
          title={title}
          className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none"
          dataAttributes={{ 'data-html-embed-popout': '' }}
        >
          <div className="flex h-9 shrink-0 items-center border-b border-border pl-4 pr-12 text-xs font-medium text-foreground">{title}</div>
          <div className="min-h-0 flex-1">
            <EmbedFrame url={url} theme={theme} mode="full" title={title} onEscape={() => setFull(false)} />
          </div>
        </PopoutDialog>
      )}
    </figure>
  );
}
