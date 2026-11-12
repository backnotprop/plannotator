/**
 * A paired cloud agent's pairing string: the one value its routine keeps as
 * `PLANNOTATOR_PAIRING` (adr/implementation/inbox-mobile.md, section 13).
 *
 *   plannotator-pairing-1.<base64url of {"d": dev id, "t": tok_ token, "s": pairing secret}>
 */

export const INBOX_AGENT_PAIRING_PREFIX = "plannotator-pairing-1.";

export interface InboxAgentPairing {
  device_id: string;
  token: string;
  secret: string;
}

export function encodeInboxAgentPairing(pairing: InboxAgentPairing): string {
  const json = JSON.stringify({ d: pairing.device_id, t: pairing.token, s: pairing.secret });
  return `${INBOX_AGENT_PAIRING_PREFIX}${Buffer.from(json, "utf8").toString("base64url")}`;
}

export function decodeInboxAgentPairing(value: string | undefined | null): InboxAgentPairing | null {
  const text = value?.trim();
  if (!text?.startsWith(INBOX_AGENT_PAIRING_PREFIX)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(text.slice(INBOX_AGENT_PAIRING_PREFIX.length), "base64url").toString("utf8")) as Record<string, unknown>;
    const { d, t, s } = parsed;
    if (typeof d !== "string" || !/^dev_[0-9A-Z]{26}$/i.test(d)) return null;
    if (typeof t !== "string" || !/^tok_[A-Za-z0-9_-]{43}$/.test(t)) return null;
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
    return { device_id: d, token: t, secret: s };
  } catch {
    return null;
  }
}
