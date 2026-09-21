/**
 * Live app annotation is untouched by the HtmlViewer `bridgeScriptUrl` seam:
 * the proxy keeps composing the INLINE bridge body it serves from its own
 * route and injecting that route's tag into proxied HTML. A later change
 * that routed the live path through the package asset (or its URL prop)
 * would move a per-session token-bearing body onto a host-served file, so
 * this pins the current shape at source level, on both transports and both
 * runtimes' composers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Relative on purpose: @plannotator/ui is not a dependency of shared; only the
// CLI and Pi import the bridge module, and this test reads the same file.
import { BRIDGE_SCRIPT, LIVE_BRIDGE_BOOTSTRAP } from "../ui/components/html-viewer/bridge-script";
import {
  LIVE_PROXY_BRIDGE_PATH,
  LIVE_PROXY_BRIDGE_TAG,
  composeLiveBridgeJs,
} from "./live-proxy-core";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("live proxy bridge delivery", () => {
  test("the proxy-served body carries the inline bridge verbatim", () => {
    const body = composeLiveBridgeJs({
      token: "tok",
      editorOrigins: ["http://localhost:1"],
      annotationCss: ".x{}",
      bridgeBootstrap: LIVE_BRIDGE_BOOTSTRAP,
      bridgeScript: BRIDGE_SCRIPT,
    });
    expect(body.endsWith(BRIDGE_SCRIPT)).toBe(true);
    expect(body).toContain(LIVE_BRIDGE_BOOTSTRAP);
    // The injected tag names the proxy's own route, never a host asset.
    expect(LIVE_PROXY_BRIDGE_TAG).toBe(`<script src="${LIVE_PROXY_BRIDGE_PATH}"></script>`);
    expect(LIVE_PROXY_BRIDGE_PATH).toBe("/__plannotator__/bridge.js");
  });

  test.each([
    "packages/shared/live-proxy-core.ts",
    "packages/shared/live-proxy-node.ts",
    "packages/server/live-proxy.ts",
    "packages/server/annotate.ts",
    "apps/hook/server/index.ts",
    "apps/pi-extension/plannotator-browser.ts",
    "apps/pi-extension/server/serverAnnotate.ts",
  ])("%s never references the srcdoc URL seam or the generated asset", (path) => {
    const source = read(path);
    expect(source).not.toContain("bridgeScriptUrl");
    expect(source).not.toContain("bridge-script.asset");
    expect(source).not.toContain("bridge-script.lite");
  });

  test("both runtimes still hand the inline string exports to the composer", () => {
    expect(read("apps/hook/server/index.ts")).toContain("bridgeScript: BRIDGE_SCRIPT,");
    expect(read("apps/pi-extension/plannotator-browser.ts")).toContain("bridgeScript: bridge.BRIDGE_SCRIPT,");
    expect(read("packages/shared/live-proxy-core.ts")).toContain("+ sources.bridgeScript");
  });
});
