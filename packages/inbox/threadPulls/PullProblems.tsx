/**
 * Why a thread's PRs could not be read, under what the Inbox knows about them
 * (the errors system, first slice): gh or glab missing, not signed in to that
 * host, timed out, refused, rate limited or failed, each in the one table's
 * words (`@plannotator/core/problem-words`) with its one next step, then the
 * quieter "Ask your agent to look" (problems/AskAgentToLook.tsx). The same
 * problem on several PRs is said once.
 */

import type { Problem } from '@plannotator/core/problem';
import type { InboxThreadPullWire } from '@plannotator/core/inbox-types';
import { ProblemNotice } from '@plannotator/ui/components/ProblemNotice';
import { AskAgentToLook } from '../problems/AskAgentToLook';

export interface PullProblem {
  problem: Problem;
  /** The first PR it was seen on: its tool, host and link go in the report. */
  pull: Pick<InboxThreadPullWire, 'platform' | 'host' | 'url'>;
}

/** Each distinct problem among `pulls`, in their order (one per bold line). */
export function pullProblems(pulls: readonly InboxThreadPullWire[]): PullProblem[] {
  const seen = new Set<string>();
  const out: PullProblem[] = [];
  for (const pull of pulls) {
    if (!pull.problem || seen.has(pull.problem.title)) continue;
    seen.add(pull.problem.title);
    out.push({ problem: pull.problem, pull });
  }
  return out;
}

export function PullProblems({
  problems,
  onRetry,
  retrying,
  touch,
  linked,
  threadId,
  onAsk,
}: {
  problems: readonly PullProblem[];
  onRetry?: () => void;
  retrying?: boolean;
  touch?: boolean;
  linked?: string;
  /** The thread the card belongs to: the ask goes to its agent and links back to it. */
  threadId?: string;
  /** New message opened from the ask (the card closes). */
  onAsk?: () => void;
}) {
  if (problems.length === 0) return null;
  return (
    <div className="ib-prpop-problems border-t border-border" data-pr-problems="">
      {problems.map(({ problem, pull }) => (
        <ProblemNotice
          key={problem.title}
          problem={problem}
          onRetry={onRetry}
          retrying={retrying}
          touch={touch}
          linked={linked}
          extra={
            <AskAgentToLook
              problem={problem}
              place={{ surface: 'pull_card', clis: [pull.platform === 'gitlab' ? 'glab' : 'gh'], hosts: pull.host ? [pull.host] : [], url: pull.url }}
              threadId={threadId ?? null}
              touch={touch}
              onOpen={onAsk}
            />
          }
        />
      ))}
    </div>
  );
}
