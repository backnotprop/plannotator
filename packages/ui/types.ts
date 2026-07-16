export enum AnnotationType {
  DELETION = 'DELETION',
  COMMENT = 'COMMENT',
  GLOBAL_COMMENT = 'GLOBAL_COMMENT',
}

export type EditorMode = 'selection' | 'comment' | 'redline' | 'quickLabel';

export type InputMethod = 'drag' | 'pinpoint';

/**
 * Compactness of the Viewer action button labels (Image / Comment / Copy).
 * Driven by measured plan-area width so the cluster collapses responsively
 * when the side panel squeezes the plan.
 *   full  → "Global comment" / "Copy plan"
 *   short → "Comment" / "Copy"
 *   icon  → labels hidden entirely
 */
export type ActionsLabelMode = 'full' | 'short' | 'icon';

export type WideModeType = 'wide' | 'focus';

export interface ImageAttachment {
  path: string;
  name: string;
}

export interface Annotation {
  id: string;
  blockId: string; // Legacy - not used with web-highlighter
  startOffset: number; // Legacy
  endOffset: number; // Legacy
  type: AnnotationType;
  text?: string; // For comments
  originalText: string; // The text that was selected
  createdA: number;
  author?: string; // Tater identity for collaborative sharing
  source?: string; // External tool identifier (e.g., "eslint") — set when annotation comes from external API
  images?: ImageAttachment[]; // Attached images with human-readable names
  isQuickLabel?: boolean; // true if created via quick label chip
  quickLabelTip?: string; // optional instruction tip from the label definition
  diffContext?: 'added' | 'removed' | 'modified'; // set when annotation created in plan diff view
  mathTargets?: Array<{
    blockId: string;
    tex: string;
    displayMode: boolean;
  }>; // math elements covered by a mixed text+formula selection
  prUrl?: string; // code-review PR mode: the PR this note belongs to, so it isn't shown/exported against another PR after an in-place switch
  // web-highlighter metadata for cross-element selections
  startMeta?: {
    parentTagName: string;
    parentIndex: number;
    textOffset: number;
  };
  endMeta?: {
    parentTagName: string;
    parentIndex: number;
    textOffset: number;
  };
}

export type AlertKind = 'note' | 'tip' | 'warning' | 'caution' | 'important';

export interface Block {
  id: string;
  type: 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'code' | 'hr' | 'table' | 'html' | 'directive' | 'math';
  content: string; // Plain text, or raw (unsanitized) HTML for type === 'html'
  level?: number; // For headings (1-6) or list indentation
  language?: string; // For code blocks (e.g., 'rust', 'typescript')
  checked?: boolean; // For checkbox list items (true = checked, false = unchecked, undefined = not a checkbox)
  ordered?: boolean; // For list items: true when source marker was \d+.
  orderedStart?: number; // For ordered list items: integer parsed from the marker (e.g. 5 for "5.")
  alertKind?: AlertKind; // For blockquotes starting with [!NOTE] / [!TIP] / etc.
  directiveKind?: string; // For directive containers (e.g. ':::note' → 'note')
  order: number; // Sorting order
  startLine: number; // 1-based line number in source
  sourceLineCount?: number; // Number of source lines consumed when it differs from content lines
}

export interface DiffResult {
  original: string;
  modified: string;
  diffText: string;
}

// Code Review Types
export type CodeAnnotationType = 'comment' | 'suggestion' | 'concern';
// 'general' is a review-level comment tied to no file and no line. For 'general'
// (and the file-less case) filePath is "" and lineStart/lineEnd are 0 — consumers
// must branch on scope, never read those sentinels as a real path or row.
export type CodeAnnotationScope = 'line' | 'file' | 'general';

/** Conventional Comments label — see https://conventionalcomments.org */
export type ConventionalLabel =
  | 'praise'
  | 'nitpick'
  | 'suggestion'
  | 'issue'
  | 'todo'
  | 'question'
  | 'thought'
  | 'chore'
  | 'note'
  | 'typo'
  | 'polish'
  | (string & {}); // Allow custom labels while preserving autocomplete for built-ins

/** Conventional Comments decoration (parenthesized modifier) */
export type ConventionalDecoration = 'blocking' | 'non-blocking' | 'if-minor';

/**
 * A note attached to a whole PR comment/review/thread (code-review Phase 2).
 * Button-driven (not text-anchored): the reviewer clicks "Annotate" on a card
 * and leaves a note. The comment body travels with it so the agent — which
 * can't see PR discussion — receives the full context on export.
 */
export interface CommentAnnotation {
  id: string;
  commentId: string;      // the timeline entry id (matches data-comment-id on the card)
  commentAuthor: string;
  commentBody: string;
  text: string;           // the reviewer's note
  createdAt: number;
  prUrl?: string;         // the PR this note belongs to (see Annotation.prUrl)
}

export interface CodeAnnotation {
  id: string;
  type: CodeAnnotationType;
  scope?: CodeAnnotationScope; // Defaults to 'line' for backward compatibility
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new'; // Maps to 'deletions' | 'additions' in @pierre/diffs
  text?: string;
  images?: ImageAttachment[];
  suggestedCode?: string;
  originalCode?: string; // Original selected lines for suggestion diff
  charStart?: number; // Character offset within lineStart (token-level selection)
  charEnd?: number; // Character offset within lineEnd (token-level selection)
  tokenText?: string; // Selected token/span text (token-level selection)
  createdAt: number;
  author?: string;
  source?: string; // External tool identifier (e.g., "eslint") — set when annotation comes from external API
  severity?: 'important' | 'nit' | 'pre_existing'; // Agent review severity (Claude)
  reasoning?: string; // Validation chain — how the issue was confirmed (Claude)
  reviewProfileLabel?: string; // Custom review that produced this finding — shown as a tag
  conventionalLabel?: ConventionalLabel;
  decorations?: ConventionalDecoration[];
  prUrl?: string;
  prNumber?: number;
  prTitle?: string;
  prRepo?: string;
  diffScope?: 'layer' | 'full-stack';
  /** Set when the annotation was created on a commit:<sha> diff (Commits
   *  panel). Line numbers anchor to THAT commit's diff-vs-parent — the export
   *  labels the annotation with its commit when sent from any other diff, so
   *  the agent never reads historical line numbers against the current diff. */
  commitSha?: string;
  /** The commit's one-line subject, captured for readable export labels. */
  commitSubject?: string;
}

/** Token-level metadata passed from selection to annotation creation. */
export interface TokenAnnotationMeta {
  charStart: number;
  charEnd: number;
  tokenText: string;
}

/** Severity display styles — shared between agent detail panel and inline diff annotations. */
export const SEVERITY_STYLES: Record<string, { dot: string; label: string }> = {
  important: { dot: 'bg-destructive', label: 'Important' },
  nit: { dot: 'bg-amber-500', label: 'Nit' },
  pre_existing: { dot: 'bg-muted-foreground', label: 'Pre-existing' },
};

// For @pierre/diffs integration
export interface DiffAnnotationMetadata {
  annotationId: string;
  type: CodeAnnotationType;
  text?: string;
  suggestedCode?: string;
  originalCode?: string;
  author?: string;
  severity?: 'important' | 'nit' | 'pre_existing';
  reasoning?: string;
  conventionalLabel?: ConventionalLabel;
  decorations?: ConventionalDecoration[];
  // Shared comment-meta fields (so the inline diff card shows the same identity
  // row — author, time, badges — as the sidebar and file-banner cards).
  createdAt?: number;
  reviewProfileLabel?: string;
  source?: string;
  /** Precomputed clipboard text (location prefix + body + reasoning) so the
   *  inline copy action matches the sidebar/banner — the inline card only has
   *  the projected metadata, not the full annotation. */
  copyText?: string;
  // AI marker fields (set when kind === 'ai-marker')
  kind?: 'annotation' | 'ai-marker';
  questionId?: string;
  promptPreview?: string;
  hasResponse?: boolean;
  isStreaming?: boolean;
}

export interface SelectedLineRange {
  start: number;
  end: number;
  side: 'deletions' | 'additions';
  endSide?: 'deletions' | 'additions';
}

// ---------------------------------------------------------------------------
// AI Chat (inline AI on diffs)
// ---------------------------------------------------------------------------

export interface AIQuestion {
  id: string;
  prompt: string;
  scope?: {
    kind: 'general' | 'selection';
    label?: string;
    text?: string;
    sourcePath?: string;
  };
  /** undefined = general question (no file scope) */
  filePath?: string;
  /** undefined + filePath present = file-scoped; with filePath = line-scoped */
  lineStart?: number;
  lineEnd?: number;
  side?: 'old' | 'new';
  selectedCode?: string;
  createdAt: number;
}

export interface AIResponse {
  questionId: string;
  text: string;
  isStreaming: boolean;
  error?: string;
  createdAt: number;
}

export interface VaultNode {
  name: string;
  path: string; // relative path within vault
  type: "file" | "folder";
  children?: VaultNode[];
}

export type { EditorAnnotation } from '@plannotator/core/types';

export type {
  ExternalAnnotationEvent,
} from '@plannotator/core/external-annotation';

export type {
  AgentJobInfo,
  AgentJobEvent,
  AgentJobStatus,
  AgentCapability,
  AgentCapabilities,
} from '@plannotator/core/agent-jobs';
