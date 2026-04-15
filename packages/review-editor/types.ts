export interface DiffFile {
  path: string;
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

export type { FileMetadata } from "@plannotator/shared/types";
