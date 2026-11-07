/**
 * Plannotator Inbox: how one Inbox reaches another machine's Inbox
 * (docs/agent-guides/inbox-machines.md). The seam is two calls: one request
 * to the other Inbox's device door, and its event stream. Everything a link
 * does goes through these two; nothing outside a transport's own file knows
 * how the bytes travel.
 *
 * One transport today: `tailnet`, HTTPS over the person's tailnet to the
 * door Tailscale publishes on 8443 (inbox-transport-tailnet.ts). A later one
 * (the relay, or a server reached only over SSH) is one more file and one
 * more `kind` here; the link, the outbox and the routes do not change.
 */

import { tailnetTransport, checkTailnetAddress } from "./inbox-transport-tailnet";

/** How a link reaches its machine, as `machines.json` keeps it. */
export type InboxTransportSpec = { kind: "tailnet"; url: string };

export interface InboxDoorRequest {
  method: "GET" | "POST";
  /** Sent as they are: the link adds `Authorization`, the caller what it forwards. */
  headers: Record<string, string>;
  body?: BodyInit | null;
  signal?: AbortSignal;
}

export interface InboxPeerTransport {
  readonly spec: InboxTransportSpec;
  /** One request to the door: `route` is the door route (`threads`, `messages/msg_…/reply`), `search` its query (`?a=b` or ""). */
  request(route: string, search: string, init: InboxDoorRequest): Promise<Response>;
  /** The door's event stream (`events`), held open until `signal` aborts. */
  events(headers: Record<string, string>, search: string, signal: AbortSignal): Promise<Response>;
  /** Where it reaches, for the person (`mini.tail1234.ts.net:8443`). */
  describe(): string;
}

export function openTransport(spec: InboxTransportSpec): InboxPeerTransport {
  switch (spec.kind) {
    case "tailnet":
      return tailnetTransport(spec);
  }
}

/** A spec read from disk or a request: checked before a link is made or opened. Null when it is not one. */
export function parseTransportSpec(value: unknown): InboxTransportSpec | null {
  if (!value || typeof value !== "object") return null;
  const spec = value as Record<string, unknown>;
  if (spec.kind === "tailnet" && typeof spec.url === "string") {
    const url = checkTailnetAddress(spec.url);
    return url ? { kind: "tailnet", url } : null;
  }
  return null;
}
