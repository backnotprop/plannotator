/**
 * Where the person wrote a message (`InboxMessage.sent_from`, packages/core/inbox-sent-from.ts), told from facts the
 * server holds about the request, never from the page: which listener took it (the window's loopback port, the
 * tailnet's, the Cloudflare Access door), whether this computer opened the tailnet address itself, and the device door's
 * caller (a paired phone, or a linked computer with the place its own Inbox told the same way). See "Where the person
 * wrote it" in docs/agent-guides/inbox-messages.md.
 */
import type { InboxSentFrom, InboxSentFromPlace } from "@plannotator/core/inbox-types";
import { AGENT_PLATFORM, MACHINE_PLATFORM } from "./inbox-devices";

export interface InboxSentFromFacts {
  /** The listener: the window's loopback port, or the tailnet's (the Cloudflare door dispatches as the tailnet too). */
  via: "local" | "tailnet";
  /** A browser on this computer opened the tailnet address (inbox-tailscale.ts `ownNode`). */
  ownNode: boolean;
  /** It came through the Cloudflare Access door (inbox-cf-access.ts). */
  cloudflare: boolean;
  /** The device door's caller after its token was checked; null when the request did not come through the door. */
  door: { platform: string; machineName: string | null; place: InboxSentFromPlace | null } | null;
}

/** Null: this computer, or nothing the server can vouch for. Then the message records nothing. */
export function inboxRequestSentFrom(facts: InboxSentFromFacts): InboxSentFrom | null {
  const { door } = facts;
  if (door) {
    if (door.platform === MACHINE_PLATFORM) {
      const name = door.machineName?.trim();
      return name ? { kind: "machine", name, ...(door.place ? { via: door.place } : {}) } : null;
    }
    // A cloud agent is never the person, and its token is refused at the door anyway.
    if (door.platform === AGENT_PLATFORM) return null;
    return { kind: "phone" };
  }
  if (facts.cloudflare) return { kind: "cloudflare" };
  if (facts.via === "tailnet") return facts.ownNode ? null : { kind: "tailnet" };
  return null;
}

/**
 * What a linked computer says on with a write it forwards: where the person was when it was not that computer's own
 * window. A computer never passes on another computer's word (no Inbox forwards one machine's writes to a third).
 */
export function inboxForwardedPlace(from: InboxSentFrom | null): InboxSentFromPlace | null {
  return from && from.kind !== "machine" ? from.kind : null;
}
