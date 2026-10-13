import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import * as vscode from "vscode";
import { PanelManager } from "./panel-manager";

describe("PanelManager", () => {
  let manager: PanelManager;
  const spies: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    manager = new PanelManager();
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
  });

  // Stubs createWebviewPanel and returns a handle whose `.html` reflects the
  // HTML the manager assigns to the panel's webview.
  function stubWebviewPanel(): { html: string } {
    const captured = { html: "" };
    const spy = spyOn(vscode.window, "createWebviewPanel");
    spy.mockImplementation((() => {
      let disposeListener: (() => void) | null = null;
      return {
        webview: {
          get html() { return captured.html; },
          set html(v: string) { captured.html = v; },
          onDidReceiveMessage() { return { dispose() {} }; },
          postMessage() { return Promise.resolve(true); },
        },
        reveal() {},
        dispose() { disposeListener?.(); },
        onDidDispose(listener: () => void) {
          disposeListener = listener;
          return { dispose() {} };
        },
      } as unknown as vscode.WebviewPanel;
    }) as typeof vscode.window.createWebviewPanel);
    spies.push(spy);
    return captured;
  }

  it("sets iframe src in webview html", async () => {
    const captured = stubWebviewPanel();

    await manager.open("http://127.0.0.1:9999/review?id=42");

    expect(captured.html).toContain(
      'src="http://127.0.0.1:9999/review?id=42"',
    );
  });

  it("re-dispatches keystrokes forwarded from the app iframe", async () => {
    const captured = stubWebviewPanel();

    await manager.open("http://127.0.0.1:9999/review?id=42");

    expect(captured.html).toContain('d.type === "plannotator-keydown"');
    expect(captured.html).toContain('new KeyboardEvent("keydown", d.event)');
  });

  it("relays clipboard messages between the app iframe and the extension host", async () => {
    const captured = stubWebviewPanel();

    await manager.open("http://127.0.0.1:9999/review?id=42");

    expect(captured.html).toContain("acquireVsCodeApi()");
    expect(captured.html).toContain('"plannotator-clipboard-write"');
    expect(captured.html).toContain('"plannotator-clipboard-data"');
  });

  // #1583: the webview sandbox has no allow-popups, so "View on Bitbucket
  // after submitting" (and every target=_blank link) only works through
  // vscode.env.openExternal.
  it("opens http(s) links the app frame forwards in the external browser", async () => {
    let onMessage: ((msg: unknown) => Promise<void> | void) | null = null;
    const spy = spyOn(vscode.window, "createWebviewPanel");
    spy.mockImplementation((() => ({
      webview: {
        html: "",
        onDidReceiveMessage(listener: (msg: unknown) => void) {
          onMessage = listener;
          return { dispose() {} };
        },
        postMessage() { return Promise.resolve(true); },
      },
      onDidDispose() { return { dispose() {} }; },
      dispose() {},
    })) as unknown as typeof vscode.window.createWebviewPanel);
    spies.push(spy);
    const opened: string[] = [];
    const openSpy = spyOn(vscode.env, "openExternal");
    openSpy.mockImplementation(async (uri: vscode.Uri) => {
      opened.push(uri.toString());
      return true;
    });
    spies.push(openSpy);

    await manager.open("http://127.0.0.1:9999/review?id=42");
    await onMessage!({ type: "plannotator-open-external", url: "https://bitbucket.org/ws/repo/pull-requests/1" });
    await onMessage!({ type: "plannotator-open-external", url: "javascript:alert(1)" });
    await onMessage!({ type: "plannotator-open-external", url: "file:///etc/passwd" });

    expect(opened).toEqual(["https://bitbucket.org/ws/repo/pull-requests/1"]);
  });

  it("accepts open-external requests only from the app frame itself", async () => {
    const captured = stubWebviewPanel();
    await manager.open("http://127.0.0.1:9999/review?id=42");
    expect(captured.html).toContain('e.source === app.contentWindow');
  });

  it("uses asExternalUri resolved URL in iframe and CSP", async () => {
    const envSpy = spyOn(vscode.env, "asExternalUri");
    envSpy.mockImplementation(async (_uri: vscode.Uri) => {
      return vscode.Uri.parse("https://localhost:8443/review?id=42");
    });
    spies.push(envSpy);

    const captured = stubWebviewPanel();

    await manager.open("http://127.0.0.1:9999/review?id=42");

    expect(envSpy).toHaveBeenCalled();
    expect(captured.html).toContain(
      'src="https://localhost:8443/review?id=42"',
    );
    expect(captured.html).toContain("frame-src https://localhost:8443;");
  });
});
