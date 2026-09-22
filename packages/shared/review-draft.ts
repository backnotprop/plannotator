/**
 * Code-review draft storage keyed by review TARGET as well as patch content
 * (#1590, PR mode only).
 *
 * Review drafts have always been keyed by `contentHash(rawPatch)`, so any
 * change to the diff made unsent comments unreachable. In PR mode the draft is
 * now ALSO stored under a stable target key derived from the PR's identity
 * (platform + host + repo + number + diff scope), so a draft saved before a
 * teammate pushed is still found after the push.
 *
 * Contract:
 *  - Without a target key (every non-PR review) every function delegates to
 *    the plain draft.ts functions with the patch key: byte-identical to before.
 *  - The patch-key lookup stays the first path. It wins whenever its draft is
 *    at least as new (by `draftGeneration`) as the target copy, so an
 *    unchanged diff restores exactly as it always has.
 *  - The target copy is stamped with `patchKey` (the patch it was saved on).
 *    When it is served for a DIFFERENT patch the response carries
 *    `patchChanged: true`, which is the client's cue to verify each line
 *    comment's recorded anchor text against the new diff.
 *  - The target key's delete tombstone guards the whole logical draft: a save
 *    whose generation is at or below it is rejected under BOTH keys, and a
 *    patch-key draft at or below it is not served. That is what keeps a draft
 *    deleted in one tab from resurrecting through a stale tab that is still
 *    looking at an older patch.
 *
 * Runtime-agnostic: node:fs via draft.ts only. Vendored to Pi.
 */

import {
  contentHash,
  deleteDraft,
  getDraftGeneration,
  getDraftTombstoneGeneration,
  loadDraft,
  saveDraft,
} from "./draft";
import type { PRDiffScope, PRMetadata } from "./pr-types";

export interface ReviewDraftKeys {
  /** contentHash of the patch on screen — the historical draft key. */
  patchKey: string;
  /** Stable PR target key; null/undefined outside PR mode. */
  targetKey?: string | null;
}

export type ReviewDraftLoadResult =
  | { found: true; draft: Record<string, unknown> }
  | { found: false; draftGeneration: number | null };

/**
 * Stable draft key for a PR/MR review target. Host, owner and repo are
 * lower-cased (both platforms treat them case-insensitively). The diff scope
 * is part of the identity because a layer diff and a full-stack diff are
 * different patches with different line coordinates for the same PR.
 */
export function prDraftTargetKey(meta: PRMetadata, scope: PRDiffScope): string {
  const identity = meta.platform === "github"
    ? `github|${meta.host.toLowerCase()}|${meta.owner.toLowerCase()}/${meta.repo.toLowerCase()}|${meta.number}`
    : `gitlab|${meta.host.toLowerCase()}|${meta.projectPath.toLowerCase()}|${meta.iid}`;
  return `pr-${contentHash(`v1|${identity}|${scope}`)}`;
}

function generationOf(value: unknown): number | null {
  const g = (value as { draftGeneration?: unknown } | null)?.draftGeneration;
  return typeof g === "number" && Number.isInteger(g) && g >= 0 ? g : null;
}

function killedByTombstone(generation: number | null, tombstone: number | null): boolean {
  return generation !== null && tombstone !== null && generation <= tombstone;
}

export function loadReviewDraft(keys: ReviewDraftKeys): ReviewDraftLoadResult {
  const { patchKey, targetKey } = keys;
  if (!targetKey) {
    const draft = loadDraft(patchKey) as Record<string, unknown> | null;
    return draft
      ? { found: true, draft }
      : { found: false, draftGeneration: getDraftGeneration(patchKey) };
  }

  const tombstone = getDraftTombstoneGeneration(targetKey);
  let patchDraft = loadDraft(patchKey) as Record<string, unknown> | null;
  if (patchDraft && killedByTombstone(generationOf(patchDraft), tombstone)) patchDraft = null;
  const targetDraft = loadDraft(targetKey) as Record<string, unknown> | null;

  if (patchDraft) {
    const patchGen = generationOf(patchDraft);
    const targetGen = generationOf(targetDraft);
    const targetIsNewer = targetDraft !== null && targetGen !== null && (patchGen === null || targetGen > patchGen);
    if (!targetIsNewer) return { found: true, draft: patchDraft };
  }

  if (targetDraft) {
    const { patchKey: savedOn, patchKeys: _remembered, ...rest } = targetDraft as { patchKey?: unknown; patchKeys?: unknown } & Record<string, unknown>;
    return {
      found: true,
      draft: savedOn === patchKey ? rest : { ...rest, patchChanged: true },
    };
  }

  const generations = [getDraftGeneration(patchKey), getDraftGeneration(targetKey)]
    .filter((g): g is number => g !== null);
  return { found: false, draftGeneration: generations.length > 0 ? Math.max(...generations) : null };
}

/** Most patch keys a target copy remembers (oldest dropped first). */
const MAX_REMEMBERED_PATCH_KEYS = 64;
const PATCH_KEY_RE = /^[0-9a-f]{16}$/;

/** Every patch key a stored target copy has been saved under (#1590). */
function rememberedPatchKeys(stored: Record<string, unknown> | null): string[] {
  if (!stored) return [];
  const list = Array.isArray(stored.patchKeys) ? stored.patchKeys : [];
  const keys = [...list, stored.patchKey].filter(
    (k): k is string => typeof k === "string" && PATCH_KEY_RE.test(k),
  );
  return [...new Set(keys)];
}

/** Returns false when the save was rejected (stale generation / tombstone). */
export function saveReviewDraft(keys: ReviewDraftKeys, body: object): boolean {
  const { patchKey, targetKey } = keys;
  if (!targetKey) return saveDraft(patchKey, body);

  if (killedByTombstone(generationOf(body), getDraftTombstoneGeneration(targetKey))) return false;
  // Never let a client-supplied field masquerade as the server's stamps.
  const { patchChanged: _changed, patchKey: _key, patchKeys: _keys, ...clean } = body as Record<string, unknown>;
  // The target copy remembers every patch it was ever saved on, so a delete
  // can reach the patch-key copies of pushes long past, not only the last one.
  const patchKeys = [...new Set([...rememberedPatchKeys(loadDraft(targetKey) as Record<string, unknown> | null), patchKey])]
    .slice(-MAX_REMEMBERED_PATCH_KEYS);
  const savedPatch = saveDraft(patchKey, clean);
  const savedTarget = saveDraft(targetKey, { ...clean, patchKey, patchKeys });
  return savedPatch || savedTarget;
}

export function deleteReviewDraft(keys: ReviewDraftKeys, draftGeneration?: number): void {
  const { patchKey, targetKey } = keys;
  if (!targetKey) {
    deleteDraft(patchKey, draftGeneration);
    return;
  }
  // Every patch-key copy the target copy was saved under is part of the same
  // logical draft, so they all go, even when no generation (and so no
  // tombstone) accompanies the delete.
  const previous = rememberedPatchKeys(loadDraft(targetKey) as Record<string, unknown> | null);
  deleteDraft(patchKey, draftGeneration);
  deleteDraft(targetKey, draftGeneration);
  for (const key of previous) if (key !== patchKey) deleteDraft(key, draftGeneration);
}

/** What a client needs after switching onto a draft target in place. */
export interface ReviewDraftState {
  /** A live draft exists for the keys now on screen. */
  found: boolean;
  /** The highest generation known for those keys (draft or tombstone). The
   *  client must raise its own counter to at least this, or every save it
   *  makes is rejected as stale. */
  draftGeneration: number | null;
}

export function reviewDraftState(keys: ReviewDraftKeys): ReviewDraftState {
  const loaded = loadReviewDraft(keys);
  if (!loaded.found) return { found: false, draftGeneration: loaded.draftGeneration };
  const gens = [generationOf(loaded.draft), getDraftGeneration(keys.patchKey), keys.targetKey ? getDraftGeneration(keys.targetKey) : null]
    .filter((g): g is number => g !== null);
  return { found: true, draftGeneration: gens.length > 0 ? Math.max(...gens) : null };
}

/**
 * Per-server-session draft bookkeeping. A PR session can move between draft
 * targets in place (/api/pr-switch, /api/pr-diff-scope) and saves one blob
 * under whichever target is on screen, so a decision must clear every PR
 * target this session wrote or restored from, not only the current one —
 * otherwise the earlier target's copy survives the submit and comes back
 * after the next push. Outside PR mode nothing is remembered and every call
 * is the plain draft.ts call.
 */
export function createReviewDraftSession() {
  const touched = new Map<string, ReviewDraftKeys>();
  const remember = (keys: ReviewDraftKeys) => {
    if (keys.targetKey) touched.set(`${keys.patchKey}|${keys.targetKey}`, { ...keys });
  };
  return {
    load(keys: ReviewDraftKeys): ReviewDraftLoadResult {
      const result = loadReviewDraft(keys);
      if (result.found) remember(keys);
      return result;
    },
    save(keys: ReviewDraftKeys, body: object): boolean {
      remember(keys);
      return saveReviewDraft(keys, body);
    },
    /** Remove only the draft on screen (client clear-all / dismiss). */
    remove(keys: ReviewDraftKeys, draftGeneration?: number): void {
      deleteReviewDraft(keys, draftGeneration);
    },
    /** A decision (feedback / exit): remove every target this session used. */
    settle(keys: ReviewDraftKeys, draftGeneration?: number): void {
      deleteReviewDraft(keys, draftGeneration);
      for (const other of touched.values()) {
        if (other.patchKey === keys.patchKey && other.targetKey === keys.targetKey) continue;
        deleteReviewDraft(other, draftGeneration);
      }
      touched.clear();
    },
    state: reviewDraftState,
  };
}
