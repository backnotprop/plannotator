export enum AnnotationType {
  DELETION = 'DELETION',
  INSERTION = 'INSERTION',
  REPLACEMENT = 'REPLACEMENT',
  COMMENT = 'COMMENT',
  GLOBAL_COMMENT = 'GLOBAL_COMMENT',
}

export type EditorMode = 'selection' | 'redline';

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
  level?: number; // For headings (1-6)
  language?: string; // For code blocks (e.g., 'rust', 'typescript')
  order: number; // Sorting order
  startLine: number; // 1-based line number in source
}

export interface DiffResult {
  original: string;
  modified: string;
  diffText: string;
}
