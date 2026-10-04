/**
 * Code-review draft storage keyed by review TARGET as well as patch content
 * (#1590, PR and local Git reviews).
 *
 * Review drafts have always been keyed by `contentHash(rawPatch)`, so any
 * change to the diff made unsent comments unreachable. A stable target key
 * now finds the draft after edits/pushes: PR identity + scope, or canonical
 * Git worktree + branch (detached HEAD: commit) + comparison. Local patch keys
 * are scoped too, so identical patches cannot share comments or tombstones.
 *
 * Contract:
 *  - Without a target key (unsupported surfaces) every function delegates to
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
import { localGitReviewIdentity } from "./review-progress";

export interface ReviewDraftKeys {
  /** contentHash of the patch on screen — the historical draft key. */
  patchKey: string;
  /** Stable review target key; absent on unsupported surfaces. */
  targetKey?: string | null;
  /** Pre-target local drafts can still be restored on their unchanged patch. */
  legacyPatchKey?: string;
}

export async function localGitDraftTargetKey(
  input: Parameters<typeof localGitReviewIdentity>[0] & {
    /** Locally discovered default, only when automatic base upgrades are allowed. */
    defaultBase?: string;
  },
  runGit: Parameters<typeof localGitReviewIdentity>[1],
): Promise<string | null> {
  // An unpinned forwarded `main` can upgrade asynchronously to `origin/main`.
  // Use the already-discovered tracking ref from the first snapshot, so that
  // transition never strands an early draft. Explicit bases and remote-check
  // opt-outs omit defaultBase; their exact local/remote choices stay distinct.
  // This relies on local default discovery naming the network probe's tracking ref.
  const base = input.defaultBase?.startsWith("origin/") && input.base === input.defaultBase.slice("origin/".length)
    ? input.defaultBase : input.base;
  const identity = await localGitReviewIdentity({ ...input, base }, runGit);
  return identity ? `local-${contentHash(JSON.stringify(identity))}` : null;
}

/** Scope BOTH keys: identical patches on two branches/worktrees must not share
 * comments or tombstones. Legacy drafts have no identity; only an exact patch
 * can find them, and new saves migrate them into the scoped store. */
export function localReviewDraftKeys(patchKey: string, targetKey: string | null): ReviewDraftKeys {
  return targetKey
    ? { patchKey: contentHash(`${targetKey}|${patchKey}`), targetKey, legacyPatchKey: patchKey }
    : { patchKey };
}

export type ReviewDraftLoadResult =
  | { found: true; draft: Record<string, unknown> }
  | { found: false; draftGeneration: number | null };

/**
 * Stable draft key for a PR/MR review target. Host, owner and repo are
 * lower-cased (every platform treats them case-insensitively). The diff scope
 * is part of the identity because a layer diff and a full-stack diff are
 * different patches with different line coordinates for the same PR.
 */
export function prDraftTargetKey(meta: PRMetadata, scope: PRDiffScope): string {
  const identity = meta.platform === "github"
    ? `github|${meta.host.toLowerCase()}|${meta.owner.toLowerCase()}/${meta.repo.toLowerCase()}|${meta.number}`
    : meta.platform === "bitbucket"
      ? `bitbucket|${meta.host.toLowerCase()}|${meta.workspace.toLowerCase()}/${meta.repo.toLowerCase()}|${meta.number}`
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

  if (!patchDraft && !targetDraft && tombstone === null && keys.legacyPatchKey) {
    const legacy = loadDraft(keys.legacyPatchKey) as Record<string, unknown> | null;
    if (legacy) return { found: true, draft: legacy };
  }

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
  if (keys.legacyPatchKey && Array.isArray(clean.codeAnnotations)) {
    // A local session can visit several comparisons/worktrees. Its sidebar
    // keeps the session's comments, but each target persists only its own.
    clean.codeAnnotations = clean.codeAnnotations
      .filter((a) => !a.localReviewTarget || a.localReviewTarget === targetKey)
      .map((a) => ({ ...a, localReviewTarget: targetKey }));
  }
  // The target copy remembers every patch it was ever saved on, so a delete
  // can reach the patch-key copies of pushes long past, not only the last one.
  const legacyKey = keys.legacyPatchKey && loadDraft(keys.legacyPatchKey) ? keys.legacyPatchKey : undefined;
  const patchKeys = [...new Set([...rememberedPatchKeys(loadDraft(targetKey) as Record<string, unknown> | null), ...(legacyKey ? [legacyKey] : []), patchKey])]
    .slice(-MAX_REMEMBERED_PATCH_KEYS);
  const savedPatch = saveDraft(patchKey, clean);
  const savedTarget = saveDraft(targetKey, { ...clean, patchKey, patchKeys });
  if (savedTarget && legacyKey) deleteDraft(legacyKey);
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
  if (keys.legacyPatchKey && loadDraft(keys.legacyPatchKey)) previous.push(keys.legacyPatchKey);
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
 * Per-server-session draft bookkeeping. A session can move between draft
 * targets in place, so a decision must clear every
 * target this session wrote or restored from, not only the current one —
 * otherwise the earlier target's copy survives the submit and comes back
 * after the next edit. Without a target key nothing is remembered.
 */
export function createReviewDraftSession() {
  // A local sidebar lives for ONE page load, not for the server's lifetime.
  // Reloads/tabs restore only the active target: their missing comments are
  // not deletions from the earlier page's other targets. PRs keep the existing
  // server-session bookkeeping. A local caller without a page id touches only
  // the active target (older clients cannot prove ownership of another one).
  const clients = new Map<string, {
    touched: Map<string, ReviewDraftKeys>;
    savedLocalTargets: Map<string, ReviewDraftKeys>;
  }>();
  const bookkeeping = (keys: ReviewDraftKeys, clientId?: string | null) => {
    if (!keys.targetKey) return;
    if (keys.legacyPatchKey && (!clientId || !/^[a-zA-Z0-9_-]{1,128}$/.test(clientId))) return;
    const id = keys.legacyPatchKey ? `local:${clientId}` : 'pr';
    let state = clients.get(id);
    if (!state) {
      state = { touched: new Map(), savedLocalTargets: new Map() };
      clients.set(id, state);
    }
    return state;
  };
  const remember = (keys: ReviewDraftKeys, clientId?: string | null) => {
    const state = bookkeeping(keys, clientId);
    state?.touched.set(`${keys.patchKey}|${keys.targetKey}`, { ...keys });
    return state;
  };
  return {
    load(keys: ReviewDraftKeys, clientId?: string | null): ReviewDraftLoadResult {
      const result = loadReviewDraft(keys);
      if (result.found) remember(keys, clientId);
      return result;
    },
    save(keys: ReviewDraftKeys, body: object, clientId?: string | null): boolean {
      const state = remember(keys, clientId);
      const saved = saveReviewDraft(keys, body);
      if (saved && keys.legacyPatchKey && keys.targetKey && state) {
        const { savedLocalTargets } = state;
        savedLocalTargets.set(keys.targetKey, { ...keys });
        const payload = body as Record<string, unknown>;
        if (Array.isArray(payload.codeAnnotations)) {
          // The sidebar retains comments from targets visited in this session.
          // Persist edits/deletions to those comments back to their own target.
          // Never write a target merely loaded for an unaccepted restore banner.
          // Work is bounded by the targets saved during this page load.
          for (const other of savedLocalTargets.values()) {
            if (other.targetKey === keys.targetKey) continue;
            const stored = loadReviewDraft(other);
            if (!stored.found) continue; // another tab may have discarded it
            saveReviewDraft(other, {
              // Only comments changed here. Keep that target's viewed state
              // (the fallback when independent progress is unavailable).
              ...stored.draft,
              draftGeneration: payload.draftGeneration,
              ts: payload.ts,
              // Unstamped legacy comments belong only to the active target.
              codeAnnotations: payload.codeAnnotations.filter(a => a.localReviewTarget === other.targetKey),
            });
          }
        }
      }
      return saved;
    },
    /** Client clear-all / dismiss; local saved targets share the session list. */
    remove(keys: ReviewDraftKeys, draftGeneration?: number, clientId?: string | null): void {
      deleteReviewDraft(keys, draftGeneration);
      const state = bookkeeping(keys, clientId);
      if (keys.legacyPatchKey && state) {
        const { savedLocalTargets } = state;
        // Clear-all empties the local session's whole annotation list. Earlier
        // saved targets must not bring those deleted comments back on reopen.
        // An unaccepted restore banner has no saved targets and stays isolated.
        for (const other of savedLocalTargets.values()) {
          if (other.targetKey !== keys.targetKey) deleteReviewDraft(other, draftGeneration);
        }
        savedLocalTargets.clear();
      }
    },
    /** A decision (feedback / exit): remove every target this session used. */
    settle(keys: ReviewDraftKeys, draftGeneration?: number, clientId?: string | null): void {
      deleteReviewDraft(keys, draftGeneration);
      const state = bookkeeping(keys, clientId);
      if (!state) return;
      const { touched, savedLocalTargets } = state;
      for (const other of touched.values()) {
        if (other.patchKey === keys.patchKey && other.targetKey === keys.targetKey) continue;
        deleteReviewDraft(other, draftGeneration);
      }
      touched.clear();
      savedLocalTargets.clear();
    },
    state: reviewDraftState,
  };
}
