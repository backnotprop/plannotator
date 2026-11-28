// Moved from the Workspaces app's MarkdownContentsRail (apps/web/src/plannotator/
// MarkdownContentsRail.tsx), the document contents rail approved 2026-10-03
// ("it should just be on the right side": the ticks in the document's right
// gutter, the Contents panel on click, no hover reveal, no Left/Right setting).
// The owner approved the move into @plannotator/ui on 2026-10-30 so the
// Plannotator Inbox can use it. Port:
// - Workspaces-only imports moved into the package: the shared parse memo
//   (utils/blockParse) and usePrefersReducedMotion (hooks/); `cn` had nothing
//   left to join once the `floating-surface` chrome and the EYEBROW title
//   became the rail's own
//   `pn-contents-rail-*` rules in theme.css, on the same tokens
//   (--popover, --shadow-menu, --geometry-floating-radius, ...) with fallbacks.
//   The `ws-markdown-contents-*` classes and `--ws-contents-*` properties are
//   `pn-contents-rail-*` and `--pn-contents-*`.
// - The rail's scroll math (cached heading tops, the binary search, the last
//   heading at the document's end, re-binding on DOM change, a pick marked at
//   once) moved as it was into utils/headingScrollSpy, so `DocumentContents`
//   uses it too; the activation line is 80 px (it was 52), plan review's
//   scroll offset, so a pick lands where plan review's does. DOM changes are
//   watched on the whole scroll element, so a re-rendered reading column is
//   re-bound too.
// - The headings come from `tocHeadings(blocks, 4)`.
// - Host seams, all optional (Workspaces passes none and is unchanged):
//   `blocks` (a host that parsed already), `contentSelector` (the reading
//   column), `hidden` + `onAvailableChange` (a host's own hide choice and
//   fallback), `panelAction` (one control in the open panel's title row).
// - Escape also closes a panel opened by pointer while focus stays outside
//   the rail (a tick press never takes focus), unless focus is in an editable
//   control, a dialog, a menu or a listbox. It is preventDefault-ed, not stopped: a host's own
//   Escape sees it was used.
// - The rules are the package's own stylesheet, contents-rail.css (import it
//   outside any CSS layer), not part of theme.css.
// - Annotation marks (owner-approved 2026-11, "dots beside each heading's
//   tick"), drawn only when a host passes `annotations` and
//   `onSelectAnnotation`: each row's section's dots beside its tick (three at
//   most, else two and a "more"), at the end of its row in the open panel
//   (seven, then "+N"), one dot per thread (a comment and its replies), a card
//   on hover or focus (kept inside the scroll element; Escape dismisses it), a
//   click selects through the host. Without them the rail's DOM is today's.
//   The arithmetic is utils/contentsRailMarks.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { AnnotationType, type Annotation, type Block } from '../types';
import { extractFrontmatter } from '../utils/parser';
import { parseBlocksShared } from '../utils/blockParse';
import {
  CONTENTS_RAIL_MAX_LEVEL,
  CONTENTS_RAIL_MIN_HEADINGS,
  CONTENTS_RAIL_MIN_PANE_WIDTH,
  tocHeadings,
} from '../utils/annotationHelpers';
import {
  CONTENTS_ACTIVATION_OFFSET,
  activeHeadingBinding,
  bindHeadings,
  topInsideViewport,
  type HeadingBinding,
} from '../utils/headingScrollSpy';
import { footnoteKeysOf, withoutFootnoteRefs } from '../utils/footnotes';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import {
  CONTENTS_RAIL_OPEN_MARK_WIDTH,
  contentsRailMarkName,
  contentsRailMoreWidth,
  groupContentsRailMarks,
  layoutContentsRailMarks,
  placeContentsRailMarks,
  type ContentsRailMarkPlace,
  type ContentsRailMarkRow,
  type ContentsRailRowMarks,
} from '../utils/contentsRailMarks';
import { isCurrentUser } from '../utils/identity';
import {
  ANNOTATION_QUOTE_CLASS,
  ANNOTATION_TEXT_CLASS,
  ANNOTATION_TYPE_COLOR,
  ANNOTATION_TYPE_LABEL,
  AnnotationCardByline,
} from './AnnotationCardParts';

const COLLAPSED_MARKER_LIMIT = 10;
const PANEL_WIDTH = 256;
const DOCK_WIDTH = 36;
const PANEL_GAP = 6;
const CONTENT_GAP = 24;
const VIEWPORT_EDGE_INSET = 8;
const MIN_RAIL_VIEWPORT_WIDTH = CONTENTS_RAIL_MIN_PANE_WIDTH;
const SMOOTH_SCROLL_SETTLE = 350;
const SCROLL_CORRECTION_THRESHOLD = 24;
/** The reading column, by default: the element Workspaces marks around its document. */
const DEFAULT_CONTENT_SELECTOR = '[data-document-read-content]';
const ROW_HEIGHT = 16;
/**
 * A closed-rail mark: a 5 px slot from 21 px into the dock (an H1 tick's line
 * ends at 20; on a row with marks a grown line stops there too), three to the
 * dock's edge. A row's marks take only their slots: the rest is the tick's.
 */
const CLOSED_MARK_START = 21;
const CLOSED_MARK_WIDTH = 5;
/** An open-panel mark: an 8 px slot; the row's marks end at the label's end, less its padding. */
const OPEN_MARKS_END = DOCK_WIDTH + PANEL_GAP + 8 + 4;
/** The mark card's gap from the open panel, and the narrowest it gets before it moves below (or above) its row. */
const CARD_GAP = 8;
const CARD_MIN_WIDTH = 192;
/**
 * The rendered highlights the marks are placed by: the highlighter's, the
 * manual ones, and a highlight covered by a later one (the highlighter moves
 * its id into `data-highlight-id-extra`, ids separated by `;`).
 */
const HIGHLIGHT_SELECTOR = '[data-bind-id], [data-highlight-id], [data-highlight-id-extra]';
const NO_ROWS: readonly ContentsRailMarkRow[] = [];
const NO_PLACES: ReadonlyMap<string, ContentsRailMarkPlace> = new Map();

function samePlaces(a: ReadonlyMap<string, ContentsRailMarkPlace>, b: ReadonlyMap<string, ContentsRailMarkPlace>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, place] of a) {
    const other = b.get(id);
    if (other === undefined || other.itemIndex !== place.itemIndex || other.order !== place.order) return false;
  }
  return true;
}

/** A roving stop: a tick, one of its row's marks, or its row's "more". */
type RailStop =
  | { readonly kind: 'tick'; readonly key: string; readonly index: number }
  | { readonly kind: 'mark'; readonly key: string; readonly index: number; readonly id: string }
  | { readonly kind: 'more'; readonly key: string; readonly index: number };

export interface MarkdownContentsItem {
  readonly key: string;
  readonly blockId: string;
  readonly label: string;
  readonly level: number;
  readonly breadcrumb: string;
  readonly excerpt: string | null;
}

interface RailGeometry {
  readonly left: number;
  readonly top: number;
}

export interface CondensedContentsMarker {
  readonly itemIndex: number;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

/** Place only the persistent marker dock in the document's existing right
 * padding, 24px right of the reading column (owner ruling 2026-10-03: the
 * rail returns to the right gutter it held from PR 76 until PR 241). The
 * Contents surface opens to the LEFT as an overlay, away from a docked
 * comments column, so this accessory never changes document width. `left`
 * is the dock's left edge. */
export function resolveContentsRailGeometry(
  viewportRight: number,
  contentRight: number,
  viewportTop: number,
  viewportHeight: number,
): RailGeometry {
  return {
    left: Math.min(
      Math.floor(viewportRight - VIEWPORT_EDGE_INSET - DOCK_WIDTH),
      Math.floor(contentRight + CONTENT_GAP),
    ),
    top: Math.round(viewportTop + viewportHeight / 2),
  };
}

/** Keep the rail out of compact document panes and require a complete marker
 * lane in the document's existing right padding. The pane's right edge is the
 * docked comments (or people) column's edge when one is open, so the rail
 * yields to the column instead of overlapping it or its resize edge. The
 * panel itself may still overlay the prose once the marker lane qualifies. */
export function canShowContentsRail(
  viewportWidth: number,
  viewportRight: number,
  contentRight: number,
): boolean {
  return (
    viewportWidth >= MIN_RAIL_VIEWPORT_WIDTH &&
    viewportRight - contentRight >= VIEWPORT_EDGE_INSET + DOCK_WIDTH + CONTENT_GAP
  );
}

function plainText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, target: string, label?: string) => label ?? target,
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptAfterHeading(blocks: readonly Block[], headingIndex: number): string | null {
  for (let index = headingIndex + 1; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type === 'heading') return null;
    if (block.type === 'code' || block.type === 'html' || block.type === 'hr') continue;
    const text = plainText(block.content);
    if (text.length === 0) continue;
    return text.length > 180 ? `${text.slice(0, 177).trimEnd()}…` : text;
  }
  return null;
}

function buildContentsItems(blocks: readonly Block[]): readonly MarkdownContentsItem[] {
  const listed = new Set(tocHeadings(blocks, CONTENTS_RAIL_MAX_LEVEL));
  const parents: Array<{ level: number; label: string }> = [];
  const items: MarkdownContentsItem[] = [];
  const notes = footnoteKeysOf(blocks);

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.type !== 'heading' || !listed.has(block)) continue;
    const level = Math.min(6, Math.max(1, block.level ?? 1));
    const label = plainText(withoutFootnoteRefs(block.content, notes)) || 'Untitled section';
    while (parents.length > 0 && parents.at(-1)!.level >= level) parents.pop();
    const breadcrumb = [...parents.map((entry) => entry.label), label].join(' / ');
    items.push({
      key: block.id,
      blockId: block.id,
      label,
      level,
      breadcrumb,
      excerpt: excerptAfterHeading(blocks, index),
    });
    parents.push({ level, label });
  }

  return items;
}

function markdownBlocks(markdown: string): Block[] {
  return parseBlocksShared(extractFrontmatter(markdown).content);
}

/**
 * Build the semantic index from the same cached parse the Viewer consumes.
 * DOM binding happens later, after the package has assigned its duplicate-safe
 * heading anchors. Scroll never reparses or searches the document.
 */
export function buildMarkdownContentsModel(markdown: string): readonly MarkdownContentsItem[] {
  return buildContentsItems(markdownBlocks(markdown));
}

/**
 * Divide a long document into ten ordered spans, then represent each span with
 * its shallowest heading nearest the span midpoint. This is one O(n) pass when
 * the Markdown model changes; scroll updates only map the active index to a
 * slot with arithmetic.
 */
export function condenseMarkdownContentsMarkers(
  items: readonly MarkdownContentsItem[],
): readonly CondensedContentsMarker[] {
  if (items.length <= COLLAPSED_MARKER_LIMIT) {
    return items.map((_, itemIndex) => ({
      itemIndex,
      rangeStart: itemIndex,
      rangeEnd: itemIndex,
    }));
  }

  return Array.from({ length: COLLAPSED_MARKER_LIMIT }, (_, slotIndex) => {
    const rangeStart = Math.ceil((slotIndex * items.length) / COLLAPSED_MARKER_LIMIT);
    const rangeEnd = Math.ceil(((slotIndex + 1) * items.length) / COLLAPSED_MARKER_LIMIT) - 1;
    const midpoint = (rangeStart + rangeEnd) / 2;
    let itemIndex = rangeStart;

    for (let candidateIndex = rangeStart + 1; candidateIndex <= rangeEnd; candidateIndex++) {
      const candidate = items[candidateIndex];
      const current = items[itemIndex];
      if (
        candidate.level < current.level ||
        (candidate.level === current.level &&
          Math.abs(candidateIndex - midpoint) < Math.abs(itemIndex - midpoint))
      ) {
        itemIndex = candidateIndex;
      }
    }

    return { itemIndex, rangeStart, rangeEnd };
  });
}

function condensedSlotForItem(itemIndex: number, itemCount: number, slotCount: number): number {
  if (itemCount <= 0 || slotCount <= 1) return 0;
  const boundedIndex = Math.min(itemCount - 1, Math.max(0, itemIndex));
  return Math.min(slotCount - 1, Math.floor((boundedIndex * slotCount) / itemCount));
}

/** Focus in an editable control, a dialog, a menu or a listbox: its Escape is its own. */
function ownsEscape(element: HTMLElement): boolean {
  return (
    element.isContentEditable ||
    element.closest('input, textarea, select, [role="dialog"], dialog, [role="menu"], [role="listbox"]') !== null
  );
}

function setViewportScroll(viewport: HTMLElement, top: number, behavior: ScrollBehavior): void {
  viewport.scrollTo({ top: Math.max(0, top), behavior });
}

export interface MarkdownContentsRailProps {
  /** The document's Markdown (frontmatter is skipped). Ignored when `blocks` is given. */
  readonly markdown?: string;
  /** The document's parsed blocks, for a host that already has them (the Viewer's). */
  readonly blocks?: readonly Block[];
  /** The element the document scrolls in; the rail sits in its right gutter. */
  readonly scrollViewport: HTMLElement | null;
  /** Unused by the rail; kept so Workspaces' call site compiles unchanged. */
  readonly documentPath?: string;
  /**
   * The reading column inside `scrollViewport`: the dock goes 24 px right of
   * its right edge. Default `[data-document-read-content]` (Workspaces). The
   * Plannotator Inbox passes the Viewer's `[data-doc-text-root]`.
   */
  readonly contentSelector?: string;
  /**
   * The host's own hide choice: the rail keeps measuring (so
   * `onAvailableChange` still reports) but draws nothing. Default false.
   */
  readonly hidden?: boolean;
  /**
   * Whether the rail can show: enough headings, a pane at least 480 px wide
   * and a 68 px gutter. Called when it changes, so a host can offer its own
   * way to Contents when the rail yields.
   */
  readonly onAvailableChange?: (available: boolean) => void;
  /**
   * One host control drawn at the right of the open panel's "Contents" title
   * (the Inbox's Hide). Shown only while the panel is open; Tab reaches it
   * after the headings. Default: none.
   */
  readonly panelAction?: ReactNode;
  /**
   * The fewest headings (levels 1 to 4) the rail shows for. Default
   * `CONTENTS_RAIL_MIN_HEADINGS` (4); the Plannotator Inbox passes 2.
   */
  readonly minHeadings?: number;
  /**
   * The document's annotations, drawn as marks beside the ticks (and at the
   * end of each open-panel row) when `onSelectAnnotation` is given too. Each
   * is placed by its rendered highlight (`[data-bind-id]` /
   * `[data-highlight-id]`, or `[data-highlight-id-extra]` when a later one
   * covers it); a global comment goes on the first row; a comment and its
   * replies are one mark, the comment's. Default: none (no marks: the rail is
   * drawn as without the prop).
   */
  readonly annotations?: readonly Annotation[];
  /** The selected annotation: its thread's mark is drawn selected (`aria-current`). Default none. */
  readonly selectedAnnotationId?: string | null;
  /**
   * Called with an annotation's id when its mark is clicked or pressed (Enter,
   * Space): the host selects it as its annotation panel does. The marks are
   * drawn only when it is given. Default: none.
   */
  readonly onSelectAnnotation?: (id: string) => void;
}

export function MarkdownContentsRail({
  markdown = '',
  blocks: hostBlocks,
  scrollViewport,
  contentSelector = DEFAULT_CONTENT_SELECTOR,
  hidden = false,
  onAvailableChange,
  panelAction,
  minHeadings = CONTENTS_RAIL_MIN_HEADINGS,
  annotations,
  selectedAnnotationId = null,
  onSelectAnnotation,
}: MarkdownContentsRailProps) {
  const items = useMemo(
    () => buildContentsItems(hostBlocks ?? markdownBlocks(markdown)),
    [hostBlocks, markdown],
  );
  const reducedMotion = usePrefersReducedMotion();
  // null until the first measure: nothing is reported before the rail knows.
  const [available, setAvailable] = useState<boolean | null>(null);
  const [interactionIndex, setInteractionIndex] = useState<number | null>(null);
  const [titlesVisible, setTitlesVisible] = useState(false);
  const [railGeometry, setRailGeometry] = useState<RailGeometry>({
    left: VIEWPORT_EDGE_INSET,
    top: 0,
  });
  const [activeIndex, setActiveIndex] = useState(0);
  const visible = available === true && !hidden;
  const condensedMarkers = useMemo(() => condenseMarkdownContentsMarkers(items), [items]);
  const safeActiveIndex = Math.min(Math.max(0, activeIndex), Math.max(0, items.length - 1));
  const collapsedActiveSlot = condensedSlotForItem(
    safeActiveIndex,
    items.length,
    condensedMarkers.length,
  );
  const renderedItemIndexes = useMemo(
    () =>
      titlesVisible
        ? items.map((_, itemIndex) => itemIndex)
        : condensedMarkers.map((marker, slotIndex) =>
            slotIndex === collapsedActiveSlot ? safeActiveIndex : marker.itemIndex,
          ),
    [collapsedActiveSlot, condensedMarkers, items, safeActiveIndex, titlesVisible],
  );
  const activeIndexRef = useRef(0);
  const bindingsRef = useRef<readonly HeadingBinding[]>([]);
  const markerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLElement | null>(null);
  const actionRef = useRef<HTMLDivElement | null>(null);
  const activeFrameRef = useRef<number | null>(null);
  const measureFrameRef = useRef<number | null>(null);
  const correctionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbingRef = useRef(false);
  const scrubbedIndexRef = useRef<number | null>(null);
  const onAvailableChangeRef = useRef(onAvailableChange);
  onAvailableChangeRef.current = onAvailableChange;
  const blockIds = useMemo(() => items.map((item) => item.blockId), [items]);
  // Annotation marks: only when the host gives annotations and a way to select one.
  const markAnnotations =
    onSelectAnnotation !== undefined && annotations !== undefined && annotations.length > 0 ? annotations : null;
  const markAnnotationsRef = useRef(markAnnotations);
  markAnnotationsRef.current = markAnnotations;
  const [markPlaces, setMarkPlaces] = useState<ReadonlyMap<string, ContentsRailMarkPlace>>(NO_PLACES);
  const [hoveredMarkId, setHoveredMarkId] = useState<string | null>(null);
  const [focusedMarkId, setFocusedMarkId] = useState<string | null>(null);
  const stopRefs = useRef(new Map<string, HTMLElement>());
  const stopRefCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const marksLayerRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** The marks by thread and section: once per measure (or annotations change), never on scroll. */
  const markGroups = useMemo(
    () => (markAnnotations === null ? null : groupContentsRailMarks(markAnnotations, markPlaces)),
    [markAnnotations, markPlaces],
  );
  /** The rows' spans: the closed rail's sampled ones, or each item. Not the active heading's: a row's marks do not move with it. */
  const markRows = useMemo<readonly ContentsRailMarkRow[]>(
    () =>
      markGroups === null
        ? NO_ROWS
        : titlesVisible
          ? items.map((_, itemIndex) => ({ rangeStart: itemIndex, rangeEnd: itemIndex }))
          : condensedMarkers,
    [condensedMarkers, items, markGroups, titlesVisible],
  );
  /** Each rendered row's marks (null: none to draw, the rail as without them). */
  const rowMarks = useMemo<readonly ContentsRailRowMarks[] | null>(() => {
    if (markGroups === null) return null;
    const laid = layoutContentsRailMarks(markRows, markGroups, titlesVisible);
    return laid.some((row) => row.total > 0) ? laid : null;
  }, [markGroups, markRows, titlesVisible]);
  const shownMarks = useMemo(
    () => new Map(rowMarks?.flatMap((row) => row.shown.map((annotation) => [annotation.id, annotation] as const)) ?? []),
    [rowMarks],
  );
  const selectedMarkId =
    selectedAnnotationId === null ? null : (markGroups?.rootOf.get(selectedAnnotationId) ?? selectedAnnotationId);
  /** The roving order: each tick, then its row's marks and its "more". Ticks only without marks. */
  const stops = useMemo<readonly RailStop[]>(
    () =>
      renderedItemIndexes.flatMap((index, position): RailStop[] => {
        const tick: RailStop = { kind: 'tick', key: `tick:${index}`, index };
        const marks = rowMarks?.[position];
        if (marks === undefined || marks.total === 0) return [tick];
        return [
          tick,
          ...marks.shown.map((annotation): RailStop => ({ kind: 'mark', key: `mark:${annotation.id}`, index, id: annotation.id })),
          ...(marks.more > 0 ? [{ kind: 'more', key: `more:${index}`, index } as RailStop] : []),
        ];
      }),
    [renderedItemIndexes, rowMarks],
  );
  /** One ref callback per stop, kept: a re-render (a row hovered) never detaches and re-attaches them. */
  const stopRef = useCallback((key: string) => {
    let callback = stopRefCallbacks.current.get(key);
    if (callback === undefined) {
      const tick = key.startsWith('tick:') ? Number(key.slice(5)) : null;
      callback = (node: HTMLElement | null) => {
        // A detach after the stop's new node attached (it moved) keeps the new one.
        if (node === null && stopRefs.current.get(key)?.isConnected === true) return;
        if (node === null) stopRefs.current.delete(key);
        else stopRefs.current.set(key, node);
        if (tick !== null) markerRefs.current[tick] = node as HTMLButtonElement | null;
      };
      stopRefCallbacks.current.set(key, callback);
    }
    return callback;
  }, []);
  // A focused dot that is no longer focused (removed without a blur, as when
  // the panel opens and the dots move) is not one.
  const liveFocusedMarkId =
    focusedMarkId !== null &&
    typeof document !== 'undefined' &&
    document.activeElement instanceof HTMLElement &&
    document.activeElement.dataset.markId === focusedMarkId
      ? focusedMarkId
      : null;
  // The card: the hovered (else the focused) dot's annotation, while that dot is drawn.
  const cardMarkId = hoveredMarkId ?? liveFocusedMarkId;
  const cardAnnotation = cardMarkId === null ? undefined : shownMarks.get(cardMarkId);

  const commitActiveIndex = useCallback((next: number) => {
    if (activeIndexRef.current === next) return;
    activeIndexRef.current = next;
    setActiveIndex(next);
  }, []);

  const refreshActiveSection = useCallback(() => {
    if (scrollViewport === null) return;
    // No binding (nothing drawn yet): the index stays.
    const binding = activeHeadingBinding(bindingsRef.current, scrollViewport);
    if (binding !== null) commitActiveIndex(binding.itemIndex);
  }, [commitActiveIndex, scrollViewport]);

  const scheduleActiveRefresh = useCallback(() => {
    if (activeFrameRef.current !== null) return;
    activeFrameRef.current = requestAnimationFrame(() => {
      activeFrameRef.current = null;
      refreshActiveSection();
    });
  }, [refreshActiveSection]);

  const measure = useCallback(() => {
    if (scrollViewport === null || items.length < minHeadings) {
      bindingsRef.current = [];
      setAvailable(false);
      return;
    }

    const bindings = bindHeadings(scrollViewport, blockIds);
    bindingsRef.current = bindings;
    // Each annotation's section, from its first rendered highlight (measured
    // here, on the rail's own triggers; scrolling never measures).
    const marked = markAnnotationsRef.current;
    if (marked === null) {
      setMarkPlaces((current) => (current.size === 0 ? current : NO_PLACES));
    } else {
      const highlights: Array<{ id: string; node: HTMLElement }> = [];
      for (const node of scrollViewport.querySelectorAll<HTMLElement>(HIGHLIGHT_SELECTOR)) {
        const id = node.dataset.bindId ?? node.dataset.highlightId;
        if (id) highlights.push({ id, node });
        for (const covered of node.dataset.highlightIdExtra?.split(';') ?? []) {
          if (covered) highlights.push({ id: covered, node });
        }
      }
      const places = placeContentsRailMarks(
        bindings.map((binding) => binding.node),
        bindings.map((binding) => binding.itemIndex),
        highlights,
        new Set(marked.map((annotation) => annotation.id)),
      );
      setMarkPlaces((current) => (samePlaces(current, places) ? current : places));
    }

    const viewportRect = scrollViewport.getBoundingClientRect();
    // The scroll surface's own scrollbar sits in the right gutter: measure
    // the lane up to the scrollbar, never under it.
    const scrollbarWidth =
      scrollViewport.clientWidth > 0
        ? Math.max(
            0,
            scrollViewport.offsetWidth - scrollViewport.clientWidth - scrollViewport.clientLeft,
          )
        : 0;
    const viewportRight = viewportRect.right - scrollbarWidth;
    const content = scrollViewport.querySelector<HTMLElement>(contentSelector);
    const contentRect = content?.getBoundingClientRect();
    const hasRailSpace =
      contentRect !== undefined &&
      canShowContentsRail(viewportRect.width, viewportRight, contentRect.right);
    const geometry = resolveContentsRailGeometry(
      viewportRight,
      contentRect?.right ?? viewportRight - VIEWPORT_EDGE_INSET - DOCK_WIDTH - CONTENT_GAP,
      viewportRect.top,
      viewportRect.height,
    );
    setRailGeometry((current) =>
      current.left === geometry.left && current.top === geometry.top ? current : geometry,
    );
    setAvailable(bindings.length >= minHeadings && hasRailSpace);
    refreshActiveSection();
  }, [blockIds, contentSelector, items.length, minHeadings, refreshActiveSection, scrollViewport]);

  const scheduleMeasure = useCallback(() => {
    if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
    measureFrameRef.current = requestAnimationFrame(() => {
      measureFrameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    activeIndexRef.current = 0;
    setActiveIndex(0);
    setInteractionIndex(null);
    setTitlesVisible(false);
    setHoveredMarkId(null);
    setFocusedMarkId(null);
  }, [items]);

  // New or changed annotations: place them again (their highlights' own DOM
  // changes are caught by the mutation observer below).
  useEffect(() => {
    if (markAnnotations !== null) scheduleMeasure();
  }, [markAnnotations, scheduleMeasure]);

  useEffect(() => {
    if (available !== null) onAvailableChangeRef.current?.(available);
  }, [available]);

  useEffect(() => {
    if (scrollViewport === null || items.length < minHeadings) {
      setAvailable(false);
      return;
    }

    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(measure);
    });
    scrollViewport.addEventListener('scroll', scheduleActiveRefresh, { passive: true });
    scrollViewport.addEventListener('load', scheduleMeasure, true);
    window.addEventListener('resize', scheduleMeasure);

    // The reading column is observed for size; a host that re-renders it (a
    // new element) is followed through the mutation observer below.
    let observedContent: HTMLElement | null = null;
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    const followContent = () => {
      const content = scrollViewport.querySelector<HTMLElement>(contentSelector);
      if (content === observedContent) return;
      if (observedContent !== null) resizeObserver?.unobserve(observedContent);
      observedContent = content;
      if (content !== null) resizeObserver?.observe(content);
    };
    resizeObserver?.observe(scrollViewport);
    followContent();

    // Any change to the document's elements re-binds the headings (an edit
    // can replace them and keep their count), except the rail's own.
    const mutationObserver =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            const rail = railRef.current;
            if (rail !== null && records.every((record) => rail.contains(record.target))) return;
            followContent();
            scheduleMeasure();
          });
    mutationObserver?.observe(scrollViewport, { childList: true, subtree: true });

    const fonts = typeof document === 'undefined' ? undefined : document.fonts;
    if (fonts !== undefined) void fonts.ready.then(scheduleMeasure);

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      if (activeFrameRef.current !== null) cancelAnimationFrame(activeFrameRef.current);
      if (measureFrameRef.current !== null) cancelAnimationFrame(measureFrameRef.current);
      scrollViewport.removeEventListener('scroll', scheduleActiveRefresh);
      scrollViewport.removeEventListener('load', scheduleMeasure, true);
      window.removeEventListener('resize', scheduleMeasure);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [contentSelector, items.length, measure, minHeadings, scheduleActiveRefresh, scheduleMeasure, scrollViewport]);

  useEffect(() => {
    const list = listRef.current;
    const marker = markerRefs.current[activeIndex];
    if (!visible || !titlesVisible || list === null || marker === null || marker === undefined)
      return;
    const markerTop = marker.offsetTop;
    const markerBottom = markerTop + marker.offsetHeight;
    if (markerTop < list.scrollTop) {
      list.scrollTop = markerTop;
    } else if (markerBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = markerBottom - list.clientHeight;
    }
  }, [activeIndex, titlesVisible, visible]);

  useEffect(
    () => () => {
      if (correctionTimerRef.current !== null) clearTimeout(correctionTimerRef.current);
    },
    [],
  );

  // Opening or closing the panel moves the dots (a focused one is removed
  // without a blur): neither a hovered nor a focused dot is kept.
  const closeTitles = useCallback(() => {
    setTitlesVisible(false);
    setInteractionIndex(null);
    setHoveredMarkId(null);
    setFocusedMarkId(null);
  }, []);

  // The rail hidden or yielding: no dot is hovered or focused.
  useEffect(() => {
    if (visible) return;
    setHoveredMarkId(null);
    setFocusedMarkId(null);
  }, [visible]);

  // A hover card (the closed rail's; the open panel's Escape closes the whole
  // panel) is dismissed by Escape without moving the pointer. Only while one
  // is up, and not while focus outside the rail owns its Escape; preventDefault,
  // never stopPropagation, as the panel's.
  useEffect(() => {
    if (titlesVisible || hoveredMarkId === null) return;
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const focused = document.activeElement;
      const inRail = focused instanceof Node && railRef.current?.contains(focused) === true;
      if (!inRail && focused instanceof HTMLElement && ownsEscape(focused)) return;
      event.preventDefault();
      setHoveredMarkId(null);
    };
    window.addEventListener('keydown', dismissOnEscape, true);
    return () => window.removeEventListener('keydown', dismissOnEscape, true);
  }, [hoveredMarkId, titlesVisible]);

  useEffect(() => {
    if (!titlesVisible) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && railRef.current?.contains(target)) return;
      closeTitles();
    };
    // Escape closes a panel opened by pointer, where focus stayed outside the
    // rail (a tick press never takes focus). Not while focus is in an editable
    // control, a dialog, a menu or a listbox: that Escape is theirs. preventDefault, never
    // stopPropagation, so a host's own Escape (a full-screen view's) sees it was used.
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const focused = document.activeElement;
      const inRail = focused instanceof Node && railRef.current?.contains(focused) === true;
      if (!inRail && focused instanceof HTMLElement && ownsEscape(focused)) return;
      event.preventDefault();
      if (inRail && focused instanceof HTMLElement) focused.blur();
      closeTitles();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointerDown, true);
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointerDown, true);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [closeTitles, titlesVisible]);

  const highlightHeading = useCallback(
    (node: HTMLElement) => {
      if (reducedMotion || typeof node.animate !== 'function') return;
      node.animate(
        [
          { backgroundColor: 'color-mix(in oklch, var(--primary) 16%, transparent)' },
          { backgroundColor: 'transparent' },
        ],
        { duration: 1400, easing: 'ease-out' },
      );
    },
    [reducedMotion],
  );

  const navigateTo = useCallback(
    (itemIndex: number, scrubbing: boolean) => {
      if (scrollViewport === null) return;
      const binding = bindingsRef.current.find((entry) => entry.itemIndex === itemIndex);
      if (binding === undefined) return;
      const behavior: ScrollBehavior = reducedMotion || scrubbing ? 'auto' : 'smooth';
      const targetTop = topInsideViewport(binding.node, scrollViewport) - CONTENTS_ACTIVATION_OFFSET;
      setViewportScroll(scrollViewport, targetTop, behavior);
      commitActiveIndex(itemIndex);
      setInteractionIndex(itemIndex);

      if (correctionTimerRef.current !== null) clearTimeout(correctionTimerRef.current);
      correctionTimerRef.current = setTimeout(
        () => {
          const correctedTop =
            topInsideViewport(binding.node, scrollViewport) - CONTENTS_ACTIVATION_OFFSET;
          if (Math.abs(scrollViewport.scrollTop - correctedTop) > SCROLL_CORRECTION_THRESHOLD) {
            setViewportScroll(scrollViewport, correctedTop, 'auto');
          }
          highlightHeading(binding.node);
        },
        behavior === 'smooth' ? SMOOTH_SCROLL_SETTLE : 0,
      );
    },
    [commitActiveIndex, highlightHeading, reducedMotion, scrollViewport],
  );

  const openTitles = useCallback((index: number) => {
    setInteractionIndex(index);
    setTitlesVisible(true);
    setHoveredMarkId(null);
    setFocusedMarkId(null);
  }, []);

  const scrubAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY);
      const marker = target?.closest<HTMLElement>('[data-contents-index]');
      if (marker === null || marker === undefined) return;
      const index = Number(marker.dataset.contentsIndex);
      if (!Number.isInteger(index) || scrubbedIndexRef.current === index) return;
      scrubbedIndexRef.current = index;
      navigateTo(index, true);
    },
    [navigateTo],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
      if (!titlesVisible) {
        event.preventDefault();
        openTitles(index);
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      scrubbingRef.current = true;
      scrubbedIndexRef.current = index;
      navigateTo(index, true);
    },
    [navigateTo, openTitles, titlesVisible],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!scrubbingRef.current) return;
      scrubAtPoint(event.clientX, event.clientY);
    },
    [scrubAtPoint],
  );

  const endScrub = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    scrubbingRef.current = false;
    scrubbedIndexRef.current = null;
  }, []);

  const onStopKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, stop: RailStop) => {
      const position = stops.findIndex((entry) => entry.key === stop.key);
      let nextPosition: number | null = null;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTitles();
        event.currentTarget.blur();
        return;
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        nextPosition = Math.min(stops.length - 1, position + 1);
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        nextPosition = Math.max(0, position - 1);
      } else if (event.key === 'Home') {
        nextPosition = 0;
      } else if (event.key === 'End') {
        nextPosition = stops.length - 1;
      } else if ((event.key === 'Enter' || event.key === ' ') && stop.kind === 'tick') {
        event.preventDefault();
        if (!titlesVisible) {
          openTitles(stop.index);
          return;
        }
        navigateTo(stop.index, false);
        return;
      }
      // A mark's or a "more"'s Enter and Space are its button's own click.
      if (nextPosition === null || position < 0) return;
      event.preventDefault();
      const next = stops[nextPosition];
      if (next !== undefined) stopRefs.current.get(next.key)?.focus();
    },
    [closeTitles, navigateTo, openTitles, stops, titlesVisible],
  );

  /** A closed row's "more": the panel opens at that row (and a keyboard user lands on its tick). */
  const openAtRow = useCallback(
    (index: number, fromKeyboard: boolean) => {
      openTitles(index);
      requestAnimationFrame(() => {
        const list = listRef.current;
        const marker = markerRefs.current[index];
        if (list === null || marker === null || marker === undefined) return;
        if (marker.offsetTop < list.scrollTop) list.scrollTop = marker.offsetTop;
        else if (marker.offsetTop + marker.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = marker.offsetTop + marker.offsetHeight - list.clientHeight;
        }
        if (fromKeyboard) marker.focus();
      });
    },
    [openTitles],
  );

  // The mark card: level with its mark, where the closed panel would be (or
  // left of the open panel), kept inside the scroll element. Short of room
  // on the left, it narrows (to CARD_MIN_WIDTH, never past the scroll
  // element's left edge); shorter still, it goes below its row (else above).
  useLayoutEffect(() => {
    const card = cardRef.current;
    const nav = railRef.current;
    if (card === null || nav === null || cardMarkId === null) return;
    const mark = stopRefs.current.get(`mark:${cardMarkId}`);
    if (mark === undefined) return;
    const navRect = nav.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    const bounds = scrollViewport?.getBoundingClientRect();
    const boundsLeft = (bounds?.left ?? 0) + VIEWPORT_EDGE_INSET;
    const boundsRight = (bounds?.right ?? window.innerWidth) - VIEWPORT_EDGE_INSET;
    const minTop = (bounds?.top ?? 0) + VIEWPORT_EDGE_INSET;
    const maxBottom = (bounds?.bottom ?? window.innerHeight) - VIEWPORT_EDGE_INSET;
    // The card ends where the closed panel would end, or a gap left of the open one.
    const end = titlesVisible ? navRect.left - CARD_GAP : navRect.left + PANEL_WIDTH;
    const room = end - boundsLeft;
    let left: number;
    let width: number;
    let top: number;
    if (room >= CARD_MIN_WIDTH) {
      width = Math.min(PANEL_WIDTH, room);
      left = end - width;
      card.style.width = width === PANEL_WIDTH ? '' : `${width}px`;
      // The card's first line (its kind) level with the mark.
      const wanted = markRect.top + markRect.height / 2 - 19;
      top = Math.max(minTop, Math.min(maxBottom - card.offsetHeight, wanted));
    } else {
      width = Math.max(0, Math.min(PANEL_WIDTH, boundsRight - boundsLeft));
      left = Math.max(boundsLeft, Math.min(boundsRight - width, markRect.right - width));
      card.style.width = width === PANEL_WIDTH ? '' : `${width}px`;
      const below = markRect.bottom + PANEL_GAP;
      top =
        below + card.offsetHeight <= maxBottom
          ? below
          : Math.max(minTop, markRect.top - PANEL_GAP - card.offsetHeight);
    }
    card.style.left = `${Math.round(left - navRect.left)}px`;
    card.style.top = `${Math.round(top - navRect.top)}px`;
  }, [cardMarkId, railGeometry, rowMarks, scrollViewport, titlesVisible]);

  /** Focus left the panel (its list, and the host's action): the panel closes. */
  const closeWhenFocusLeaves = useCallback(
    (relatedTarget: EventTarget | null) => {
      const inPanel =
        relatedTarget instanceof Node &&
        (listRef.current?.contains(relatedTarget) === true ||
          marksLayerRef.current?.contains(relatedTarget) === true ||
          actionRef.current?.contains(relatedTarget) === true);
      if (!inPanel) closeTitles();
    },
    [closeTitles],
  );

  if (!visible) return null;
  const baseLevel = Math.min(...items.map((item) => item.level));
  const railStyle = {
    // The nav box is [panel][gap][dock]; its left edge sits a panel and a
    // gap left of the dock so the surface opens over the prose margin.
    left: `${railGeometry.left - PANEL_GAP - PANEL_WIDTH}px`,
    top: `${railGeometry.top}px`,
    '--pn-contents-dock-width': `${DOCK_WIDTH}px`,
    '--pn-contents-panel-gap': `${PANEL_GAP}px`,
    '--pn-contents-panel-width': `${PANEL_WIDTH}px`,
  } as CSSProperties;

  // The marks: closed, in a layer over the dock beside each tick's line; open,
  // inside the list (they scroll with their rows) at the end of each row. They
  // come after every tick, so the ticks stay adjacent siblings (the lens rules).
  const markButtons: ReactNode[] = [];
  const labelPadding = new Map<number, number>();
  if (rowMarks !== null) {
    renderedItemIndexes.forEach((index, position) => {
      const marks = rowMarks[position];
      const item = items[index];
      if (marks === undefined || marks.total === 0 || item === undefined) return;
      const top = position * ROW_HEIGHT;
      const openMoreWidth = marks.more > 0 ? contentsRailMoreWidth(marks.more) : 0;
      // Closed: 5 px slots from 21 px into the dock (the rest of the row is the
      // tick's). Open: 8 px slots, then the "+N" sized to its digits, at the
      // row's end. Logical, as the label's padding that makes room for them.
      const place = (slot: number): CSSProperties => {
        if (titlesVisible) {
          return slot < marks.shown.length
            ? {
                insetInlineEnd: OPEN_MARKS_END + openMoreWidth + (marks.shown.length - 1 - slot) * CONTENTS_RAIL_OPEN_MARK_WIDTH,
                width: CONTENTS_RAIL_OPEN_MARK_WIDTH,
              }
            : { insetInlineEnd: OPEN_MARKS_END, width: openMoreWidth };
        }
        return { insetInlineEnd: DOCK_WIDTH - CLOSED_MARK_START - (slot + 1) * CLOSED_MARK_WIDTH, width: CLOSED_MARK_WIDTH };
      };
      if (titlesVisible) labelPadding.set(index, 4 + openMoreWidth + marks.shown.length * CONTENTS_RAIL_OPEN_MARK_WIDTH + 6);
      marks.shown.forEach((annotation, slot) => {
        const id = annotation.id;
        const stop: RailStop = { kind: 'mark', key: `mark:${id}`, index, id };
        const kind =
          annotation.type === AnnotationType.DELETION
            ? 'deletion'
            : annotation.type === AnnotationType.GLOBAL_COMMENT
              ? 'global'
              : 'comment';
        markButtons.push(
          <button
            key={stop.key}
            ref={stopRef(stop.key)}
            type="button"
            className="pn-contents-rail-mark"
            data-kind={kind}
            data-mark-id={id}
            data-row={index}
            data-selected={id === selectedMarkId ? '' : undefined}
            data-highlighted={id === cardMarkId ? '' : undefined}
            aria-label={contentsRailMarkName(annotation)}
            aria-current={id === selectedMarkId ? 'true' : undefined}
            tabIndex={-1}
            style={{ top, height: ROW_HEIGHT, ...place(slot) }}
            onPointerEnter={(event) => {
              if (event.pointerType === 'touch') return;
              setHoveredMarkId(id);
              if (titlesVisible) setInteractionIndex(index);
            }}
            onPointerLeave={() => setHoveredMarkId((current) => (current === id ? null : current))}
            // A press never takes focus (as a tick's): the card follows the pointer.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              setHoveredMarkId(null);
              onSelectAnnotation?.(id);
            }}
            onFocus={() => {
              setFocusedMarkId(id);
              if (titlesVisible) setInteractionIndex(index);
            }}
            onBlur={(event) => {
              setFocusedMarkId((current) => (current === id ? null : current));
              if (titlesVisible) closeWhenFocusLeaves(event.relatedTarget);
            }}
            onKeyDown={(event) => onStopKeyDown(event, stop)}
          />,
        );
      });
      if (marks.more > 0) {
        const stop: RailStop = { kind: 'more', key: `more:${index}`, index };
        markButtons.push(
          <button
            key={stop.key}
            ref={stopRef(stop.key)}
            type="button"
            className="pn-contents-rail-more"
            data-row={index}
            // Open, it goes to the row's heading: named as the row's tick is, with the count.
            aria-label={
              titlesVisible
                ? `Go to ${item.breadcrumb}, ${marks.more} more ${marks.more === 1 ? 'annotation' : 'annotations'}`
                : `${marks.more} more ${marks.more === 1 ? 'annotation' : 'annotations'} in ${item.label}`
            }
            tabIndex={-1}
            style={{ top, height: ROW_HEIGHT, ...place(marks.shown.length) }}
            onPointerEnter={(event) => {
              if (titlesVisible && event.pointerType !== 'touch') setInteractionIndex(index);
            }}
            onPointerDown={(event) => event.preventDefault()}
            // Closed: the panel opens at this row. Open: the row's heading, as a pick.
            onClick={(event) => (titlesVisible ? navigateTo(index, false) : openAtRow(index, event.detail === 0))}
            onFocus={() => {
              if (titlesVisible) setInteractionIndex(index);
            }}
            onBlur={(event) => {
              if (titlesVisible) closeWhenFocusLeaves(event.relatedTarget);
            }}
            onKeyDown={(event) => onStopKeyDown(event, stop)}
          >
            {titlesVisible ? `+${marks.more}` : null}
          </button>,
        );
      }
    });
  }

  // Layering: the rail is document chrome and renders in place, inside the
  // document pane, not portalled to <body>. A host keeps the pane its own
  // stacking context (an `isolate` ancestor) at the document level, so the
  // host's floaters and overlays cover the rail, and inside the pane the
  // diagram lightbox (z-50) covers it too. z-index 20 (theme.css) keeps it
  // above the read surface.
  return (
    <nav
      ref={railRef}
      className="pn-contents-rail"
      aria-label="Document contents"
      data-revealed={titlesVisible ? '' : undefined}
      style={railStyle}
      onPointerLeave={() => {
        setInteractionIndex(null);
        if (hoveredMarkId !== null) setHoveredMarkId(null);
      }}
    >
      <div className="pn-contents-rail-dock" aria-hidden="true" />
      <div className="pn-contents-rail-surface" aria-hidden="true" />
      <div className="pn-contents-rail-title" aria-hidden="true">
        Contents
      </div>
      <div ref={listRef} className="pn-contents-rail-list" role="list">
        {renderedItemIndexes.map((index, markerPosition) => {
          const item = items[index];
          if (item === undefined) return null;
          const current = titlesVisible
            ? index === activeIndex
            : markerPosition === collapsedActiveSlot;
          const highlighted = index === interactionIndex;
          return (
            <button
              key={item.key}
              ref={stopRef(`tick:${index}`)}
              type="button"
              className="pn-contents-rail-marker"
              data-contents-index={index}
              data-current={current ? '' : undefined}
              data-highlighted={highlighted ? '' : undefined}
              data-level={item.level}
              data-depth={Math.min(3, Math.max(0, item.level - baseLevel))}
              // A row with marks: its line stops before them (contents-rail.css).
              data-marks={(rowMarks?.[markerPosition]?.total ?? 0) > 0 ? '' : undefined}
              aria-label={
                titlesVisible
                  ? `Go to ${item.breadcrumb}`
                  : `Open document contents at ${item.breadcrumb}`
              }
              aria-expanded={titlesVisible}
              aria-current={current ? 'location' : undefined}
              tabIndex={current ? 0 : -1}
              onClick={(event) => {
                if (!titlesVisible) {
                  openTitles(index);
                  return;
                }
                if (event.detail === 0) navigateTo(index, false);
              }}
              onFocus={() => {
                if (titlesVisible) setInteractionIndex(index);
              }}
              onBlur={(event) => closeWhenFocusLeaves(event.relatedTarget)}
              onPointerEnter={(event) => {
                if (titlesVisible && event.pointerType !== 'touch') {
                  setInteractionIndex(index);
                }
              }}
              onPointerDown={(event) => onPointerDown(event, index)}
              onPointerMove={onPointerMove}
              onPointerUp={endScrub}
              onPointerCancel={endScrub}
              onKeyDown={(event) => onStopKeyDown(event, { kind: 'tick', key: `tick:${index}`, index })}
            >
              <span className="pn-contents-rail-tick" aria-hidden="true">
                <span className="pn-contents-rail-line" />
              </span>
              <span
                className="pn-contents-rail-label"
                aria-hidden="true"
                style={labelPadding.has(index) ? { paddingInlineEnd: `${labelPadding.get(index)}px` } : undefined}
              >
                {item.label}
              </span>
            </button>
          );
        })}
        {titlesVisible && markButtons}
      </div>
      {!titlesVisible && markButtons.length > 0 && (
        <div ref={marksLayerRef} className="pn-contents-rail-marks">
          {markButtons}
        </div>
      )}
      {cardAnnotation !== undefined && (
        <div ref={cardRef} className="pn-contents-rail-card" role="tooltip">
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className={`text-[11px] font-medium ${ANNOTATION_TYPE_COLOR[cardAnnotation.type] ?? ''}`}>
              {ANNOTATION_TYPE_LABEL[cardAnnotation.type] ?? 'Comment'}
            </span>
            <AnnotationCardByline
              author={cardAnnotation.author}
              isMe={isCurrentUser(cardAnnotation.author)}
              timestamp={cardAnnotation.createdA}
            />
          </div>
          {cardAnnotation.type !== AnnotationType.GLOBAL_COMMENT && cardAnnotation.originalText.trim() !== '' && (
            <p className={ANNOTATION_QUOTE_CLASS}>"{cardAnnotation.originalText}"</p>
          )}
          {cardAnnotation.type !== AnnotationType.DELETION && (cardAnnotation.text ?? '').trim() !== '' && (
            <p className={`${ANNOTATION_TEXT_CLASS} pn-contents-rail-card-text`}>{cardAnnotation.text}</p>
          )}
        </div>
      )}
      {titlesVisible && panelAction !== undefined && (
        <div
          ref={actionRef}
          className="pn-contents-rail-action"
          onBlur={(event) => closeWhenFocusLeaves(event.relatedTarget)}
        >
          {panelAction}
        </div>
      )}
    </nav>
  );
}
