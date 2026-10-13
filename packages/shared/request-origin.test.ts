import { describe, expect, test } from "bun:test";
import { isSameOriginOrNoOrigin } from "./request-origin";

// The guard on every config / progress / share / install write. Failures it
// catches: a page on another site writing the user's settings, or the VS Code
// panel (served through a proxy that rewrites Host) being refused its own
// writes, which the client ignores, so settings silently stop saving.
describe("isSameOriginOrNoOrigin", () => {
  const host = "localhost:4100";
  const cases: Array<[string, string | null, string | null, boolean]> = [
    ["no Origin (a non-browser client)", null, null, true],
    ["Origin names the request host", "http://localhost:4100", null, true],
    ["the VS Code proxy: Origin is the proxy, the browser says same-origin", "http://127.0.0.1:53111", "same-origin", true],
    ["another site", "https://evil.example", null, false],
    ["another site, browser says cross-site", "https://evil.example", "cross-site", false],
    ["another local port, browser says same-site", "http://127.0.0.1:9999", "same-site", false],
    ["Origin null (sandboxed frame), even if marked same-origin", "null", "same-origin", false],
    ["a malformed Origin", "not a url", null, false],
  ];
  for (const [label, origin, site, allowed] of cases) {
    test(label, () => {
      expect(isSameOriginOrNoOrigin(origin, host, site)).toBe(allowed);
    });
  }
});
