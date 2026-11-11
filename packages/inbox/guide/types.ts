import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import type { GuideSnapshot } from '@plannotator/core/guide-format';
import type { InboxFileContents } from '@plannotator/core/inbox-types';
import type { ReactNode } from 'react';
import type { CodeAnnotation } from '@plannotator/ui/types';

export interface GuideReaderComments {
  annotations: readonly CodeAnnotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSave: (annotation: CodeAnnotation) => Promise<boolean>;
  onDelete: (id: string) => void;
  scrollTarget: { id: string; token: number } | null;
  draftScope: string;
  onShowGlobalComment?: (id: string) => void;
}

export interface GuideReaderProps {
  snapshot: GuideSnapshot;
  reviewed: readonly boolean[];
  onReviewedChange: (reviewed: boolean[]) => void;
  chapterTicks?: boolean;
  comments?: GuideReaderComments;
  mode?: 'walkthrough' | 'files';
  reveal?: { path: string; token: number } | null;
  viewed?: { files: ReadonlySet<string>; onToggle: (path: string) => void };
  selectionActions?: GuideSelectionActions;
  renderOverviewDiagram?: (diagram: GuideOverviewDiagram) => ReactNode | null;
  renderChapterDiagram?: (diagram: GuideOverviewDiagram, index: number) => ReactNode | null;
  chapterDiagramsFolded?: boolean;
  renderOverviewFigure?: () => ReactNode | null;
  highlight?: { path: string; start: number; end: number; token: number; side?: 'old' } | null;
  bare?: boolean;
  controlsHost?: HTMLElement | null;
  fileContents?: (path: string, signal: AbortSignal, patch: string) => Promise<InboxFileContents>;
  threadHeading?: boolean;
  signComments?: boolean;
  hostDiffControls?: boolean;
  collapseAll?: { collapsed: boolean; token: number };
  renderHeadActions?: () => ReactNode | null;
  fileOpenIn?: (path: string) => ReactNode;
  /** Host-drawn notes under diff lines are never comments: nothing counts, sends or posts them. */
  lineNotes?: readonly GuideLineNote[];
  /** Host-drawn notes in a file's header, never comments; something that should scroll with the code is a line note on line 0. */
  wholeFileNotes?: readonly GuideFileNote[];
  /** Agents' context notes: drawn under their last line, never as comments. */
  contextNotes?: readonly GuideContextNote[];
  renderContextNote?: (id: string) => ReactNode;
}

export interface GuideLineNote {
  id: string;
  filePath: string;
  line: number;
  side: 'old' | 'new';
  key: string;
  render: () => ReactNode;
}

export interface GuideFileNote {
  id: string;
  filePath: string;
  key: string;
  height?: number;
  render: () => ReactNode;
}

export interface GuideContextNote {
  id: string;
  filePath: string;
  side: 'old' | 'new';
  lineStart: number;
  lineEnd: number;
}

export interface GuideSelection {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
}

export interface GuideSelectionActions {
  onAsk?: (selection: GuideSelection) => void;
  onShowMe?: (selection: GuideSelection) => void;
}

export interface SurfaceGuideReaderProps extends GuideReaderProps {
  section: number | null;
  onSection: (section: number | null, sections: number) => void;
}
