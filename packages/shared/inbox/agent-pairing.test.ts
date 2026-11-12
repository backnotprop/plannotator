import { describe, expect, test } from "bun:test";
import { decodeInboxAgentPairing, encodeInboxAgentPairing } from "./agent-pairing";

const device_id = "dev_01K7PAIRINGTEST00000000000";
const token = `tok_${"A".repeat(43)}`;
const secret = "B".repeat(43);
const mailbox_id = `mbx_${"C".repeat(22)}`;

const raw = (prefix: string, fields: Record<string, unknown>) => `${prefix}${Buffer.from(JSON.stringify(fields), "utf8").toString("base64url")}`;
const v2 = (fields: Record<string, unknown>) => raw("plannotator-pairing-2.", { d: device_id, t: token, s: secret, r: "https://relay.plannotator.ai", m: mailbox_id, ...fields });

describe("a pairing string sends a cloud agent only where the Inbox said, over TLS", () => {
  test("version 2 names the relay; version 1 names none", () => {
    expect(decodeInboxAgentPairing(v2({}))).toEqual({ device_id, token, secret, relay: { url: "https://relay.plannotator.ai", mailbox_id } });
    expect(decodeInboxAgentPairing(raw("plannotator-pairing-1.", { d: device_id, t: token, s: secret, r: "https://elsewhere.example", m: mailbox_id }))).toEqual({ device_id, token, secret });
  });

  test("an unknown version, a cut string, or a relay that is not plain https at an origin is refused", () => {
    const refused = [
      raw("plannotator-pairing-3.", { d: device_id, t: token, s: secret, r: "https://relay.plannotator.ai", m: mailbox_id }),
      v2({}).slice(0, -6),
      v2({ r: "http://relay.plannotator.ai" }),
      v2({ r: "https://relay.plannotator.ai/other" }),
      v2({ r: "https://user:pass@relay.plannotator.ai" }),
      v2({ r: "https://relay.plannotator.ai/?x=1" }),
      v2({ r: "ftp://relay.plannotator.ai" }),
      v2({ m: "mbx_short" }),
      v2({ r: undefined }),
    ];
    for (const value of refused) expect(decodeInboxAgentPairing(value)).toBeNull();
  });

  test("an Inbox whose relay is plain http off this computer makes a version 1 string, never one that sends the agent there", () => {
    const made = encodeInboxAgentPairing({ device_id, token, secret, relay: { url: "http://relay.example", mailbox_id } });
    expect(made.startsWith("plannotator-pairing-1.")).toBe(true);
    expect(decodeInboxAgentPairing(made)?.relay).toBeUndefined();
  });
});
