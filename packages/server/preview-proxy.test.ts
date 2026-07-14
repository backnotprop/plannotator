// packages/server/preview-proxy.test.ts
import { describe, expect, it } from "bun:test";
import { injectBridge, rewriteRequestHeaders, parseTarget } from "./preview-proxy";

describe("preview-proxy helpers", () => {
  it("parseTarget rejects non-loopback", () => {
    expect(() => parseTarget("http://example.com")).toThrow();
    expect(parseTarget("http://localhost:5176/pages/x").host).toBe("localhost:5176");
  });

  it("rewriteRequestHeaders forces Host to the target", () => {
    const h = new Headers({ host: "localhost:9999", origin: "http://localhost:9999" });
    const out = rewriteRequestHeaders(h, "localhost:5176", "http://localhost:5176", "/p");
    expect(out.get("host")).toBe("localhost:5176");
    expect(out.get("origin")).toBe("http://localhost:5176");
  });

  it("injectBridge inserts after <head>", () => {
    const out = injectBridge("<html><head>\n<title>x</title></head><body></body></html>", "<b/>");
    expect(out).toContain("<head><b/>");
  });

  it("injectBridge prepends when no <head>", () => {
    expect(injectBridge("<body>hi</body>", "<b/>")).toBe("<b/><body>hi</body>");
  });
});
