import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxFileContents } from '@plannotator/core/inbox-types';
import type { ReactNode } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';

/**
 * The person's comments on the guide's diffs: the review app's line comments
 * (`CodeAnnotation`), kept by the pane in the store until they ride a Send.
 */
export interface GuideReaderComments {
  annotations: readonly CodeAnnotation[];
  /** The comment selected (a card in the panel, or one clicked in the diff). */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** A new comment, or an edit of one (same id). Answers whether the store kept it. */
  onSave: (annotation: CodeAnnotation) => Promise<boolean>;
  onDelete: (id: string) => void;
  /** Bumped with an id to bring that comment into view (the panel's card). */
  scrollTarget: { id: string; token: number } | null;
  /** Names this review's unsaved words (the message's id): one draft per message, never shared with another thread. */
  draftScope: string;
  /**
   * A global comment chosen in the guide: the pane shows it in its comments
   * (opens its folded sheet, where its edit and delete are). Absent: it is selected.
   */
  onShowGlobalComment?: (id: string) => void;
}

/**
 * Code review's image preview on changed images (review-editor's `ImageDiffPreview`, as its All files draws it): the
 * reads of `/api/review-image` sent to the host's own route (packages/inbox/reviewImages.ts), under a snapshot id of
 * the host's own. A host names it with `ReaderPart` `images` (lazyParts.tsx), which the reader reads from
 * `ReviewImagesContext`. Absent: an image's diff is the binary notice, as before.
 */
export interface GuideReaderImages {
  snapshotId: string;
  fetchImpl: typeof fetch;
  /**
   * Where a rendered Markdown file's pictures are read (review parity B3): code review's
   * `/api/review-markdown-image?…` turned into the host's own route (review-editor's `MarkdownFilePreview` `imageUrl`).
   */
  markdownImageUrl: (url: string) => string;
}

export interface GuideReaderProps {
  snapshot: GuideSnapshot;
  /** The reviewed ticks as the person left them (kept with the thread by the pane). */
  reviewed: readonly boolean[];
  onReviewedChange: (reviewed: boolean[]) => void;
  /** False: the chapters take no "Reviewed" tick (a walkthrough: code as it is, nothing to review). Default true. */
  chapterTicks?: boolean;
  /** Line comments on the diffs; absent, the diffs are read-only (a resolved thread). */
  comments?: GuideReaderComments;
  /**
   * A review (code review in the Inbox): `walkthrough` draws the agent's
   * chapters, as without it; `files` draws every changed file in the patch's
   * order under one heading, with the same comments. Absent: `walkthrough`.
   */
  mode?: 'walkthrough' | 'files';
  /** Bring this file's diff into view (the review's rail). A new token moves again to the same file. */
  reveal?: { path: string; token: number } | null;
  /** The review's Viewed ticks on each file's header. Absent: no Viewed control, as before. */
  viewed?: { files: ReadonlySet<string>; onToggle: (path: string) => void };
  /**
   * Choices for selected lines before the comment box (code review in the
   * Inbox: Comment · Ask · Show me; review-editor's `DiffSelectionActions`).
   * Absent: a selection opens the comment box at once, as before.
   */
  selectionActions?: GuideSelectionActions;
  /** Draws the overview's diagram (the guide host's `renderOverviewDiagram`). Absent or null: as before. */
  renderOverviewDiagram?: (diagram: GuideOverviewDiagram) => ReactNode | null;
  /** Draws a chapter's html diagram (the guide host's `renderChapterDiagram`; Mermaid is drawn by the reader). Absent or null: no diagram. */
  renderChapterDiagram?: (diagram: GuideOverviewDiagram, index: number) => ReactNode | null;
  /** Draw each chapter's diagram folded, its Diagram header closed (Chapter diagrams off); one click opens it. Absent: as before. */
  chapterDiagramsFolded?: boolean;
  /** A picture slot when the overview has no diagram (the guide host's `renderOverviewFigure`). Absent: none. */
  renderOverviewFigure?: () => ReactNode | null;
  /** Paint these lines (new side; `side: 'old'`: removed lines' numbers) and bring them into view; a new token moves again. */
  highlight?: { path: string; start: number; end: number; token: number; side?: 'old' } | null;
  /** Under the host's own title (the PR review): no heading block of the reader's own, the host's page margins. */
  bare?: boolean;
  /** Bare: Global comment and Split | Unified in this element of the host's (the PR review's strip), not above the files. */
  controlsHost?: HTMLElement | null;
  /** Reads one changed file's whole text, for the "N unmodified lines" arrows. Absent: the diffs show as they came. */
  fileContents?: (path: string, signal: AbortSignal, patch: string) => Promise<InboxFileContents>;
  /**
   * Under a top bar that names the review and lists its chapters (the full-window review): the heading reads like a
   * thread's (GuideView `threadHeading`). Absent: as before.
   */
  threadHeading?: boolean;
  /**
   * Sign each new comment with the person's name, as the review app does (the full-window review while Code review is
   * on). The PR page (`bare`) always signs. Absent: unsigned, as on main.
   */
  signComments?: boolean;
  /**
   * The host's bar draws the diff controls (Split / Unified, Collapse all, the "Diff display" popover: approval
   * "diff-controls-headers"), so the first card has no Split | Unified tab. Absent: the tab, as before.
   */
  hostDiffControls?: boolean;
  /** Fold or open every file's diff (the bar's Collapse all); a new token applies it again. Not remembered. */
  collapseAll?: { collapsed: boolean; token: number };
  /** The review's own actions on that heading's title line (the guide host's `renderHeadActions`). */
  renderHeadActions?: () => ReactNode | null;
  /** "Open in" on each file's header (a review while Code review is on). Absent: none, as before. */
  fileOpenIn?: (path: string) => ReactNode;
  /**
   * What the host draws itself under lines of the diffs (the PR page: other people's threads from the forge). Never
   * comments: nothing counts, sends or posts them. Absent: none, as before.
   */
  lineNotes?: readonly GuideLineNote[];
  /** The host's marks at the right edge of lines (the PR page: the risk bars), never over code. Absent: none. */
  lineMarks?: readonly GuideLineMark[];
  /** Hears the marks (hover, keyboard focus, a press): the PR page opens its card on them. */
  onLineMark?: OnGuideLineMark;
  /**
   * What the host draws itself about whole files, in each file's header under its path (the PR page: other people's
   * folded comments on a whole file), so it stays with the header. Never comments, as `lineNotes`; something that
   * should scroll away with the code is a line note on line 0. Absent: none, as before.
   */
  wholeFileNotes?: readonly GuideFileNote[];
  /**
   * Context notes (approval "inbox-context-notes"): agents' words on lines, drawn under their last line by
   * `renderContextNote` through review-editor's `contextNotes` seam, never as comments. Absent: nothing changes.
   */
  contextNotes?: readonly GuideContextNote[];
  renderContextNote?: (id: string) => ReactNode;
}

/** One thing the host draws under a line (review-editor's `HostLineNote`, as the window's strict typecheck sees it). */
export interface GuideLineNote {
  /** Stable for the same note across reads. */
  id: string;
  filePath: string;
  line: number;
  side: 'old' | 'new';
  /** Changes whenever what `render` draws changes; the same key leaves the line as it is. */
  key: string;
  render: () => ReactNode;
}

/** A mark at the right edge of a line (review-editor's `HostLineMark`, as the window's strict typecheck sees it). */
export interface GuideLineMark {
  /** Unique on the page: what `onLineMark` hands back. */
  id: string;
  filePath: string;
  side: 'old' | 'new';
  line: number;
  /** Its accessible name. */
  label: string;
  /** Its look: CSS background declarations for its box (review-editor's `LINE_MARK_WIDTH` × one line). */
  paint: string;  /** It opens a popup of this kind (`aria-haspopup`; `aria-expanded` is the host's to set while it is open). */
  popup?: 'dialog';
}

/** review-editor's `OnHostLineMark`: a mark's id, what happened on it, its button, and where the pointer or focus went. */
export type OnGuideLineMark = (id: string, event: 'enter' | 'leave' | 'focus' | 'blur' | 'press', button: HTMLButtonElement, related: EventTarget | null) => void;

/** One thing the host draws about a whole file (review-editor's `HostFileNote`, as the window's strict typecheck sees it). */
export interface GuideFileNote {
  /** Stable for the same note across reads. */
  id: string;
  filePath: string;
  /** Changes whenever what `render` draws changes; the same key leaves the file's header as it is. */
  key: string;
  /** The height it draws at, in px, when known: the header is sized for it from the start (review-editor's `height`). */
  height?: number;
  render: () => ReactNode;
}

/** Where a context note sits (review-editor's `ContextNoteAnchor`, as the window's strict typecheck sees it). */
export interface GuideContextNote {
  id: string;
  filePath: string;
  side: 'old' | 'new';
  lineStart: number;
  lineEnd: number;
}

/** Selected lines, as a selection action receives them (review-editor's `DiffSelection`). */
export interface GuideSelection {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
}

/** review-editor's `DiffSelectionActions`, as the window's strict typecheck sees it. */
export interface GuideSelectionActions {
  onAsk?: (selection: GuideSelection) => void;
  onShowMe?: (selection: GuideSelection) => void;
}

/** The surface's guide reader (SurfaceGuideReader.tsx): the sections (6.1), then one section per screen (6.2). */
export interface SurfaceGuideReaderProps extends GuideReaderProps {
  /** The section on screen, or null for the sections. */
  section: number | null;
  /** The reader moves: a section, or the sections with null; `sections` counts the pages. */
  onSection: (section: number | null, sections: number) => void;
}
