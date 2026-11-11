import { afterEach, describe, expect, test } from "bun:test";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { readTailnetOwners, resetSessionTailnetForTests, sessionTailnetAskAllowed, setSessionTailnetOwners, setSessionTailnetServedUrl } from "./session-tailnet";

// Guards which Host the owner's tab may ask the agent session with: port 443 (browser drops `:443`) must work, other names or ports must not.

const OWNER = "owner@example.com";
const NAME = "studio.tail0000.ts.net";
const ownerRequest = (host: string) =>
  new Request("http://127.0.0.1/api/ai/session", {
    headers: { host, "tailscale-user-login": OWNER, "x-forwarded-for": "100.64.0.9" },
  });
const neverLocal = () => false;

afterEach(() => resetSessionTailnetForTests());

describe("sessionTailnetAskAllowed", () => {
  test("a served port other than 443 must be named in Host", () => {
    setSessionTailnetOwners([OWNER]);
    setSessionTailnetServedUrl(`https://${NAME}:6060`);
    expect(sessionTailnetAskAllowed(ownerRequest(`${NAME}:6060`), neverLocal)).toBe(true);
    expect(sessionTailnetAskAllowed(ownerRequest(NAME), neverLocal)).toBe(false);
    expect(sessionTailnetAskAllowed(ownerRequest(`${NAME}:6061`), neverLocal)).toBe(false);
    expect(sessionTailnetAskAllowed(ownerRequest(`other.tail0000.ts.net:6060`), neverLocal)).toBe(false);
  });

  test("on 443 the browser omits the port: the bare served name is accepted, with or without :443", () => {
    setSessionTailnetOwners([OWNER]);
    setSessionTailnetServedUrl(`https://${NAME}/`);
    expect(sessionTailnetAskAllowed(ownerRequest(NAME), neverLocal)).toBe(true);
    expect(sessionTailnetAskAllowed(ownerRequest(`${NAME.toUpperCase()}.`), neverLocal)).toBe(true);
    expect(sessionTailnetAskAllowed(ownerRequest(`${NAME}:443`), neverLocal)).toBe(true);
    expect(sessionTailnetAskAllowed(ownerRequest("other.tail0000.ts.net"), neverLocal)).toBe(false);
  });

  test("no owner read: an owner-shaped request is a peer and never asks", () => {
    setSessionTailnetServedUrl(`https://${NAME}:6060`);
    expect(sessionTailnetAskAllowed(ownerRequest(`${NAME}:6060`), neverLocal)).toBe(false);
  });
});

// When Tailscale names no owner, the inboxTailscaleAllow logins count as the owner; where it does name one, the allowlist must not let anyone else in.

const TAGGED = JSON.stringify({ Self: { UserID: 1, Tags: ["tag:server"] }, User: {} });
const OWNED = JSON.stringify({ Self: { UserID: 1 }, User: { "1": { LoginName: "Owner@Example.com" } } });
const UNREAD = JSON.stringify({ Self: { UserID: 1 }, User: {} });
const status = (stdout: string): TailscaleRunner => () => ({ status: 0, stdout, stderr: "" });
const loginRequest = (login: string) =>
  new Request("http://127.0.0.1/api/ai/session", {
    headers: { host: `${NAME}:6060`, "tailscale-user-login": login, "x-forwarded-for": "100.64.0.9" },
  });

function askers(stdout: string, allowlist: string[], logins: string[]): Record<string, boolean> {
  setSessionTailnetOwners(readTailnetOwners(status(stdout), () => allowlist).logins);
  setSessionTailnetServedUrl(`https://${NAME}:6060`);
  return Object.fromEntries(logins.map((login) => [login, sessionTailnetAskAllowed(loginRequest(login), neverLocal)]));
}

describe("readTailnetOwners: the allowlist is the owner where Tailscale names none", () => {
  test("a tagged machine: an allowlisted login asks, any other login does not", () => {
    expect(askers(TAGGED, ["Me@Example.com", "me@work.example"], ["me@example.com", "me@work.example", "guest@example.com"])).toEqual({
      "me@example.com": true,
      "me@work.example": true,
      "guest@example.com": false,
    });
  });

  test("an untagged machine whose owner Tailscale does not report: the same rule", () => {
    expect(askers(UNREAD, ["me@example.com"], ["me@example.com", "guest@example.com"])).toEqual({ "me@example.com": true, "guest@example.com": false });
  });

  test("an untagged machine with an owner: only the owner asks, an allowlisted login is refused", () => {
    expect(askers(OWNED, ["friend@example.com"], ["owner@example.com", "friend@example.com", "guest@example.com"])).toEqual({
      "owner@example.com": true,
      "friend@example.com": false,
      "guest@example.com": false,
    });
  });

  test("no owner and no allowlist, or Tailscale not answering: nobody asks over the tailnet, with a reason", () => {
    const tagged = readTailnetOwners(status(TAGGED), () => []);
    expect(tagged.logins).toEqual([]);
    expect("reason" in tagged && tagged.reason).toContain("inboxTailscaleAllow");
    const down = readTailnetOwners(() => ({ status: 1, stdout: "", stderr: "not running" }), () => ["me@example.com"]);
    expect(down.logins).toEqual([]);
  });
});
