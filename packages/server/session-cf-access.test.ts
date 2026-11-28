import { afterEach, describe, expect, test } from "bun:test";
import { resetSessionTailnetForTests, sessionTailnetAudience, sessionTailnetAskAllowed, setSessionDoor, setSessionTailnetServedUrl } from "./session-tailnet";

const HOST = "inbox.example.test";
const SECRET = "door-secret-0123456789abcdef012345";

afterEach(() => resetSessionTailnetForTests());

const req = (headers: Record<string, string>) => new Request("http://127.0.0.1:4000/api/diff", { headers });

describe("a --cloudflare-access session", () => {
  test("only the door's secret with the public Host is the owner over the network", () => {
    setSessionDoor(SECRET, HOST);
    setSessionTailnetServedUrl(`https://${HOST}/`);
    const fromDoor = req({ host: HOST, "plannotator-door": SECRET });
    expect(sessionTailnetAudience(fromDoor)).toBe("owner");
    expect(sessionTailnetAskAllowed(fromDoor, () => false)).toBe(true);
    expect(sessionTailnetAudience(req({ host: HOST, "plannotator-door": `${SECRET}x` }))).toBe("peer");
    expect(sessionTailnetAudience(req({ host: "127.0.0.1:4000", "plannotator-door": SECRET }))).toBe("peer");
    expect(sessionTailnetAudience(req({ host: HOST, "cf-access-jwt-assertion": "x" }))).toBe("peer");
    expect(sessionTailnetAudience(req({ host: HOST, "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.1" }))).toBe("peer");
  });

  test("reached on its loopback port without the header, it is a local session as before", () => {
    setSessionDoor(SECRET, HOST);
    const local = req({ host: "127.0.0.1:4000" });
    expect(sessionTailnetAudience(local)).toBe("local");
    expect(sessionTailnetAskAllowed(local, () => true)).toBe(true);
  });

  test("a session without the door ignores the header", () => {
    expect(sessionTailnetAudience(req({ host: "127.0.0.1:4000", "plannotator-door": SECRET }))).toBe("local");
  });
});
