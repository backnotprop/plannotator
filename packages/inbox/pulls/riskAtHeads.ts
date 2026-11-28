/**
 * The risk answer as every reader of it should see it (the list's marks, the PR page's "See the N places", the
 * review's header and bars): a judgment made at another head than the one the list shows keeps its level and its
 * sentence, but not its places. The window holds the last risk answer across a failed read, so after a push the
 * judgment it holds can be the earlier head's, and its lines may say something else now. A judgment with no `head`
 * (from a server from before it) cannot be told stale and keeps its places.
 */
import type { InboxPull, InboxPullRiskAnswer } from '@plannotator/core/inbox-types';

export function riskAnswerAtHeads(answer: InboxPullRiskAnswer | null, pulls: readonly Pick<InboxPull, 'key' | 'head_sha'>[]): InboxPullRiskAnswer | null {
  if (!answer) return answer;
  const heads = new Map(pulls.map((pull) => [pull.key, pull.head_sha] as const));
  let judgments: InboxPullRiskAnswer['judgments'] | null = null;
  for (const [key, judgment] of Object.entries(answer.judgments)) {
    const head = heads.get(key);
    if (!judgment.where || judgment.head === undefined || !head || head === judgment.head) continue;
    const { where: _where, ...kept } = judgment;
    judgments ??= { ...answer.judgments };
    judgments[key] = kept;
  }
  return judgments ? { ...answer, judgments } : answer;
}

/** The list a risk read follows (`usePullRisk`'s `listVersion`), when it is one. */
export function listedPulls(listVersion: unknown): readonly Pick<InboxPull, 'key' | 'head_sha'>[] | null {
  const pulls = listVersion && typeof listVersion === 'object' ? (listVersion as { pulls?: unknown }).pulls : null;
  return Array.isArray(pulls) ? (pulls as Pick<InboxPull, 'key' | 'head_sha'>[]) : null;
}
