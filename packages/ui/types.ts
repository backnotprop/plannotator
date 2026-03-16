export enum AnnotationType {
  DELETION = 'DELETION',
  INSERTION = 'INSERTION',
  REPLACEMENT = 'REPLACEMENT',
  COMMENT = 'COMMENT',
  GLOBAL_COMMENT = 'GLOBAL_COMMENT',
}

export type EditorMode = 'selection' | 'comment' | 'redline' | 'quickLabel';

export type InputMethod = 'drag' | 'pinpoint';

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

export interface Block {
  id: string;
  type: 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'code' | 'hr' | 'table';
  content: string; // Plain text content
  level?: number; // For headings (1-6) or list indentation
  language?: string; // For code blocks (e.g., 'rust', 'typescript')
  checked?: boolean; // For checkbox list items (true = checked, false = unchecked, undefined = not a checkbox)
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

export interface CodeAnnotation {
  id: string;
  type: CodeAnnotationType;
  scope?: CodeAnnotationScope; // Defaults to 'line' for backward compatibility
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new'; // Maps to 'deletions' | 'additions' in @pierre/diffs
  text?: string;
  suggestedCode?: string;
  originalCode?: string; // Original selected lines for suggestion diff
  createdAt: number;
  author?: string;
}

// For @pierre/diffs integration
export interface DiffAnnotationMetadata {
  annotationId: string;
  type: CodeAnnotationType;
  text?: string;
  suggestedCode?: string;
  originalCode?: string;
  author?: string;
}

export interface SelectedLineRange {
  start: number;
  end: number;
  side: 'deletions' | 'additions';
  endSide?: 'deletions' | 'additions';
}

export interface VaultNode {
  name: string;
  path: string; // relative path within vault
  type: "file" | "folder";
  children?: VaultNode[];
}

export type { EditorAnnotation } from '@plannotator/shared/types';

// Collaborative Review Session Types
export interface ReviewSession {
  /** Unique session ID (8 chars, same format as paste IDs) */
  id: string;

  /** Base plan markdown that all reviewers see */
  plan: string;

  /** Accumulated annotations from all reviewers */
  annotations: Annotation[];

  /** Global attachments (images uploaded by reviewers) */
  globalAttachments?: ImageAttachment[];

  /** Optional diff contexts (parallel to annotations array) */
  diffContexts?: (string | null)[];

  /** Timestamp when session was created */
  createdAt: number;

  /** Timestamp of last annotation added */
  lastUpdatedAt: number;

  /** Expiration timestamp (7 days from creation) */
  expiresAt: number;

  /** Number of unique reviewers (tracked via author field) */
  reviewerCount: number;

  /** Lock to prevent concurrent writes (simple optimistic locking) */
  version: number;
}

export interface CreateReviewSessionRequest {
  plan: string;
  globalAttachments?: ImageAttachment[];
}

export interface AddAnnotationsRequest {
  annotations: Annotation[];
  globalAttachments?: ImageAttachment[];
  /** Expected version for optimistic locking (prevents overwrite conflicts) */
  expectedVersion: number;
}

export interface ReviewSessionResponse {
  session: ReviewSession;
  shareUrl: string; // Full URL for sharing with team
}
