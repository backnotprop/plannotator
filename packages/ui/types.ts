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
  type: 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'code' | 'hr' | 'table' | 'html' | 'directive';
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
}

export interface DiffResult {
  original: string;
  modified: string;
  diffText: string;
}

// Code Review Types
export type CodeAnnotationType = 'comment' | 'suggestion' | 'concern';
export type CodeAnnotationScope = 'line' | 'file';

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
  conventionalLabel?: ConventionalLabel;
  decorations?: ConventionalDecoration[];
  prUrl?: string;
  prNumber?: number;
  prTitle?: string;
  prRepo?: string;
  diffScope?: 'layer' | 'full-stack';
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

export type { EditorAnnotation } from '@plannotator/shared/types';

export type {
  ExternalAnnotationEvent,
} from '@plannotator/shared/external-annotation';

export type {
  AgentJobInfo,
  AgentJobEvent,
  AgentJobStatus,
  AgentCapability,
  AgentCapabilities,
} from '@plannotator/shared/agent-jobs';
