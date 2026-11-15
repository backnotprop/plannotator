export const INBOX_AGENT_CALL_ACTIONS = ["whoami", "read_thread", "send_message", "search", "resolve_message"] as const;

export const INBOX_AGENT_PAIRING_PREFIX = "plannotator-pairing-1.";
export const INBOX_AGENT_PAIRING_RELAY_PREFIX = "plannotator-pairing-2.";

export interface InboxAgentPairingRelay {
  url: string;
  mailbox_id: string;
}

export interface InboxAgentPairing {
  device_id: string;
  token: string;
  secret: string;
  relay?: InboxAgentPairingRelay;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function inboxAgentRelayUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const allowed = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
    if (!allowed || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function encodeInboxAgentPairing(pairing: InboxAgentPairing): string {
  const relayUrl = pairing.relay ? inboxAgentRelayUrl(pairing.relay.url) : null;
  if (pairing.relay && relayUrl) {
    const json = JSON.stringify({ d: pairing.device_id, t: pairing.token, s: pairing.secret, r: relayUrl, m: pairing.relay.mailbox_id });
    return `${INBOX_AGENT_PAIRING_RELAY_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
  }
  const json = JSON.stringify({ d: pairing.device_id, t: pairing.token, s: pairing.secret });
  return `${INBOX_AGENT_PAIRING_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function decodeInboxAgentPairing(value: string | undefined | null): InboxAgentPairing | null {
  const text = value?.trim();
  const withRelay = text?.startsWith(INBOX_AGENT_PAIRING_RELAY_PREFIX) === true;
  if (!text || (!withRelay && !text.startsWith(INBOX_AGENT_PAIRING_PREFIX))) return null;
  const prefix = withRelay ? INBOX_AGENT_PAIRING_RELAY_PREFIX : INBOX_AGENT_PAIRING_PREFIX;
  try {
    const parsed = JSON.parse(Buffer.from(text.slice(prefix.length), "base64url").toString("utf8")) as Record<string, unknown>;
    const { d, t, s } = parsed;
    if (typeof d !== "string" || !/^dev_[0-9A-Z]{26}$/i.test(d)) return null;
    if (typeof t !== "string" || !/^tok_[A-Za-z0-9_-]{43}$/.test(t)) return null;
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
    if (!withRelay) return { device_id: d, token: t, secret: s };
    const url = inboxAgentRelayUrl(parsed.r);
    const mailbox = parsed.m;
    if (!url || typeof mailbox !== "string" || !/^mbx_[A-Za-z0-9_-]{22}$/.test(mailbox)) return null;
    return { device_id: d, token: t, secret: s, relay: { url, mailbox_id: mailbox } };
  } catch {
    return null;
  }
}
