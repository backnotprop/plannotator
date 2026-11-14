import type { SemanticDiffFold, SemanticDiffOperation } from '@plannotator/sem-diff';
import type { SemDiffAdvert } from '@plannotator/shared/sem-diff-assets';

export interface SemDiffRequest {
  id: number;
  advert: SemDiffAdvert;
  origin: string;
  path: string;
  oldText: string;
  newText: string;
}

export type SemDiffReply =
  | { id: number; ok: true; semanticOperations: SemanticDiffOperation[]; semanticFolds: SemanticDiffFold[]; patch: string }
  | { id: number; ok: false; error: string };

export const SEM_DIFF_GRAMMARS = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
} as const;
