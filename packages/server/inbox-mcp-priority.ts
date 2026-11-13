/**
 * Thread priority, the agent's side: send_message's `priority` field and the
 * line its result adds. The ask is kept on the message (store.sendMessage);
 * the list model derives the row's `priority.ask` from it on every read, so
 * nothing here is written or cleared.
 */

import { z } from "zod";
import { INBOX_PRIORITY_FIELD_DESCRIPTION } from "@plannotator/shared/inbox/connection";
import type { InboxSendResult } from "@plannotator/shared/inbox/store";

/** send_message's `priority` field (approval "inbox-thread-priority"). */
export const PRIORITY_FIELD = z.string().describe(INBOX_PRIORITY_FIELD_DESCRIPTION);

/** The result's line when the message's ask was kept. */
export const INBOX_PRIORITY_SET_TEXT = " In the person's Priority.";

/** The result's line when the person had taken this thread out of Priority and not written in it since. */
export const INBOX_PRIORITY_REMOVED_TEXT = " Not in Priority: the person took this thread out until they next write in it.";

/** The line send_message's result adds after its PRs line: "" when the send asked no Priority. */
export function priorityLine(priority: InboxSendResult["priority"] | null): string {
  if (priority === "set") return INBOX_PRIORITY_SET_TEXT;
  if (priority === "removed_by_person") return INBOX_PRIORITY_REMOVED_TEXT;
  return "";
}
