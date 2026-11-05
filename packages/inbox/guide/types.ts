import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
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

export interface GuideReaderProps {
  snapshot: GuideSnapshot;
  /** The reviewed ticks as the person left them (kept with the thread by the pane). */
  reviewed: readonly boolean[];
  onReviewedChange: (reviewed: boolean[]) => void;
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
  /** A picture slot when the overview has no diagram (the guide host's `renderOverviewFigure`). Absent: none. */
  renderOverviewFigure?: () => ReactNode | null;
  /** Paint these lines (new side) and bring them into view; a new token moves again. */
  highlight?: { path: string; start: number; end: number; token: number } | null;
  /** Under the host's own title (the PR review): no heading block of the reader's own, the host's page margins. */
  bare?: boolean;
  /** "Open in" on each file's header (a review while Code review is on). Absent: none, as before. */
  fileOpenIn?: (path: string) => ReactNode;
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
  showMeIcon?: ReactNode;
}

/** The surface's guide reader (SurfaceGuideReader.tsx): the sections (6.1), then one section per screen (6.2). */
export interface SurfaceGuideReaderProps extends GuideReaderProps {
  /** The section on screen, or null for the sections. */
  section: number | null;
  /** The reader moves: a section, or the sections with null; `sections` counts the pages. */
  onSection: (section: number | null, sections: number) => void;
}
