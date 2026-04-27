// Editor annotations from VS Code extension (ephemeral, in-memory only)
export interface EditorAnnotation {
  id: string;
  filePath: string;     // workspace-relative (e.g., "src/auth.ts")
  selectedText: string;
  lineStart: number;    // 1-based
  lineEnd: number;      // 1-based
  comment?: string;
  createdAt: number;
}

// Git review types shared between server and client
export type {
  DiffOption,
  WorktreeInfo,
  GitContext,
  AvailableBranches,
} from "./review-core";
