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
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, existsSync } from "fs";
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

function draftPath(key: string): string {
  return join(getDraftDir(), `${key}.json`);
}

function tombstonePath(key: string): string {
  return join(getDraftDir(), `${key}.deleted.json`);
}

function readGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readTombstoneGeneration(key: string): number | null {
  const filePath = tombstonePath(key);
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return readGeneration((parsed as { draftGeneration?: unknown }).draftGeneration);
  } catch {
    return null;
  }
}

function readStoredDraftGeneration(key: string): number | null {
  const filePath = draftPath(key);
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return readGeneration((parsed as { draftGeneration?: unknown }).draftGeneration);
  } catch {
    return null;
  }
}

export function getDraftGeneration(key: string): number | null {
  const generations = [
    readStoredDraftGeneration(key),
    readTombstoneGeneration(key),
  ].filter((value): value is number => value !== null);
  return generations.length > 0 ? Math.max(...generations) : null;
}

function writeTombstoneGeneration(key: string, draftGeneration: number): void {
  const filePath = tombstonePath(key);
  writeFileSync(filePath, JSON.stringify({ draftGeneration }), "utf-8");
}

function clearTombstone(key: string): void {
  const filePath = tombstonePath(key);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Ignore cleanup failures.
  }
}

/**
 * Save a draft to disk.
 */
export function saveDraft(key: string, data: object): boolean {
  const draftGeneration = readGeneration((data as { draftGeneration?: unknown }).draftGeneration);
  const deletedGeneration = readTombstoneGeneration(key);
  if (draftGeneration !== null && deletedGeneration !== null && draftGeneration <= deletedGeneration) {
    return false;
  }
  const storedGeneration = readStoredDraftGeneration(key);
  if (draftGeneration !== null && storedGeneration !== null && draftGeneration < storedGeneration) {
    return false;
  }

  // Write-then-rename so a crash mid-write can't leave a truncated draft —
  // loadDraft would silently return null at exactly the recovery moment
  // drafts exist for. rename() is atomic within a directory.
  const finalPath = draftPath(key);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data), "utf-8");
  renameSync(tmpPath, finalPath);
  if (draftGeneration === null) {
    clearTombstone(key);
  }
  return true;
}

/**
 * Load a draft from disk. Returns null if not found.
 */
export function loadDraft(key: string): object | null {
  const filePath = draftPath(key);
  try {
    if (!existsSync(filePath)) return null;
    const draft = JSON.parse(readFileSync(filePath, "utf-8"));
    const draftGeneration = readGeneration((draft as { draftGeneration?: unknown }).draftGeneration);
    const deletedGeneration = readTombstoneGeneration(key);
    if (draftGeneration !== null && deletedGeneration !== null && draftGeneration <= deletedGeneration) {
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

/**
 * Delete a draft from disk. No-op if not found.
 */
export function deleteDraft(key: string, draftGeneration?: number): void {
  const filePath = draftPath(key);
  try {
    const generation = readGeneration(draftGeneration);
    if (generation !== null) {
      const knownGeneration = getDraftGeneration(key);
      if (knownGeneration !== null && generation < knownGeneration) return;
    }

    if (existsSync(filePath)) unlinkSync(filePath);
    if (generation !== null) writeTombstoneGeneration(key, generation);
    else clearTombstone(key);
  } catch {
    // Ignore delete failures
  }
}
