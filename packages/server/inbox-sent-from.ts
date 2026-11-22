/**
 * Where the person wrote a message (`InboxMessage.sent_from`, packages/core/inbox-sent-from.ts), told from facts the
 * server holds about the request, never from the page: which listener took it (the window's loopback port, the
 * tailnet's, the Cloudflare Access door), whether this computer opened the tailnet address itself, and the device door's
 * caller (a paired phone, or a linked computer with the place its own Inbox told the same way). See "Where the person
 * wrote it" in docs/agent-guides/inbox-messages.md.
 */
import { isInboxSentFromPlace, type InboxSentFrom, type InboxSentFromPlace } from "@plannotator/core/inbox-types";
import { AGENT_PLATFORM, MACHINE_PLATFORM } from "./inbox-devices";
import { inboxMachineRecordName } from "./inbox-sent-from-reader";

export interface InboxSentFromFacts {
  /** The listener: the window's loopback port, or the tailnet's (the Cloudflare door dispatches as the tailnet too). */
  via: "local" | "tailnet";
  /** A browser on this computer opened the tailnet address (inbox-tailscale.ts `ownNode`). */
  ownNode: boolean;
  /** It came through the Cloudflare Access door (inbox-cf-access.ts). */
  cloudflare: boolean;
  /**
   * It carries this computer's window's marks (`isWindowRequest`, inbox-cross-site.ts: an Origin that is this Host, and
   * this run's `serverSession` in the body), the bar a permission prompt's answer has. A program's bare call (the CLI,
   * an agent, a script) has none; one that imitates the window is accepted, as everywhere else. Absent: false.
   */
  window?: boolean;
  /**
   * The device door's caller after its token was checked; null when the request did not come through the door.
   * `machineName`: the name this Inbox shows for a linked computer; `deviceName`: its paired device's name, used when
   * the first is missing or nothing is left of it once cleaned.
   */
  door: { platform: string; machineName: string | null; deviceName?: string | null; place: InboxSentFromPlace | null } | null;
}

/**
 * Null: nothing the server can vouch for (a program on this computer, among others). Then the message records nothing.
 * `here`: this computer's own window, on its loopback port or its own tailnet address opened here; never the door.
 */
export function inboxRequestSentFrom(facts: InboxSentFromFacts): InboxSentFrom | null {
  const { door } = facts;
  if (door) {
    if (door.platform === MACHINE_PLATFORM) {
      // Cleaned as the line reads it (one line, no controls, 64 characters), so the record holds what the agent reads.
      const name = inboxMachineRecordName(door.machineName, door.deviceName);
      return name ? { kind: "machine", name, ...(door.place ? { via: door.place } : {}) } : null;
    }
    // A cloud agent is never the person, and its token is refused at the door anyway.
    if (door.platform === AGENT_PLATFORM) return null;
    return { kind: "phone" };
  }
  if (facts.cloudflare) return { kind: "cloudflare" };
  if (facts.via === "tailnet" && !facts.ownNode) return { kind: "tailnet" };
  return facts.window ? { kind: "here" } : null;
}

/**
 * What a linked computer says on with a write it forwards: where the person was when it was not that computer's own
 * window (its own window, `here`, says nothing). A computer never passes on another computer's word (no Inbox forwards
 * one machine's writes to a third).
 */
export function inboxForwardedPlace(from: InboxSentFrom | null): InboxSentFromPlace | null {
  return from && isInboxSentFromPlace(from.kind) ? from.kind : null;
}
