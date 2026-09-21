/**
 * Storage contract for shared guides (contract: adr/implementation/guide-share-hosting.md §3).
 *
 * One text body per guide plus a small metadata record. The body is opaque to
 * the store: base64url ciphertext for encrypted guides, snapshot JSON for
 * plain ones. Implementations: `stores/r2.ts` (Worker), `stores/memory.ts` (tests).
 */

export type SharedGuideMode = 'encrypted' | 'plain';

/** The viewer build a guide was uploaded against; the host renders with it so the page never drifts from what the uploader tested. `baseUrl` is deliberately absent: the host always uses its own `/v1/`. */
export interface StoredGuideViewerPin {
  js: string;
  css: string;
  jsIntegrity?: string;
  cssIntegrity?: string;
  langs?: Record<string, string>;
}

export interface StoredGuideMeta {
  readonly mode: SharedGuideMode;
  /** ISO timestamp. */
  readonly createdAt: string;
  /** ISO timestamp; absent = never expires. */
  readonly expiresAt?: string;
  /** Hex SHA-256 of the delete token handed out once at create. */
  readonly deleteTokenHash: string;
  readonly viewer?: StoredGuideViewerPin;
  /** UTF-8 byte length of the stored body. */
  readonly bytes: number;
}

export interface GuideStore {
  put(id: string, body: string, meta: StoredGuideMeta): Promise<void>;
  /** `null` when the id is unknown OR the guide has expired (a store may lazily delete an expired guide on read). */
  get(id: string): Promise<{ body: string; meta: StoredGuideMeta } | null>;
  delete(id: string): Promise<void>;
}

/** True when `meta.expiresAt` is set and already in the past. Shared by every store's lazy-expiry check. */
export function isStoredGuideExpired(meta: StoredGuideMeta, now: number = Date.now()): boolean {
  if (!meta.expiresAt) return false;
  const at = Date.parse(meta.expiresAt);
  return Number.isFinite(at) && at <= now;
}
