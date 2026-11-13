/**
 * Thread priority, the agent's side: send_message's `priority` field and the line its result adds. The agent's
 * mark is the person's own (store.setPriority): it shows in the Priority group and stays until the agent or the
 * person takes it out.
 */

import { z } from "zod";
import { INBOX_PRIORITY_FIELD_DESCRIPTION } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** send_message's `priority` field (approval "inbox-thread-priority"). */
export const PRIORITY_FIELD = z.boolean().describe(INBOX_PRIORITY_FIELD_DESCRIPTION);

/** The result's line after `priority: true`. */
export const INBOX_PRIORITY_IN_TEXT = " In the person's Priority.";

/** The result's line after `priority: false`. */
export const INBOX_PRIORITY_OUT_TEXT = " Out of the person's Priority.";

/**
 * Marks or unmarks the thread the message landed in. Null when the send passed no `priority`, or the store refused
 * (a thread the list does not draw); the send itself already went through.
 */
export function applyAgentPriority(store: InboxStore, threadId: string, priority: boolean | undefined): boolean | null {
  if (priority === undefined) return null;
  try {
    store.setPriority(threadId, priority);
    return priority;
  } catch {
    return null;
  }
}

/** The line send_message's result adds after its PRs line: "" when the send passed no `priority`. */
export function priorityLine(priority: boolean | null): string {
  if (priority === true) return INBOX_PRIORITY_IN_TEXT;
  if (priority === false) return INBOX_PRIORITY_OUT_TEXT;
  return "";
}
