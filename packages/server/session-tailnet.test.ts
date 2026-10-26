import { afterEach, describe, expect, test } from "bun:test";
import { resetSessionTailnetForTests, sessionTailnetAskAllowed, setSessionTailnetOwner, setSessionTailnetServedUrl } from "./session-tailnet";

// #2166: which Host the owner's tab may ask the agent session with. The
// failures guarded: an owner on port 443 (the browser drops `:443`) is
// refused, or another name or port is let in.

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
    setSessionTailnetOwner(OWNER);
    setSessionTailnetServedUrl(`https://${NAME}:6060`);
    expect(sessionTailnetAskAllowed(ownerRequest(`${NAME}:6060`), neverLocal)).toBe(true);
    expect(sessionTailnetAskAllowed(ownerRequest(NAME), neverLocal)).toBe(false);
    expect(sessionTailnetAskAllowed(ownerRequest(`${NAME}:6061`), neverLocal)).toBe(false);
    expect(sessionTailnetAskAllowed(ownerRequest(`other.tail0000.ts.net:6060`), neverLocal)).toBe(false);
  });

  test("on 443 the browser omits the port: the bare served name is accepted, with or without :443", () => {
    setSessionTailnetOwner(OWNER);
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
