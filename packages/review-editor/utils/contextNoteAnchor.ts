export interface ContextNoteAnchor {
  id: string;
  filePath: string;
  side: 'old' | 'new';
  lineStart: number;
  lineEnd: number;
}
