/**
 * Draft Storage
 *
 * Persists annotation drafts to ~/.plannotator/drafts/ so they survive
 * server crashes. Each draft is keyed by a content hash of the plan/diff
 * it was created against.
 *
 * Runtime-agnostic: uses only node:fs, node:path, node:os, node:crypto.
 */

import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import { createHash } from "crypto";
import { getPlannotatorDataDir } from "./data-dir";

/**
 * Get the drafts directory, creating it if needed.
 */
export function getDraftDir(): string {
  const dir = join(getPlannotatorDataDir(), "drafts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Generate a stable key from content using truncated SHA-256.
 * Same content always produces the same key across server restarts.
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Save a draft to disk.
 */
export function saveDraft(key: string, data: object): void {
  const dir = getDraftDir();
  writeFileSync(join(dir, `${key}.json`), JSON.stringify(data), "utf-8");
}

/**
 * Load a draft from disk. Returns null if not found.
 */
export function loadDraft(key: string): object | null {
  const filePath = join(getDraftDir(), `${key}.json`);
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Delete a draft from disk. No-op if not found.
 */
export function deleteDraft(key: string): void {
  const filePath = join(getDraftDir(), `${key}.json`);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Ignore delete failures
  }
}
