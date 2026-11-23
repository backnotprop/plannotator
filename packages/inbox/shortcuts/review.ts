/**
 * The review's keys in the Inbox (approval 2026-11-23: "Yes, the same keys as code review" and "Yes, the review's
 * keys win while a review is open"). While a PR's page in Reviews or a guided review is on screen, the code review
 * app's own scopes (packages/ui/shortcuts/code-review/, packages/review-editor/shortcuts.ts) listen first, in the
 * capture phase, and a key they take is `preventDefault`ed: every Inbox key stands down on a used key
 * (`bareKeyAllowed`), so J, K, N, Z, C, `[`, `]` and the arrows mean what they mean in code review until the review
 * leaves the screen. guide/ReviewKeys.tsx (the reader's chunk) claims them here; the map (ShortcutMap.tsx) reads
 * the claim to show the review's keys and leave out the Inbox's meanings they replace.
 */
import { useSyncExternalStore } from 'react';
import type { ShortcutScopeDefinition } from '@plannotator/ui/shortcuts';

export interface ReviewKeyRef {
  scope: ShortcutScopeDefinition<any>;
  action: string;
}

export interface OpenReviewKeys {
  /** The code review surface's title (codeReviewSurface), the map's heading for these keys. */
  title: string;
  /** Rows of keys that act here, each one row of the map (its words: the first action's description). */
  rows: readonly (readonly ReviewKeyRef[])[];
  /** Every binding the review takes while it is open, acting or not: the Inbox's meaning of each is away. */
  claimed: ReadonlySet<string>;
  /**
   * Whether the review has its keys right now: not while they stand down (focus in the PR's Details, a repository file
   * over the diff, a menu or a dialog open). While they stand down the keys are the Inbox's again.
   */
  live: () => boolean;
}

const claims: OpenReviewKeys[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

/** A review on screen takes its keys; the returned function gives them back (the review left the screen). */
export function claimReviewKeys(keys: OpenReviewKeys): () => void {
  claims.push(keys);
  emit();
  return () => {
    const at = claims.indexOf(keys);
    if (at === -1) return;
    claims.splice(at, 1);
    emit();
  };
}

/** The review whose keys are live, the latest one drawn; null with no review on screen. */
export function openReviewKeys(): OpenReviewKeys | null {
  return claims[claims.length - 1] ?? null;
}

/** The review whose keys act now: the open one while it has them; null while there is none or they stand down. */
export function liveReviewKeys(): OpenReviewKeys | null {
  const keys = openReviewKeys();
  return keys?.live() ? keys : null;
}

/** Where focus moves or a press lands (Details, a menu, a sheet opening or closing): the keys may change hands. */
const HANDOVERS = ['focusin', 'focusout', 'pointerup', 'keyup'] as const;

/** liveReviewKeys, kept current: what the Undo toast offers follows whose Z it is. */
export function useLiveReviewKeys(): OpenReviewKeys | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      for (const type of HANDOVERS) window.addEventListener(type, listener, true);
      return () => {
        listeners.delete(listener);
        for (const type of HANDOVERS) window.removeEventListener(type, listener, true);
      };
    },
    liveReviewKeys,
    () => null,
  );
}

export function useOpenReviewKeys(): OpenReviewKeys | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openReviewKeys,
    () => null,
  );
}
