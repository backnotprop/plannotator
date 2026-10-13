import type { GuideSnapshot } from '@plannotator/core/guide-format';
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
  /** A new comment, or an edit of one (same id). */
  onSave: (annotation: CodeAnnotation) => void;
  onDelete: (id: string) => void;
  /** Bumped with an id to bring that comment into view (the panel's card). */
  scrollTarget: { id: string; token: number } | null;
}

export interface GuideReaderProps {
  snapshot: GuideSnapshot;
  /** The reviewed ticks as the person left them (kept with the thread by the pane). */
  reviewed: readonly boolean[];
  onReviewedChange: (reviewed: boolean[]) => void;
  /** Line comments on the diffs; absent, the diffs are read-only (a resolved thread). */
  comments?: GuideReaderComments;
}

/** The surface's guide reader (SurfaceGuideReader.tsx): the sections (6.1), then one section per screen (6.2). */
export interface SurfaceGuideReaderProps extends GuideReaderProps {
  /** The section on screen, or null for the sections. */
  section: number | null;
  /** The reader moves: a section, or the sections with null; `sections` counts the pages. */
  onSection: (section: number | null, sections: number) => void;
}
