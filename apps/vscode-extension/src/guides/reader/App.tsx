import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffTokenEventBaseProps, SelectedLineRange } from "@pierre/diffs";
import type { CodeGuideData } from "@plannotator/core/guide";
import { GuideHostProvider, type GuideHostValue } from "@plannotator/guide-viewer/host";
import { GuideView } from "@plannotator/guide-viewer/GuideView";
import { engineLabel } from "@plannotator/guide-viewer/GuideViewer";
import { parseDiffToFiles } from "@plannotator/guide-viewer/diffParser";
import type { DiffFile } from "@plannotator/guide-viewer/types";
import { TokenHoverCard } from "@plannotator/review-editor/components/TokenHoverCard";
import { useTokenHover, type TokenHoverResolver } from "@plannotator/review-editor/hooks/useTokenHover";
import { buildCodeNavRequest, buildTokenHoverRequest } from "@plannotator/review-editor/utils/buildCodeNavRequest";
import type { CodeNavHoverResponse, CodeNavRequest } from "@plannotator/shared/code-nav";
import type { AIChatEntry } from "@plannotator/ui/hooks/useAIChat";
import type { AnswerMarker, ChapterAnswers, DiffPosition, HoverAnswer, NavigateAction, ReaderInit } from "../reader-protocol";
import { onMessage, post, requestHover, viewState } from "./bridge";
import { ReaderDiffRenderer, type ReaderDiffProps } from "./DiffRenderer";
import { HoverCardContent } from "./HoverCard";
import { ChapterStrip, chapterInView } from "./ChapterStrip";
import { ChapterAsk } from "./ChapterAsk";
import { answerChatEntries } from "./ask-markers";
import { askLines, cancelDiffLineJump, scrollToDiffLine } from "./lines";

import type { MermaidCheck } from "../webview/diagram";

const OverviewDiagram = lazy(() => import("./OverviewDiagram"));

/** The hover card's data: the search card's shape (what `useTokenHover` keys and gates on), carrying the language server's answer. */
type ReaderHoverData = CodeNavHoverResponse & { reader: { answer: HoverAnswer; at: DiffPosition } };

/** Each hover is keyed by its position, not only its name: the language server answers per position. */
const POSITION_MARK = "\u0001";

function positionOf(request: CodeNavRequest): DiffPosition {
  const [token] = request.symbol.split(POSITION_MARK);
  return { path: request.filePath, side: request.side, line: request.line, character: request.charStart, token };
}

const resolveHover: TokenHoverResolver = async (request, signal) => {
  const at = positionOf(request);
  const answer = await requestHover(at, signal);
  if (!answer || (!answer.blocks.length && !answer.definition)) return null;
  const def = answer.definition;
  const data: ReaderHoverData = {
    backend: "search",
    source: "search",
    symbol: answer.symbol,
    // The search card shows a card only with a definition; the language server's hover is enough here.
    definition: {
      filePath: def?.path ?? at.path,
      line: def?.line ?? at.line,
      column: def?.character ?? at.character,
      confidence: "likely",
      symbolKind: null,
      signature: null,
      signatureApproximate: false,
      doc: null,
      preview: null,
      otherCandidateCount: 0,
    },
    alternateDefinition: null,
    references: [],
    referenceCount: 0,
    capped: false,
    stats: { elapsedMs: answer.elapsedMs },
    reader: { answer, at },
  };
  return data;
};

export function ReaderApp({ init }: { init: ReaderInit }) {
  const { snapshot } = init;
  const files = useMemo<DiffFile[]>(() => parseDiffToFiles(snapshot.review.rawPatch), [snapshot.review.rawPatch]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [reviewed, setReviewed] = useState<boolean[]>(init.reviewed);
  const [fileTicks, setFileTicks] = useState<Set<string>>(() => new Set(init.fileTicks));
  const [focusedFile, setFocusedFile] = useState<string | null>(null);
  const [revealFile, setRevealFile] = useState<{ path: string; token: number } | null>(null);
  const revealToken = useRef(0);
  /** A `reveal` arrived: the opening scroll to the first chapter not reviewed no longer runs. */
  const revealedRef = useRef(false);
  const [asks, setAsks] = useState<{ busy: boolean; markers: AnswerMarker[]; chapters: ChapterAnswers[]; agent: string | null }>({
    busy: false,
    markers: [],
    chapters: [],
    agent: init.askAgent,
  });
  const [back, setBack] = useState<{ label: string; scrollY: number } | null>(null);
  // A short line at the foot of the tab (an ask that cannot be sent, the extension's notice).
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);
  const mod = init.platform === "mac" ? "⌘" : "Ctrl";

  const guide = useMemo<CodeGuideData>(
    () => ({
      title: snapshot.guide.title,
      intent: snapshot.guide.intent,
      ...(snapshot.guide.overview && { overview: snapshot.guide.overview }),
      sections: snapshot.guide.sections,
      unplacedFiles: snapshot.guide.unplacedFiles,
      reviewed: [...reviewed],
      ...(init.moved && { moved: true }),
    }),
    [snapshot.guide, reviewed, init.moved],
  );

  const reveal = useCallback((path: string) => {
    revealToken.current += 1;
    setRevealFile({ path, token: revealToken.current });
  }, []);

  const scrollToChapter = useCallback((index: number) => {
    cancelDiffLineJump();
    const el = document.querySelector(`[data-guide-section="${index}"]`);
    if (el) {
      const top = el.getBoundingClientRect().top + window.scrollY - stripHeight();
      window.scrollTo({ top, behavior: "smooth" });
    }
  }, []);

  useEffect(
    () =>
      onMessage((msg) => {
        if (msg.type === "reviewed") {
          setReviewed(msg.reviewed);
          setFileTicks(new Set(msg.fileTicks));
        }
        else if (msg.type === "checkMermaid") {
          // A chunk that does not load is "cannot check here", never a refusal of the diagram.
          void import("./OverviewDiagram")
            .then((m) => m.checkMermaidHere(msg.source))
            .catch((err: unknown): MermaidCheck => ({ ok: false, unavailable: true, message: err instanceof Error ? err.message : String(err) }))
            .then((r) => post({ type: "mermaidResult", reqId: msg.reqId, ok: r.ok, ...(r.message && { message: r.message }), ...(r.line && { line: r.line }), ...(r.unavailable && { unavailable: true }) }));
        } else if (msg.type === "asks") setAsks({ busy: msg.busy, markers: msg.markers, chapters: msg.chapters, agent: msg.agent });
        else if (msg.type === "reveal") {
          // A jump asked for before the opening scroll ran wins over it.
          revealedRef.current = true;
          if (msg.path) {
            setBack(backHere(snapshot.guide.sections.length));
            reveal(msg.path);
            // A jump to a definition lands on its line, once the file's diff is drawn.
            if (msg.line) void scrollToDiffLine(msg.path, msg.side ?? "new", msg.line);
            else cancelDiffLineJump();
          } else if (typeof msg.chapter === "number") scrollToChapter(msg.chapter);
        } else if (msg.type === "notice") setNotice(msg.text);
      }),
    [reveal, scrollToChapter, snapshot.guide.sections.length],
  );

  // Open on the first chapter not reviewed yet.
  useEffect(() => {
    if (init.startChapter <= 0) return;
    const t = setTimeout(() => {
      if (!revealedRef.current) scrollToChapter(init.startChapter);
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hover: the extension asks the language server on the real file.
  const hover = useTokenHover(init.guideId, { resolve: resolveHover });
  // The token under the pointer, for F12 / Shift+F12 (as in an editor).
  const pointedRef = useRef<DiffPosition | null>(null);
  const onTokenHoverEnter = useCallback(
    (props: DiffTokenEventBaseProps, filePath: string) => {
      const request = buildTokenHoverRequest(props, filePath);
      if (!request) return;
      pointedRef.current = positionOf(request);
      hover.onTokenHoverEnter({ ...request, symbol: `${request.symbol}${POSITION_MARK}${request.line}:${request.charStart}` }, props.tokenElement);
    },
    [hover.onTokenHoverEnter],
  );
  const onTokenHoverLeave = useCallback(() => {
    pointedRef.current = null;
    hover.onTokenHoverLeave();
  }, [hover.onTokenHoverLeave]);
  const navigate = useCallback(
    (at: DiffPosition, action: NavigateAction) => {
      hover.close();
      // "Back to Chapter N" appears when the extension answers with a jump inside the guide (`reveal`).
      post({ type: "navigate", at, action });
    },
    [hover.close],
  );
  const onCodeNavRequest = useCallback((request: CodeNavRequest) => navigate(positionOf(request), "definition"), [navigate]);
  const hoveredAt = (hover.hover?.data as ReaderHoverData | undefined)?.reader?.at ?? null;
  const hoveredRef = useRef(hoveredAt);
  hoveredRef.current = hoveredAt;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F12" || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = hoveredRef.current ?? pointedRef.current;
      if (!at) return;
      e.preventDefault();
      navigate(at, e.shiftKey ? "references" : "definition");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  // The selected lines, per file: the selection toolbar's Ask asks about them.
  const [selection, setSelection] = useState<{ path: string; range: SelectedLineRange } | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onAskAIForFile = useCallback((filePath: string, question: string) => {
    const sel = selectionRef.current;
    if (!sel || sel.path !== filePath || !question.trim()) return;
    const lines = askLines(sel.range, filesRef.current.find((f) => f.path === filePath)?.patch);
    if (!lines) {
      setNotice("Select lines on one side of the change: removed lines or the new lines, not both.");
      return;
    }
    post({ type: "ask", question: question.trim(), path: filePath, ...lines });
    setSelection(null);
  }, []);
  const aiMessages = useMemo(() => answerChatEntries(asks.markers), [asks.markers]);
  const onToggleViewed = useCallback((path: string) => {
    setFileTicks((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    post({ type: "toggleFileReviewed", path });
  }, []);
  const onClickAIMarker = useCallback((id: string) => post({ type: "openAnswer", id }), []);

  const fontVars = useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const family = style.getPropertyValue("--vscode-editor-font-family").trim();
    const size = style.getPropertyValue("--vscode-editor-font-size").trim();
    return { family: family || undefined, size: size || undefined };
  }, []);

  const diffProps = useMemo<ReaderDiffProps>(
    () => ({
      fontFamily: fontVars.family,
      fontSize: fontVars.size,
      onTokenHoverEnter,
      onTokenHoverLeave,
      onCodeNavRequest,
      ...(init.askAgent && { onAskAIForFile }),
      aiMessages: [] as AIChatEntry[],
      onClickAIMarker,
      isAILoading: asks.busy,
      pendingSelection: null,
      onLineSelection: () => {},
      viewedFiles: fileTicks,
      onToggleViewed,
    }),
    [fontVars, onTokenHoverEnter, onTokenHoverLeave, onCodeNavRequest, onAskAIForFile, onClickAIMarker, asks.busy, init.askAgent, fileTicks, onToggleViewed],
  );
  // One selection handler per file, kept, so a file's diff does not see a new one on every render.
  const selectionHandlers = useRef(new Map<string, (range: SelectedLineRange | null) => void>());
  const selectionHandler = useCallback((path: string) => {
    let handler = selectionHandlers.current.get(path);
    if (!handler) {
      handler = (range) => setSelection((prev) => (range ? { path, range } : prev?.path === path ? null : prev));
      selectionHandlers.current.set(path, handler);
    }
    return handler;
  }, []);
  const markersByFile = useMemo(() => {
    const map = new Map<string, AIChatEntry[]>();
    for (const m of aiMessages) {
      const path = m.question.filePath ?? "";
      map.set(path, [...(map.get(path) ?? []), m]);
    }
    return map;
  }, [aiMessages]);
  const getDiffRendererProps = useCallback(
    ({ file }: { file: DiffFile }) => ({
      ...diffProps,
      aiMessages: markersByFile.get(file.path) ?? NO_MARKERS,
      pendingSelection: selection?.path === file.path ? selection.range : null,
      onLineSelection: selectionHandler(file.path),
    }),
    [diffProps, markersByFile, selection, selectionHandler],
  );

  const host = useMemo<GuideHostValue<ReaderDiffProps>>(
    () => ({
      files,
      DiffRenderer: ReaderDiffRenderer,
      getDiffRendererProps,
      revealFile,
      onRevealFile: reveal,
      renderFileActions: (file) => <FileActions file={file} />,
      renderOverviewDiagram: (diagram) =>
        diagram.kind === "mermaid" ? (
          <Suspense fallback={<pre className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-3 font-mono text-[11px] text-muted-foreground">{diagram.source}</pre>}>
            <OverviewDiagram source={diagram.source} onChapter={scrollToChapter} />
          </Suspense>
        ) : null,
      renderLink: (href, label, key) => {
        const symbol = href.startsWith("symbol:");
        if (!symbol && !href.startsWith("code:")) return null;
        return (
          <button
            key={key}
            type="button"
            className="text-primary underline-offset-2 hover:underline"
            title={symbol ? `Go to ${href.slice(7)}` : `Open ${href.slice(5)}`}
            onClick={() => post({ type: "link", href, action: symbol ? "definition" : "open" })}
          >
            {label}
          </button>
        );
      },
      renderSectionFooter: (index) =>
        index < snapshot.guide.sections.length ? (
          <ChapterAsk chapter={index} agent={asks.agent} busy={asks.busy} answers={asks.chapters.find((c) => c.chapter === index)?.items ?? []} />
        ) : null,
    }),
    [files, getDiffRendererProps, revealFile, reveal, snapshot.guide.sections.length, asks, scrollToChapter],
  );

  const onToggleReviewed = useCallback((index: number) => {
    setReviewed((prev) => prev.map((v, i) => (i === index ? !v : v)));
    post({ type: "toggleReviewed", chapter: index });
  }, []);

  const hoverData = hover.hover?.data as ReaderHoverData | undefined;

  return (
    <GuideHostProvider value={host}>
      <ChapterStrip
        title={init.title}
        label={init.label}
        chapters={snapshot.guide.sections.map((s, i) => ({ title: s.title, color: init.chapterColors[i] ?? "var(--primary)", reviewed: !!reviewed[i] }))}
        onChapter={(i) => {
          scrollToChapter(i);
          post({ type: "chapter", chapter: i });
        }}
        onOverview={() => {
          cancelDiffLineJump();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        back={back}
        onBack={() => {
          cancelDiffLineJump();
          if (back) window.scrollTo({ top: back.scrollY, behavior: "smooth" });
          setBack(null);
        }}
      />
      {notice && (
        <div className="pn-notice" role="status">
          {notice}
        </div>
      )}
      <div className="pn-reader-body min-h-screen bg-background text-foreground">
        <GuideView
          guide={guide}
          reviewed={reviewed}
          onToggleReviewed={onToggleReviewed}
          engineLabel={engineLabel(snapshot.generator?.engine, snapshot.generator?.model)}
          focusedFile={focusedFile}
          onFocusFile={setFocusedFile}
          sourceLine={init.changedSince.length ? <span>Changed on disk since the guide: {init.changedSince.join(", ")}</span> : undefined}
        />
      </div>
      {hover.hover && hoverData?.reader && (
        <TokenHoverCard
          hover={hover.hover}
          onPointerEnter={hover.onCardEnter}
          onPointerLeave={hover.onCardLeave}
          onSelectLocation={() => {}}
          content={
            <HoverCardContent
              answer={hoverData.reader.answer}
              at={hoverData.reader.at}
              mod={mod}
              onNavigate={(action: NavigateAction) => navigate(hoverData.reader.at, action)}
              onOpenDefinition={() => {
                const def = hoverData.reader.answer.definition;
                hover.close();
                if (def) post({ type: "openLocation", path: def.path, line: def.line, character: def.character, side: def.side ?? "new" });
              }}
            />
          }
        />
      )}
    </GuideHostProvider>
  );
}

const NO_MARKERS: AIChatEntry[] = [];

/** "Back to Chapter 2": where the reader is now, to come back to after a jump. */
function backHere(count: number): { label: string; scrollY: number } {
  const n = chapterInView(count);
  return { label: n >= 0 ? `Back to Chapter ${n + 1}` : "Back", scrollY: window.scrollY };
}

function stripHeight(): number {
  return (document.querySelector("[data-reader-strip]") as HTMLElement | null)?.offsetHeight ?? 0;
}

function FileActions({ file }: { file: DiffFile }) {
  const deleted = file.status === "deleted";
  return (
    <>
      {!deleted && (
        <button type="button" className="pn-file-action" title={`Open ${file.path} in an editor beside the guide`} onClick={() => post({ type: "openFile", path: file.path })}>
          <span className="codicon codicon-go-to-file" aria-hidden="true" />
          Open in editor
        </button>
      )}
      <button type="button" className="pn-file-action" title="Open this file's diff in VS Code's diff editor beside the guide" onClick={() => post({ type: "openDiff", path: file.path })}>
        <span className="codicon codicon-diff" aria-hidden="true" />
        Diff
      </button>
    </>
  );
}

export { viewState };
