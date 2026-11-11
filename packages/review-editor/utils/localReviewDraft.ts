import type { CodeAnnotation } from '@plannotator/ui/types';
import type { DraftTransport } from '@plannotator/ui/hooks/useAnnotationDraft';
import { DraftTargetChangedError } from '@plannotator/ui/hooks/useCodeAnnotationDraft';
import type { DiffFile } from '../types';
import { captureAnchor } from '@plannotator/ui/utils/codeAnnotationAnchor';

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

export function localReviewDraftTransport(target: string, clientId: string): DraftTransport {
  const url = `/api/draft?target=${encodeURIComponent(target)}&client=${encodeURIComponent(clientId)}`;
  const request = async (suffix = '', init?: RequestInit) => {
    const response = await fetch(url + suffix, { ...init, signal: AbortSignal.timeout(5000) });
    if (response.status === 409) {
      const conflict = await response.clone().json().catch(() => null);
      if (conflict?.code === 'draft_target_changed') throw new DraftTargetChangedError();
    }
    if (!response.ok && !(response.status === 404 && !init?.method)) throw new Error('Could not persist review draft; the review target may have changed.');
    return response;
  };
  return {
    async load() {
      const response = await request();
      const data = await response.json();
      return response.ok ? { data, generation: null } : { data: null, generation: data.draftGeneration ?? null };
    },
    async save(body, { keepalive }) {
      await request('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });
    },
    async remove(generation, { keepalive }) {
      await request(`&generation=${generation}`, { method: 'DELETE', keepalive });
    },
  };
}
