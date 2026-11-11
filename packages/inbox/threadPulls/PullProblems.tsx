/**
 * Why a thread's PRs could not be read, under what the Inbox knows about them
 * (the errors system, first slice): gh or glab missing, not signed in to that
 * host, timed out, refused, rate limited or failed, each in the one table's
 * words (`@plannotator/core/problem-words`) with its one next step. The same
 * problem on several PRs is said once.
 */

import type { Problem } from '@plannotator/core/problem';
import type { InboxThreadPullWire } from '@plannotator/core/inbox-types';
import { ProblemNotice } from '@plannotator/ui/components/ProblemNotice';

/** Each distinct problem among `pulls`, in their order (one per bold line). */
export function pullProblems(pulls: readonly InboxThreadPullWire[]): Problem[] {
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const pull of pulls) {
    if (!pull.problem || seen.has(pull.problem.title)) continue;
    seen.add(pull.problem.title);
    out.push(pull.problem);
  }
  return out;
}

export function PullProblems({ problems, onRetry, retrying, touch, linked }: { problems: readonly Problem[]; onRetry?: () => void; retrying?: boolean; touch?: boolean; linked?: string }) {
  if (problems.length === 0) return null;
  return (
    <div className="ib-prpop-problems border-t border-border" data-pr-problems="">
      {problems.map((problem) => (
        <ProblemNotice key={problem.title} problem={problem} onRetry={onRetry} retrying={retrying} touch={touch} linked={linked} />
      ))}
    </div>
  );
}
