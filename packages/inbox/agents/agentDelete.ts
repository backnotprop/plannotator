/**
 * The sidebar agent's Delete … session… (AgentDeleteDialog): the launch's own Delete (`launch/:id/delete`, sent to
 * the agent's machine as the thread's is), then, when the box was ticked, each of its threads archived as a row's
 * Archive is (`resolve`, which a linked thread's id routes to its machine). Its threads are the ones the agent's
 * filter shows (model.ts `agentListFilter`), as the list holds them now.
 */
import type { InboxAgent, InboxAgentsGroup, InboxListRow } from '@plannotator/core/inbox-types';
import { InboxHeldError, inboxApi } from '../api';
import type { MachinesModel } from '../machines';
import { agentListFilter, agentRowOf } from './model';

/** The agent's threads in the list (archived ones are not in it). */
export function agentDeleteThreads(agent: InboxAgent, groups: readonly InboxAgentsGroup[] | null, machines: MachinesModel, rows: readonly InboxListRow[]): InboxListRow[] {
  const filter = agentListFilter(agent.id, groups, machines, rows);
  return rows.filter((row) => agentRowOf(row, filter, machines.self));
}

export interface AgentDeleted {
  /** The scratch folder was not the one the Inbox made, so it stays (the thread's "its scratch folder was kept"). */
  scratchKept: boolean;
  /** The threads archived, in order; one that refused is left out, and `archiveError` says why. */
  archived: string[];
  archiveError: unknown;
}

/** Delete the launch, then archive `threads` when asked. A refused Delete throws and archives nothing. */
export async function deleteAgentSession(launchId: string, machine: string | null, threads: readonly string[], archive: boolean): Promise<AgentDeleted> {
  const result = await inboxApi.launchDelete(launchId, machine);
  const archived: string[] = [];
  let archiveError: unknown = null;
  if (archive) {
    for (const threadId of threads) {
      try {
        await inboxApi.resolve(threadId, true);
        archived.push(threadId);
      } catch (cause) {
        // Held for its machine (offline): it archives there once that machine is back.
        if (cause instanceof InboxHeldError) archived.push(threadId);
        else archiveError ??= cause;
      }
    }
  }
  return { scratchKept: result.scratch_removed === false, archived, archiveError };
}
