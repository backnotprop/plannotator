/**
 * A reply sent to a new session in place of the one that ended (the reply box's "New Claude Code session" row):
 * `POST /api/inbox/messages/:id/reply` with `to: { launch: { agent, project_id, model?, effort?, primary_agent? } }`, compose's shape
 * (inbox-launch.ts `target`). It is checked and prepared before anything is written, as New message's launch is; the
 * reply then carries the launch and its placeholder `to` (`{ agent, launch:<id> }`) and takes the thread over, and the
 * agent starts only once the reply is written (`settle`). A replayed key answers the reply it wrote and starts nothing.
 * No Trust and start here: an untrusted folder's start fails, and its run line offers Trust folder.
 */

import type { InboxLaunchFrom, InboxMessage, InboxProject } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxLaunch } from "./inbox-launch";
import { INBOX_MACHINE_WINDOW_ONLY_BODY } from "./inbox-cross-site";
import { replacesEndedAsker, thereInThread } from "./inbox-sessions";

/** Whether a reply's `to` asks for a new session. */
export function replyStartsSession(to: unknown): boolean {
  return !!to && typeof to === "object" && "launch" in to;
}

type Prepared = Awaited<ReturnType<InboxLaunch["prepare"]>>;

/** A linked machine asked through this machine's door; `window`: for a press in a window there. */
export interface ReplyLaunchDoor {
  from: InboxLaunchFrom | null;
  window: boolean;
}

const LAUNCH_OFF_HERE = "Starting agents from the Inbox is off. Turn it on in Settings → Agents.";
const LAUNCH_OFF_THERE = "Starting agents is off on that computer. Turn it on in its Settings → Agents.";

/**
 * Why a reply may not start a new session, the first that applies, or null. In this order: a linked machine's call
 * that no press in its window made (never an agent's), the switch off (its words say how to turn it on), then a
 * session asked that is still there (it gets the reply itself).
 */
export function replyLaunchRefusal(input: { door: ReplyLaunchDoor | null; switchOn: boolean; askerEnded: () => boolean }): InboxError | null {
  if (input.door && !input.door.window) return new InboxError("window_only", INBOX_MACHINE_WINDOW_ONLY_BODY.error);
  if (!input.switchOn) return new InboxError("launch_off", input.door ? LAUNCH_OFF_THERE : LAUNCH_OFF_HERE);
  if (!input.askerEnded()) return new InboxError("session_still_live", "That session is still running, so it still gets this. Nothing was changed.");
  return null;
}

export function createInboxReplyLaunch(options: {
  store: { replyByKey(messageId: string, key: string): InboxMessage | null; message(id: string): InboxMessage | null | undefined };
  launch: Pick<InboxLaunch, "enabled" | "target" | "prepare" | "abandon" | "begin" | "resumes" | "gone">;
  live: { askerLive(session: string): boolean };
  resolveProject: (path: string) => Promise<InboxProject>;
}) {
  return {
    /**
     * The launch a reply starts, or null when the key was sent already (the store answers the reply it wrote).
     * `door`: a linked machine asked (remote launch); its machine is recorded on the launch and named in refusals.
     */
    async prepare(messageId: string, body: Record<string, unknown>, door: ReplyLaunchDoor | null): Promise<Prepared | null> {
      if (door && !door.window) throw replyLaunchRefusal({ door, switchOn: true, askerEnded: () => true })!;
      const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
      if (key && options.store.replyByKey(messageId, key)) return null;
      const answered = options.store.message(messageId);
      if (!answered) throw new InboxError("message_not_found", `No message ${messageId}.`);
      // Only in place of a session that ended, as the window offers it: a session still there gets the reply itself.
      const refused = replyLaunchRefusal({
        door,
        switchOn: options.launch.enabled(),
        askerEnded: () => replacesEndedAsker(answered, thereInThread(options.live, options.launch, answered.thread_id)),
      });
      if (refused) throw refused;
      const from = door?.from ?? null;
      const asked = (body.to as { launch: unknown }).launch;
      const value = asked && typeof asked === "object" ? (asked as Record<string, unknown>) : {};
      // Only the agent, the project and the machine's model, effort and OpenCode agent: a reply never trusts a folder or makes one.
      const to = {
        launch: {
          agent: value.agent,
          project_id: value.project_id,
          ...(value.model !== undefined ? { model: value.model } : {}),
          ...(value.effort !== undefined ? { effort: value.effort } : {}),
          ...(value.primary_agent !== undefined ? { primary_agent: value.primary_agent } : {}),
        },
      };
      const target = options.launch.target(to);
      if (!target) throw new InboxError("launch_off", door ? LAUNCH_OFF_THERE : LAUNCH_OFF_HERE);
      return options.launch.prepare(target, { name: null, body: typeof body.words === "string" ? body.words : "", resolveProject: options.resolveProject, from });
    },

    /** After the reply's write: start the agent for a reply just written; a replay, or a write that failed (`reply` null), starts nothing. */
    settle(prepared: Prepared | null, reply: { message: InboxMessage; replayed: boolean } | null): void {
      if (!prepared) return;
      if (!reply || reply.replayed) options.launch.abandon(prepared.launch, prepared.project);
      else options.launch.begin(reply.message);
    },
  };
}
