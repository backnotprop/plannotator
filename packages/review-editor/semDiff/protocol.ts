import type { SecondOpinionReport, SemanticDiffFold, SemanticDiffOperation } from '@plannotator/sem-jiff';
import type { SemDiffAdvert } from '@plannotator/shared/sem-diff-assets';

export interface SemDiffRequest {
  id: number;
  advert: SemDiffAdvert;
  origin: string;
  path: string;
  oldText: string;
  newText: string;
  opinion?: { rejected: string[] };
}

export type SemDiffReply =
  | { id: number; ok: true; semanticOperations: SemanticDiffOperation[]; semanticFolds: SemanticDiffFold[]; patch: string; secondOpinion?: SecondOpinionReport }
  | { id: number; ok: false; error: string };

export interface SemDiffDownload {
  download: 'start' | 'done';
  language: string;
}

const ROUTE = '/assets/sem-diff/';

export function parseSemDiffAdvert(value: unknown): SemDiffAdvert | null {
  if (!value || typeof value !== 'object') return null;
  const { runtime, grammars } = value as { runtime?: unknown; grammars?: unknown };
  if (typeof runtime !== 'string' || !runtime.startsWith(ROUTE)) return null;
  if (!grammars || typeof grammars !== 'object') return null;
  const clean: Record<string, string> = {};
  for (const [name, path] of Object.entries(grammars as Record<string, unknown>)) {
    if (typeof path === 'string' && path.startsWith(ROUTE)) clean[name] = path;
  }
  return Object.keys(clean).length > 0 ? { runtime, grammars: clean } : null;
}
