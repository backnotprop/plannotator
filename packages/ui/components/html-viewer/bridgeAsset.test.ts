import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  ANNOTATION_HIGHLIGHT_CSS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCRIPT,
  LIVE_BRIDGE_BOOTSTRAP,
} from "./bridge-script";
import {
  BRIDGE_ASSET_DIR,
  BRIDGE_ASSET_FILENAME,
  BRIDGE_LITE_FILENAME,
  writeBridgeAssets,
} from "../../scripts/build-bridge-assets";
import {
  buildBridgeScriptTag,
  buildSrcdocInjection,
  injectIntoHead,
  resolveBridgeScriptUrl,
} from "./srcdoc";
import { checkBridgeProtocolVersion, formatBridgeProtocolWarning } from "./useHtmlAnnotation";

const uiRoot = resolve(import.meta.dir, "../..");

describe("generated bridge assets", () => {
  test("the asset is byte-for-byte BRIDGE_SCRIPT and the lite module keeps every other export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-bridge-asset-"));
    try {
      const written = writeBridgeAssets(dir);
      expect(written.map((p) => p.slice(dir.length + 1)).sort()).toEqual(
        [BRIDGE_ASSET_FILENAME, BRIDGE_LITE_FILENAME].sort(),
      );
      const asset = readFileSync(join(dir, BRIDGE_ASSET_FILENAME));
      expect(asset.equals(Buffer.from(BRIDGE_SCRIPT, "utf8"))).toBe(true);

      writeBridgeAssets(dir);
      expect(readFileSync(join(dir, BRIDGE_ASSET_FILENAME)).equals(asset)).toBe(true);

      const lite = await import(join(dir, BRIDGE_LITE_FILENAME));
      expect(lite.ANNOTATION_HIGHLIGHT_CSS).toBe(ANNOTATION_HIGHLIGHT_CSS);
      expect(lite.LIVE_BRIDGE_BOOTSTRAP).toBe(LIVE_BRIDGE_BOOTSTRAP);
      expect(lite.BRIDGE_PROTOCOL_VERSION).toBe(BRIDGE_PROTOCOL_VERSION);
      expect(lite.BRIDGE_SCRIPT).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A stale local artifact (generated before a bridge edit) would ship a bridge that disagrees
  // with the parent.
  test.skipIf(!existsSync(join(BRIDGE_ASSET_DIR, BRIDGE_ASSET_FILENAME)))(
    "an already-generated asset in the package matches the current source",
    () => {
      const asset = readFileSync(join(BRIDGE_ASSET_DIR, BRIDGE_ASSET_FILENAME), "utf8");
      expect(asset === BRIDGE_SCRIPT).toBe(true);
    },
  );

  test("the package manifest ships and exports both generated files", () => {
    const pkg = JSON.parse(readFileSync(join(uiRoot, "package.json"), "utf8")) as {
      exports: Record<string, string>;
      files: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.exports[`./components/html-viewer/${BRIDGE_ASSET_FILENAME}`]).toBe(
      `./components/html-viewer/${BRIDGE_ASSET_FILENAME}`,
    );
    expect(pkg.exports["./components/html-viewer/bridge-script.lite"]).toBe(
      `./components/html-viewer/${BRIDGE_LITE_FILENAME}`,
    );
    expect(pkg.files).toContain("components");
    expect(pkg.files.some((entry) => entry.startsWith("!") && /bridge-script/.test(entry))).toBe(false);
    expect(pkg.scripts.prepack).toContain("build:bridge-assets");
    expect(BRIDGE_ASSET_DIR).toBe(dirname(resolve(import.meta.dir, "bridge-script.ts")));
  });
});

describe("srcdoc bridge script tag", () => {
  const base = { tokens: {}, isLight: true, hostTheme: false, diffActive: false };

  test("default (no URL): the inline literal, exactly one script element, no src", () => {
    const injection = buildSrcdocInjection(base);
    expect(injection.endsWith(`<script>${BRIDGE_SCRIPT}</script>`)).toBe(true);
    expect(injection.split("<script").length - 1).toBe(1);
    expect(buildBridgeScriptTag()).toBe(`<script>${BRIDGE_SCRIPT}</script>`);
    // An empty string is "absent": a host misconfiguration must not produce
    // <script src=""> (which would load the host page itself as a script).
    expect(buildBridgeScriptTag("")).toBe(`<script>${BRIDGE_SCRIPT}</script>`);
  });

  test("URL path: a classic <script src> takes the inline script's place, without crossorigin", () => {
    const url = "https://host.example/assets/bridge-script.abc123.js";
    const injection = buildSrcdocInjection({ ...base, bridgeScriptUrl: url });
    const inline = buildSrcdocInjection(base);
    const stylePrefix = inline.slice(0, inline.indexOf("<script"));
    expect(injection.startsWith(stylePrefix)).toBe(true);
    expect(injection.slice(stylePrefix.length)).toBe(`<script src="${url}"></script>`);
    expect(injection).not.toContain(BRIDGE_SCRIPT);
    expect(injection).not.toContain("crossorigin");
  });

  test("the URL is attribute-escaped so it cannot break out of the tag", () => {
    const tag = buildBridgeScriptTag('/b.js" onerror="alert(1)');
    expect(tag).toBe('<script src="/b.js&quot; onerror=&quot;alert(1)"></script>');
  });

  test("the URL resolves against the parent base, never the framed page's <base href>", () => {
    const parent = "https://host.example/workspace/doc/42";
    expect(resolveBridgeScriptUrl("/assets/bridge.abc.js", parent)).toBe("https://host.example/assets/bridge.abc.js");
    expect(resolveBridgeScriptUrl("./bridge.js", parent)).toBe("https://host.example/workspace/doc/bridge.js");
    expect(resolveBridgeScriptUrl("https://cdn.example/b.js", parent)).toBe("https://cdn.example/b.js");
    expect(resolveBridgeScriptUrl("http://[bad", "not a url")).toBe("http://[bad");

    const page = '<html><head><base href="https://attacker.example/"><title>t</title></head><body></body></html>';
    const doc = injectIntoHead(page, buildSrcdocInjection({
      ...base,
      bridgeScriptUrl: resolveBridgeScriptUrl("/assets/bridge.abc.js", parent),
    }));
    expect(doc).toContain('<script src="https://host.example/assets/bridge.abc.js"></script>');
    expect(doc.indexOf("<base href")).toBeLessThan(doc.indexOf("<script src="));
  });

  test("the package adds no CSP meta to the srcdoc document on either path", () => {
    const page = "<html><head><title>t</title></head><body><p>x</p></body></html>";
    for (const bridgeScriptUrl of [undefined, "/assets/bridge.js"]) {
      const doc = injectIntoHead(page, buildSrcdocInjection({ ...base, bridgeScriptUrl }));
      expect(doc).not.toMatch(/<meta[^>]*http-equiv/i);
    }
    expect(BRIDGE_SCRIPT).not.toMatch(/http-equiv/i);
    expect(BRIDGE_SCRIPT).not.toMatch(/content-security-policy/i);
  });
});

describe("bridge protocol version", () => {
  async function runBridgeIsolated(): Promise<unknown[]> {
    const registrator = Bun.resolveSync("@happy-dom/global-registrator", uiRoot);
    const happyDom = Bun.resolveSync("happy-dom", dirname(registrator));
    const { Window } = (await import(happyDom)) as { Window: new (o: { url: string }) => Record<string, unknown> };
    const win = new Window({ url: "about:srcdoc" });
    (win.document as { write: (s: string) => void }).write("<html><body><p>hi</p></body></html>");
    const posted: unknown[] = [];
    const parent = { postMessage: (message: unknown) => posted.push(message) };
    const names = [
      "window", "document", "parent", "top", "self", "globalThis", "location",
      "ResizeObserver", "MutationObserver", "getComputedStyle", "requestAnimationFrame",
      "cancelAnimationFrame", "setTimeout", "clearTimeout", "Node", "Element",
      "HTMLElement", "performance", "getSelection", "navigator",
    ];
    const values = names.map((name) =>
      name === "parent" ? parent
        : name === "top" || name === "self" || name === "globalThis" ? win
        : win[name],
    );
    try {
      new Function(...names, BRIDGE_SCRIPT)(...values);
    } finally {
      const happy = win.happyDOM as { close?: () => Promise<void> } | undefined;
      await happy?.close?.();
    }
    return posted;
  }

  test("the executed bridge posts a ready stamped with BRIDGE_PROTOCOL_VERSION", async () => {
    const posted = await runBridgeIsolated();
    const ready = posted.find(
      (m) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === "plannotator-bridge-ready",
    ) as { protocolVersion?: unknown } | undefined;
    expect(ready).toBeDefined();
    expect(ready!.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(checkBridgeProtocolVersion(ready).ok).toBe(true);
  });

  test("a stale asset's ready (no stamp, or another version) is a detected mismatch naming both versions", () => {
    const stale = checkBridgeProtocolVersion({ type: "plannotator-bridge-ready" });
    expect(stale).toEqual({ ok: false, expected: BRIDGE_PROTOCOL_VERSION, reported: undefined });
    const other = checkBridgeProtocolVersion({
      type: "plannotator-bridge-ready",
      protocolVersion: BRIDGE_PROTOCOL_VERSION + 1,
    });
    expect(other.ok).toBe(false);
    expect(other.reported).toBe(BRIDGE_PROTOCOL_VERSION + 1);
    expect(checkBridgeProtocolVersion({ type: "plannotator-bridge-ready", protocolVersion: "1" }).ok).toBe(false);

    const warning = formatBridgeProtocolWarning(other, "https://h/bridge.js");
    expect(warning).toContain(`expects ${BRIDGE_PROTOCOL_VERSION}`);
    expect(warning).toContain(`reported ${BRIDGE_PROTOCOL_VERSION + 1}`);
    expect(warning).toContain("https://h/bridge.js");
    expect(formatBridgeProtocolWarning(stale)).toContain("reported none");
  });
});
