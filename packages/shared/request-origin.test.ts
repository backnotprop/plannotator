import { describe, expect, test } from "bun:test";
import { isSameOriginOrNoOrigin, isStateChangingMethod } from "./request-origin";

// The guard on every state-changing request. Failures it catches: a page on
// another site writing the user's settings or approving a review, or the VS
// Code panel (served through a proxy that rewrites Host) being refused its own
// writes, which the client ignores, so settings silently stop saving.
describe("isSameOriginOrNoOrigin", () => {
  const host = "localhost:4100";
  const cases: Array<[string, string | null, string | string[] | null, boolean]> = [
    ["no Origin (a non-browser client)", null, null, true],
    ["Origin names the request host", "http://localhost:4100", null, true],
    ["the VS Code proxy: Origin is the proxy, the browser says same-origin", "http://127.0.0.1:53111", "same-origin", true],
    ["another site", "https://evil.example", null, false],
    ["another site, browser says cross-site", "https://evil.example", "cross-site", false],
    ["another local port, browser says same-site", "http://127.0.0.1:9999", "same-site", false],
    ["Origin null (sandboxed frame), even if marked same-origin", "null", "same-origin", false],
    ["a malformed Origin", "not a url", null, false],
    ["no Origin, but the browser says cross-site", null, "cross-site", false],
    ["no Origin, but the browser says same-site", null, "same-site", false],
    ["Origin names the host, but the browser says cross-site", "http://localhost:4100", "cross-site", false],
    ["no Origin, browser says same-origin", null, "same-origin", true],
    ["no Origin, browser says none (a request the person started)", null, "none", true],
    ["Sec-Fetch-Site given twice: the first value decides", null, ["Cross-Site", "same-origin"], false],
  ];
  for (const [label, origin, site, allowed] of cases) {
    test(label, () => {
      expect(isSameOriginOrNoOrigin(origin, host, site)).toBe(allowed);
    });
  }
});

describe("isStateChangingMethod", () => {
  test("POST, PUT, PATCH and DELETE change state; GET, HEAD and OPTIONS do not", () => {
    expect(["POST", "put", "PATCH", "delete"].map(isStateChangingMethod)).toEqual([true, true, true, true]);
    expect(["GET", "HEAD", "OPTIONS", "", null].map(isStateChangingMethod)).toEqual([false, false, false, false, false]);
  });
});
