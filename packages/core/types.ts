/**
 * @plannotator/core - Type definitions
 * Portable types for plan annotations and blocks
 */

export enum AnnotationType {
  DELETION = 'DELETION',
  INSERTION = 'INSERTION',
  REPLACEMENT = 'REPLACEMENT',
  COMMENT = 'COMMENT',
  GLOBAL_COMMENT = 'GLOBAL_COMMENT',
}

/**
 * Review methodology tags for structured feedback.
 * Optional tags that help Claude understand the intent of annotations.
 */
export enum ReviewTag {
  // Modification (action required)
  TODO = '@TODO',
  FIX = '@FIX',
  CLARIFY = '@CLARIFY',
  MISSING = '@MISSING',
  ADD_EXAMPLE = '@ADD-EXAMPLE',
  // Verification (fact-checking)
  VERIFY = '@VERIFY',
  VERIFY_SOURCES = '@VERIFY-SOURCES',
  CHECK_FORMULA = '@CHECK-FORMULA',
  CHECK_LINK = '@CHECK-LINK',
  // Validation
  OK = '@OK',
  APPROVED = '@APPROVED',
  LOCKED = '@LOCKED',
}

/**
 * Categories for organizing review tags in the UI dropdown.
 */
export const REVIEW_TAG_CATEGORIES = {
  modification: [
    ReviewTag.TODO,
    ReviewTag.FIX,
    ReviewTag.CLARIFY,
    ReviewTag.MISSING,
    ReviewTag.ADD_EXAMPLE,
  ],
  verification: [
    ReviewTag.VERIFY,
    ReviewTag.VERIFY_SOURCES,
    ReviewTag.CHECK_FORMULA,
    ReviewTag.CHECK_LINK,
  ],
  validation: [ReviewTag.OK, ReviewTag.APPROVED, ReviewTag.LOCKED],
} as const;

export type EditorMode = 'selection' | 'redline';

export interface Annotation {
  id: string;
  blockId: string; // Legacy - not used with web-highlighter
  startOffset: number; // Legacy
  endOffset: number; // Legacy
  type: AnnotationType;
  tag?: ReviewTag; // Optional review methodology tag
  isMacro?: boolean; // [MACRO] flag - indicates change has cross-document impact
  text?: string; // For comments
  originalText: string; // The text that was selected
  createdAt: number;
  author?: string; // Tater identity for collaborative sharing
  imagePaths?: string[]; // Attached images (local paths or URLs)
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

export interface CodeAnnotation {
  id: string;
  type: CodeAnnotationType;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new'; // Maps to 'deletions' | 'additions' in @pierre/diffs
  text?: string;
  suggestedCode?: string;
  createdAt: number;
  author?: string;
}

// For @pierre/diffs integration
export interface DiffAnnotationMetadata {
  annotationId: string;
  type: CodeAnnotationType;
  text?: string;
  suggestedCode?: string;
  author?: string;
}

export interface SelectedLineRange {
  start: number;
  end: number;
  side: 'deletions' | 'additions';
  endSide?: 'deletions' | 'additions';
}
