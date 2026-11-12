export type SharedGuideMode = 'encrypted' | 'plain';

export interface StoredGuideViewerPin {
  js: string;
  css: string;
  jsIntegrity?: string;
  cssIntegrity?: string;
  langs?: Record<string, string>;
}

export interface StoredGuideMeta {
  readonly mode: SharedGuideMode;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly deleteTokenHash: string;
  readonly viewer?: StoredGuideViewerPin;
  readonly bytes: number;
}

export interface GuideStore {
  put(id: string, body: string, meta: StoredGuideMeta): Promise<void>;
  get(id: string): Promise<{ body: string; meta: StoredGuideMeta } | null>;
  delete(id: string): Promise<void>;
}

export function isStoredGuideExpired(meta: StoredGuideMeta, now: number = Date.now()): boolean {
  if (!meta.expiresAt) return false;
  const at = Date.parse(meta.expiresAt);
  return Number.isFinite(at) && at <= now;
}
