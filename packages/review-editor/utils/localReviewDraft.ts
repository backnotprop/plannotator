import type { CodeAnnotation } from '@plannotator/ui/types';
import { missingDraftGeneration, type DraftTransport } from '@plannotator/ui/hooks/useAnnotationDraft';
import { DraftTargetChangedError } from '@plannotator/ui/hooks/useCodeAnnotationDraft';
import type { DiffFile } from '../types';
import { captureAnchor } from '@plannotator/ui/utils/codeAnnotationAnchor';

/** Older exact-patch drafts have no target stamp; adopt it once on restore. */
export function withLocalReviewTarget(
  annotations: CodeAnnotation[], target: string | null,
  files: readonly DiffFile[], snapshotId: string | undefined, patchChanged: boolean,
): CodeAnnotation[] {
  if (!target) return annotations;
  return annotations.map(a => ({
    ...a,
    localReviewTarget: a.localReviewTarget ?? target,
    // An exact-patch legacy restore can acquire an anchor now. If the patch
    // changed, absence of an anchor must instead become Outdated.
    ...(!a.anchorSnapshot && !patchChanged ? { ...captureAnchor(a, files), anchorSnapshot: snapshotId } : {}),
  }));
}

/** Pin requests to the displayed target. Another tab can switch the server's
 * current worktree while this page still has a debounced write pending.
 * clientId is stable across targets, fresh per page load, and also rides decisions. */
export function localReviewDraftTransport(target: string, clientId: string): DraftTransport {
  const url = `/api/draft?target=${encodeURIComponent(target)}&client=${encodeURIComponent(clientId)}`;
  const request = async (suffix = '', init?: RequestInit) => {
    const response = await fetch(url + suffix, { ...init, signal: AbortSignal.timeout(5000) });
    if (response.status === 409) {
      const conflict = await response.clone().json().catch(() => null);
      // Generation conflicts also use 409; those are not a target switch.
      if (conflict?.code === 'draft_target_changed') throw new DraftTargetChangedError();
    }
    if (!response.ok) throw new Error('Could not persist review draft; the review target may have changed.');
    return response;
  };
  return {
    async load() {
      const response = await request();
      if (response.status === 204) return { data: null, generation: missingDraftGeneration(response) };
      return { data: await response.json(), generation: null };
    },
    async save(body, { keepalive }) {
      await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });
    },
    async remove(generation, { keepalive }) {
      await request(`&generation=${generation}`, { method: 'DELETE', keepalive });
    },
  };
}
