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
  patchKey: string;
  targetKey?: string | null;
  legacyPatchKey?: string;
}

export const LOCAL_DRAFT_TARGET_TIMEOUT_MS = 2000;

export async function localGitDraftTargetKey(
  input: Parameters<typeof localGitReviewIdentity>[0] & {
    defaultBase?: string;
  },
  runGit: Parameters<typeof localGitReviewIdentity>[1],
): Promise<string | null> {
  const base = input.defaultBase?.startsWith("origin/") && input.base === input.defaultBase.slice("origin/".length)
    ? input.defaultBase : input.base;
  const identity = await localGitReviewIdentity(
    { ...input, base },
    (args, options) => runGit(args, { ...options, timeoutMs: LOCAL_DRAFT_TARGET_TIMEOUT_MS }),
  );
  return identity ? `local-${contentHash(JSON.stringify(identity))}` : null;
}

export function localReviewDraftKeys(patchKey: string, targetKey: string | null): ReviewDraftKeys {
  return targetKey
    ? { patchKey: contentHash(`${targetKey}|${patchKey}`), targetKey, legacyPatchKey: patchKey }
    : { patchKey };
}

export type ReviewDraftLoadResult =
  | { found: true; draft: Record<string, unknown> }
  | { found: false; draftGeneration: number | null };

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

const MAX_REMEMBERED_PATCH_KEYS = 64;
const PATCH_KEY_RE = /^[0-9a-f]{16}$/;

function rememberedPatchKeys(stored: Record<string, unknown> | null): string[] {
  if (!stored) return [];
  const list = Array.isArray(stored.patchKeys) ? stored.patchKeys : [];
  const keys = [...list, stored.patchKey].filter(
    (k): k is string => typeof k === "string" && PATCH_KEY_RE.test(k),
  );
  return [...new Set(keys)];
}

export function saveReviewDraft(keys: ReviewDraftKeys, body: object): boolean {
  const { patchKey, targetKey } = keys;
  if (!targetKey) return saveDraft(patchKey, body);

  if (killedByTombstone(generationOf(body), getDraftTombstoneGeneration(targetKey))) return false;
  const { patchChanged: _changed, patchKey: _key, patchKeys: _keys, ...clean } = body as Record<string, unknown>;
  if (keys.legacyPatchKey && Array.isArray(clean.codeAnnotations)) {
    clean.codeAnnotations = clean.codeAnnotations
      .filter((a) => !a.localReviewTarget || a.localReviewTarget === targetKey)
      .map((a) => ({ ...a, localReviewTarget: targetKey }));
  }
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
  const previous = rememberedPatchKeys(loadDraft(targetKey) as Record<string, unknown> | null);
  if (keys.legacyPatchKey && loadDraft(keys.legacyPatchKey)) previous.push(keys.legacyPatchKey);
  deleteDraft(patchKey, draftGeneration);
  deleteDraft(targetKey, draftGeneration);
  for (const key of previous) if (key !== patchKey) deleteDraft(key, draftGeneration);
}

export interface ReviewDraftState {
  found: boolean;
  draftGeneration: number | null;
}

export function reviewDraftState(keys: ReviewDraftKeys): ReviewDraftState {
  const loaded = loadReviewDraft(keys);
  if (!loaded.found) return { found: false, draftGeneration: loaded.draftGeneration };
  const gens = [generationOf(loaded.draft), getDraftGeneration(keys.patchKey), keys.targetKey ? getDraftGeneration(keys.targetKey) : null]
    .filter((g): g is number => g !== null);
  return { found: true, draftGeneration: gens.length > 0 ? Math.max(...gens) : null };
}

export function createReviewDraftSession() {
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
          for (const other of savedLocalTargets.values()) {
            if (other.targetKey === keys.targetKey) continue;
            const stored = loadReviewDraft(other);
            if (!stored.found) continue;
            saveReviewDraft(other, {
              ...stored.draft,
              draftGeneration: payload.draftGeneration,
              ts: payload.ts,
              codeAnnotations: payload.codeAnnotations.filter(a => a.localReviewTarget === other.targetKey),
            });
          }
        }
      }
      return saved;
    },
    remove(keys: ReviewDraftKeys, draftGeneration?: number, clientId?: string | null): void {
      deleteReviewDraft(keys, draftGeneration);
      const state = bookkeeping(keys, clientId);
      if (keys.legacyPatchKey && state) {
        const { savedLocalTargets } = state;
        for (const other of savedLocalTargets.values()) {
          if (other.targetKey !== keys.targetKey) deleteReviewDraft(other, draftGeneration);
        }
        savedLocalTargets.clear();
      }
    },
    settle(keys: ReviewDraftKeys, draftGeneration?: number, clientId?: string | null): void {
      deleteReviewDraft(keys, draftGeneration);
      const state = bookkeeping(keys, clientId) ?? (!keys.targetKey && clientId ? clients.get(`local:${clientId}`) : undefined);
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
