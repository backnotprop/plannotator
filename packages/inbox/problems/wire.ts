/**
 * The Inbox API's side of "Ask your agent to look" (the errors system), kept out of api.ts: its facts read's query
 * and answer.
 */
import type { ProblemFacts } from '@plannotator/core/problem-report';
import { machineOf } from '../inboxUrl';

/** "Ask your agent to look" waits at most this long for the Inbox's facts, then opens the message with what it has. */
export const PROBLEM_FACTS_READ_MS = 4_000;

/** The Inbox's answer for a problem's report (packages/server/inbox-problem-facts.ts). */
export type InboxProblemFacts = ProblemFacts & { thread?: { session: string | null; link: string } };

/** `/problem-facts`' query: the tools, the forge host, and the thread when it is on this machine. */
export function problemFactsQuery(query: { clis: readonly string[]; host?: string | null; thread?: string | null }): string {
  const params = new URLSearchParams();
  for (const cli of query.clis) params.append('cli', cli);
  if (query.host) params.set('host', query.host);
  if (query.thread && !machineOf(query.thread)) params.set('thread', query.thread);
  return params.toString();
}
