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
    const { patchKey: savedOn, ...rest } = targetDraft as { patchKey?: unknown } & Record<string, unknown>;
    return {
      found: true,
      draft: savedOn === patchKey ? rest : { ...rest, patchChanged: true },
    };
  }

  const generations = [getDraftGeneration(patchKey), getDraftGeneration(targetKey)]
    .filter((g): g is number => g !== null);
  return { found: false, draftGeneration: generations.length > 0 ? Math.max(...generations) : null };
}

/** Returns false when the save was rejected (stale generation / tombstone). */
export function saveReviewDraft(keys: ReviewDraftKeys, body: object): boolean {
  const { patchKey, targetKey } = keys;
  if (!targetKey) return saveDraft(patchKey, body);

  if (killedByTombstone(generationOf(body), getDraftTombstoneGeneration(targetKey))) return false;
  // Never let a client-supplied field masquerade as the server's stamp.
  const { patchChanged: _changed, patchKey: _key, ...clean } = body as Record<string, unknown>;
  const savedPatch = saveDraft(patchKey, clean);
  const savedTarget = saveDraft(targetKey, { ...clean, patchKey });
  return savedPatch || savedTarget;
}

export function deleteReviewDraft(keys: ReviewDraftKeys, draftGeneration?: number): void {
  const { patchKey, targetKey } = keys;
  if (!targetKey) {
    deleteDraft(patchKey, draftGeneration);
    return;
  }
  // The target copy names the patch it was last saved on; that patch-key
  // copy is part of the same logical draft, so it goes too.
  const stored = loadDraft(targetKey) as { patchKey?: unknown } | null;
  const previousPatchKey = typeof stored?.patchKey === "string" ? stored.patchKey : null;
  deleteDraft(patchKey, draftGeneration);
  deleteDraft(targetKey, draftGeneration);
  if (previousPatchKey && previousPatchKey !== patchKey && /^[0-9a-f]{16}$/.test(previousPatchKey)) {
    deleteDraft(previousPatchKey, draftGeneration);
  }
}
