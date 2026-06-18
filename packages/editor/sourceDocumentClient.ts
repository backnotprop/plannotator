import type { SourceSaveCapability } from '@plannotator/shared/source-save';

type EnabledSourceSaveCapability = Extract<SourceSaveCapability, { enabled: true }>;

export type SourceSaveProbeResult =
  | { status: 'ok'; sourceSave: EnabledSourceSaveCapability }
  | { status: 'missing' }
  | { status: 'unavailable' };

interface SourceDocumentResponse {
  markdown?: string;
  sourceSave?: SourceSaveCapability;
  renderAs?: 'markdown' | 'html';
}

type SourceDocumentFetchResult =
  | { status: 'ok'; data: SourceDocumentResponse }
  | { status: 'missing' }
  | { status: 'unavailable' };

export interface SourceDocumentSnapshot {
  markdown: string;
  sourceSave: EnabledSourceSaveCapability;
}

export type SourceDocumentSnapshotResult =
  | { status: 'ok'; snapshot: SourceDocumentSnapshot }
  | { status: 'missing' }
  | { status: 'unavailable' };

async function fetchSourceDocument(path: string): Promise<SourceDocumentFetchResult> {
  try {
    const res = await fetch(`/api/doc?path=${encodeURIComponent(path)}`);
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'unavailable' };
    return { status: 'ok', data: await res.json() as SourceDocumentResponse };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function probeSourceSave(path: string): Promise<SourceSaveProbeResult> {
  const result = await fetchSourceDocument(path);
  if (result.status !== 'ok') return { status: result.status };

  const { sourceSave } = result.data;
  if (sourceSave?.enabled) return { status: 'ok', sourceSave };
  if (sourceSave?.enabled === false && sourceSave.reason === 'missing-file') {
    return { status: 'missing' };
  }
  return { status: 'unavailable' };
}

export async function fetchSourceDocumentSnapshot(path: string): Promise<SourceDocumentSnapshotResult> {
  const result = await fetchSourceDocument(path);
  if (result.status !== 'ok') return { status: result.status };

  const { markdown, renderAs, sourceSave } = result.data;
  if (sourceSave?.enabled === false && sourceSave.reason === 'missing-file') {
    return { status: 'missing' };
  }
  if (renderAs === 'html' || typeof markdown !== 'string' || !sourceSave?.enabled) return { status: 'unavailable' };
  return { status: 'ok', snapshot: { markdown, sourceSave } };
}
