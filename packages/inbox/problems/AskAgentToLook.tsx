/**
 * "Ask your agent to look" (the errors system; the owner's words and call, 2026-11-11): one quiet action on a problem,
 * after its own next step. One press opens New message already filled in (compose/openComposer.ts): To the agent that
 * owns the thread where it happened (still changeable), else To's own list; the thread's name "Look into: <the bold
 * line>"; and a body that is the report itself, readable before Send (`problemReport`, packages/core/problem-report.ts),
 * which also asks the agent to offer the person, once, to send an anonymous report to Plannotator. Send is the only step.
 *
 * Reusable: any problem with a tool and a place can carry it. Today: the PR card's six tool states, the Pull requests
 * page's lines and a link's hover card.
 */
import { useState } from 'react';
import type { Problem } from '@plannotator/core/problem';
import { problemReport, type ProblemPlace } from '@plannotator/core/problem-report';
import { inboxApi, type InboxProblemFacts } from '../api';
import { openComposer } from '../compose/openComposer';
import { noticeProblem, type PullsNotice } from '../pulls/notices';

export const ASK_AGENT_WORDS = { button: 'Ask your agent to look', busy: 'Opening…' } as const;

/** A Pull requests notice's "Ask your agent to look", when its line is a tool's state (`noticeProblem`). */
export function NoticeAsk({ notice, lead = ' · ' }: { notice: PullsNotice; lead?: string }) {
  const problem = noticeProblem(notice);
  if (!problem || !notice.tool) return null;
  return (
    <>
      {lead}
      <AskAgentToLook problem={problem} place={{ surface: 'pulls_page', clis: notice.tool.clis, hosts: notice.tool.hosts }} inline />
    </>
  );
}

/** Read what the Inbox knows (never longer than PROBLEM_FACTS_READ_MS), then open New message filled in. */
export async function askAgentToLook(problem: Problem, place: Omit<ProblemPlace, 'thread'>, threadId: string | null): Promise<void> {
  let facts: InboxProblemFacts = {};
  try {
    facts = await inboxApi.problemFacts({ clis: place.clis, host: place.hosts[0] ?? null, thread: threadId });
  } catch {
    // Offline, slow or an older Inbox: the message opens with what the window knows.
  }
  const thread = threadId ? { id: threadId, link: facts.thread?.link || null } : null;
  const { subject, body } = problemReport(problem, { ...place, thread }, facts);
  const session = facts.thread?.session;
  openComposer({ subject, body, to: session ? { session } : 'pick' });
}

export function AskAgentToLook({
  problem,
  place,
  threadId = null,
  touch = false,
  inline = false,
  onOpen,
}: {
  problem: Problem;
  place: Omit<ProblemPlace, 'thread'>;
  /** The thread the problem showed in: New message goes to its agent and the report links back to it. */
  threadId?: string | null;
  /** Larger target (a phone's sheet). */
  touch?: boolean;
  /** Inside a line of text (the Pull requests page's notices): the line's own size, no box. */
  inline?: boolean;
  /** Called as New message opens (a popover closes, so compose is in view). */
  onOpen?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={
        inline
          ? 'ib-ask-look-inline'
          : `${touch ? 'min-h-11 px-1' : 'h-7 px-0.5'} rounded-md text-[11.5px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground disabled:opacity-60`
      }
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await askAgentToLook(problem, place, threadId);
          onOpen?.();
        } finally {
          setBusy(false);
        }
      }}
      data-problem-ask=""
    >
      {busy ? ASK_AGENT_WORDS.busy : ASK_AGENT_WORDS.button}
    </button>
  );
}
