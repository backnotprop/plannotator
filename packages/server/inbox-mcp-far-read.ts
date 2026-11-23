/**
 * read_thread of a thread on a linked machine (inbox-far-read.ts): the same read, options and text as a local one,
 * with a first line that says which computer it is on. Only for an id this Inbox's store does not hold. A paired cloud
 * agent reads them too (the person's computer asks for it), and its fetch_file of their files comes in pieces the same
 * way (`filePieceOnMachine`).
 */

import type { InboxStore } from "@plannotator/shared/inbox/store";
import { FAR_READ_WORDS, farAnswerCleaned, farThreadReadText, machineNameWords, type FarReadAnswer, type FarReadAsk } from "./inbox-far-read";
import { ok, okComplete, type ToolResult } from "./inbox-mcp-result";
import type { FarFilePiece } from "./inbox-machine-agent-piece";

export interface InboxFarReadMcpContext {
  store: InboxStore;
  baseUrl: () => string;
  /** Through the agent door: a paired cloud agent. */
  cloudAgent?: { homeRoot: string };
  /**
   * A thread a linked machine holds, read there (inbox-machine-agent-read.ts). Null: no linked machine holds it.
   * Throws when it is there and cannot be read now. Absent: no machines here.
   */
  readOnMachine?: (ask: FarReadAsk) => Promise<{ machine: string; name: string; answer: FarReadAnswer } | null>;
  /**
   * One piece of a file of a message a linked machine holds, for a paired cloud agent's fetch_file (the pieces
   * protocol, inbox-machine-agent-piece.ts). Null: no machine is linked. Absent: no machines here.
   */
  filePieceOnMachine?: (args: { message_id: string; file: string }, offset: number) => Promise<FarFilePiece | null>;
  /** The name of the linked machine whose list names this thread id, or null. Absent: no machines here. */
  farThreadMachine?: (threadId: string) => string | null;
}

/** Where a thread an id names lives: "<id> is a thread on <machine>." (send_message's and resolve_message's refusals). */
export const farThreadWords = (id: string, machine: string): string => `${id} is a thread on ${machineNameWords(machine)}.`;

/** DRAFT words (the owner's to approve): send_message's reply_to names a thread on a linked machine. */
export const farReplyRefusal = (id: string, machine: string): string =>
  `${farThreadWords(id, machine)} You can read it with read_thread, but replying there is not available from this computer yet.`;

/** Whether a read names an id this store does not hold, so a linked machine may. */
function farCandidate(store: InboxStore, input: FarReadAsk): boolean {
  if (input.thread_id) return !store.message(input.thread_id);
  return !!input.message_id && !store.message(input.message_id);
}

/** The far read, or null when it is not one (the caller reads here, and says "No thread …" as before). */
export async function farThreadRead(context: InboxFarReadMcpContext, input: FarReadAsk): Promise<ToolResult | null> {
  if (!context.readOnMachine || !farCandidate(context.store, input)) return null;
  const far = await context.readOnMachine(input);
  if (!far) return null;
  const { machine } = far;
  // What this computer prints of the far read: no far command, escape or control character (inbox-far-read.ts).
  const answer = farAnswerCleaned(far.answer);
  const url = `${context.baseUrl()}#thread=${answer.thread_id}`;
  const where = { id: machine, name: far.name };
  if ("full" in answer) {
    const thread = answer.full as { messages: { author?: { kind?: string } }[]; subject?: string | null; resolved_at?: string | null };
    const replies = thread.messages.filter((m) => m.author?.kind === "person").length;
    const n = thread.messages.length;
    const subject = typeof thread.subject === "string" ? thread.subject.replace(/\s+/g, " ").trim() : "";
    return ok(
      `${FAR_READ_WORDS.on(machineNameWords(far.name))} Thread ${answer.thread_id}${subject ? ` (${subject})` : ""}: ${n} message${n === 1 ? "" : "s"}, ${replies} from the person${thread.resolved_at ? ", resolved" : ""}.`,
      { thread, url, machine: where },
    );
  }
  const { text, result } = farThreadReadText(answer, far.name, url);
  return okComplete(text, { ...result, machine: where, ...(answer.steps ? { steps: answer.steps } : {}), ...(answer.pulls ? { pulls: answer.pulls } : {}) });
}
