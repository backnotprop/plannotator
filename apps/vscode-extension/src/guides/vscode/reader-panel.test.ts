import { describe, expect, it } from "bun:test";
import * as vscode from "vscode";
import type { ReaderInit } from "../reader-protocol";
import { ReaderPanel, readerCsp } from "./reader-panel";
import { WebviewHost } from "./webview-host";

const panels = () => (vscode as unknown as { createdWebviewPanels: Array<{ posted: unknown[]; receive(m: unknown): void; webview: { html: string } }> }).createdWebviewPanels;

describe("the Guide tab's page", () => {
  it("runs only the extension's own scripts and connects nowhere else", () => {
    const csp = readerCsp("https://file+.vscode-resource.vscode-cdn.net", "abc");
    const directives = Object.fromEntries(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(directives["script-src"]).toEqual(["'nonce-abc'", "'strict-dynamic'"]);
    expect(csp).not.toContain("unsafe-eval");
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
    expect(directives["connect-src"]).toEqual(["https://file+.vscode-resource.vscode-cdn.net"]);
    expect(directives["worker-src"]).toEqual(["blob:"]);
    expect(directives["frame-src"]).toBeUndefined();
  });

  it("loads the reader from the extension's dist/reader, the script by nonce", () => {
    new ReaderPanel(vscode.Uri.file("/ext"), "Guide", { init: () => null, onMessage: () => {} });
    const html = panels().at(-1)!.webview.html;
    const nonce = /nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script type="module" nonce="${nonce}" src="https://file+.vscode-resource.vscode-cdn.net/ext/dist/reader/reader.js"></script>`);
    expect(html).toContain('href="https://file+.vscode-resource.vscode-cdn.net/ext/dist/reader/reader.css"');
  });
});

describe("messages between the Guide tab and the extension", () => {
  const init = { guideId: "g1" } as unknown as ReaderInit;

  it("sends the guide when the reader is ready, holds what comes before, and passes on only checked messages", () => {
    const got: unknown[] = [];
    let ready = 0;
    const p = new ReaderPanel(vscode.Uri.file("/ext"), "Guide", { init: () => init, onMessage: (m) => void got.push(m), onReady: () => ready++ });
    const page = panels().at(-1)!;
    p.send({ type: "reveal", chapter: 2 });
    // A hover answer for a page that is not there yet is dropped (the page will ask again).
    p.send({ type: "hover", reqId: 1, answer: null });
    expect(page.posted).toEqual([]);
    page.receive({ type: "ready" });
    expect(page.posted).toEqual([{ type: "init", init }, { type: "reveal", chapter: 2 }]);
    expect(ready).toBe(1);
    page.receive({ type: "openFile", path: "src/a.ts" });
    page.receive({ type: "openFile", path: "/etc/passwd" });
    page.receive({ type: "runCommand", command: "workbench.action.terminal.new" });
    page.receive("ready");
    expect(got).toEqual([{ type: "openFile", path: "src/a.ts" }]);
    p.send({ type: "reviewed", reviewed: [true], fileTicks: ["src/a.ts"] });
    expect(page.posted.at(-1)).toEqual({ type: "reviewed", reviewed: [true], fileTicks: ["src/a.ts"] });
  });

  it("checks a Mermaid source with the reader's engine and hands back its answer (never the reader's other messages)", async () => {
    const got: unknown[] = [];
    const p = new ReaderPanel(vscode.Uri.file("/ext"), "Guide", { init: () => init, onMessage: (m) => void got.push(m) });
    const page = panels().at(-1)!;
    expect(await p.checkMermaid("graph TD; A-->B")).toBeNull(); // not loaded: not checked
    page.receive({ type: "ready" });
    const pending = p.checkMermaid("graph TD; A-->B");
    const ask = page.posted.at(-1) as { type: string; reqId: number; source: string };
    expect(ask).toMatchObject({ type: "checkMermaid", source: "graph TD; A-->B" });
    page.receive({ type: "mermaidResult", reqId: ask.reqId, ok: false, message: "Parse error", line: 1 });
    expect(await pending).toEqual({ ok: false, message: "Parse error", line: 1 });
    expect(got).toEqual([]);
  });

  it("a reader whose diagram engine did not load could not check (null), which never refuses the diagram", async () => {
    const p = new ReaderPanel(vscode.Uri.file("/ext"), "Guide", { init: () => init, onMessage: () => {} });
    const page = panels().at(-1)!;
    page.receive({ type: "ready" });
    const pending = p.checkMermaid("graph TD; A-->B");
    const ask = page.posted.at(-1) as { reqId: number };
    expect(p.diagramEngineUnavailable).toBe(false);
    page.receive({ type: "mermaidResult", reqId: ask.reqId, ok: false, unavailable: true, message: "Failed to fetch dynamically imported module" });
    expect(await pending).toBeNull();
    // Said once, so the extension stops asking a tab that has no engine.
    expect(p.diagramEngineUnavailable).toBe(true);
  });
});

describe("the other Guides webviews' render check", () => {
  it("passes on Mermaid's own errors, and reports an engine that did not load as not checked", async () => {
    const listeners: Array<(m: unknown) => void> = [];
    const posted: Array<{ reqId: number }> = [];
    const webview = {
      html: "",
      cspSource: "x",
      onDidReceiveMessage: (l: (m: unknown) => void) => (listeners.push(l), { dispose() {} }),
      postMessage: async (m: { reqId: number }) => (posted.push(m), true),
    } as unknown as vscode.Webview;
    const host = new WebviewHost(webview, { onCommand: () => {} });
    const send = (m: unknown) => listeners.forEach((l) => l(m));
    send({ type: "ready" });
    const refused = host.checkMermaid("graph TD; A-->");
    send({ type: "mermaidResult", reqId: posted.at(-1)!.reqId, ok: false, message: "Parse error on line 1", line: 1 });
    expect(await refused).toEqual({ ok: false, message: "Parse error on line 1", line: 1 });
    const notChecked = host.checkMermaid("graph TD; A-->B");
    send({ type: "mermaidResult", reqId: posted.at(-1)!.reqId, ok: false, unavailable: true, message: "The diagram engine is not available here." });
    expect(await notChecked).toBeNull();
  });
});
