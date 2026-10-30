/**
 * One Guides webview (a tab): the HTML shell with a strict CSP (scripts only
 * from the extension: its bundle by nonce, the diagram engine from its resources), the state it shows,
 * and the messages it sends. Agent text reaches it only as data, rendered
 * through DOMPurify in the webview.
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { webviewCsp, type GuidesWebviewMode } from "../webview-csp";
import { WEBVIEW_COMMANDS, type LinkInfo, type ToExtension, type ToWebview, type ViewState } from "../webview-protocol";

export type WebviewMode = GuidesWebviewMode;

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")] };
}

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, mode: WebviewMode): string {
  const nonce = randomBytes(16).toString("base64");
  const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", ...p)).toString();
  const csp = webviewCsp(webview.cspSource, nonce, mode);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset("codicons", "codicon.css")}">
<link rel="stylesheet" href="${asset("guides-webview.css")}">
</head>
<body class="pn-mode-${mode}" data-pn-diagram="${asset("reader", "diagram.js")}">
<div id="root"></div>
<script nonce="${nonce}" src="${asset("guides-webview.js")}"></script>
</body>
</html>`;
}

export interface WebviewHandlers {
  onCommand(command: string, args: unknown[]): void;
  onLink?(link: string, action: "open" | "definition" | "references"): void;
  onLinkInfo?(link: string): Promise<LinkInfo>;
}

/** State, messages and the Mermaid render check for one webview. */
export class WebviewHost {
  private state: ViewState | null = null;
  private ready = false;
  private nextReq = 1;
  private readonly mermaidChecks = new Map<number, (r: { ok: boolean; message?: string; line?: number } | null) => void>();
  private readonly subscription: vscode.Disposable;

  constructor(readonly webview: vscode.Webview, private readonly handlers: WebviewHandlers) {
    this.subscription = webview.onDidReceiveMessage((raw: unknown) => this.receive(raw as ToExtension));
  }

  show(state: ViewState): void {
    this.state = state;
    if (this.ready) void this.webview.postMessage({ type: "state", state } satisfies ToWebview);
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Render a Mermaid source with the webview's engine (the builder's check). */
  checkMermaid(source: string, timeoutMs = 15_000): Promise<{ ok: boolean; message?: string; line?: number } | null> {
    if (!this.ready) return Promise.resolve(null);
    const reqId = this.nextReq++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.mermaidChecks.delete(reqId);
        resolve(null);
      }, timeoutMs);
      this.mermaidChecks.set(reqId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      void this.webview.postMessage({ type: "checkMermaid", reqId, source } satisfies ToWebview);
    });
  }

  private receive(msg: ToExtension): void {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "ready":
        this.ready = true;
        if (this.state) void this.webview.postMessage({ type: "state", state: this.state } satisfies ToWebview);
        return;
      case "command":
        if ((WEBVIEW_COMMANDS as readonly string[]).includes(msg.command)) this.handlers.onCommand(msg.command, Array.isArray(msg.args) ? msg.args.slice(0, 4) : []);
        return;
      case "link":
        if (typeof msg.link === "string" && msg.link.length < 2048) this.handlers.onLink?.(msg.link, msg.action === "definition" || msg.action === "references" ? msg.action : "open");
        return;
      case "linkInfo":
        if (typeof msg.link !== "string" || !this.handlers.onLinkInfo) return;
        void this.handlers.onLinkInfo(msg.link).then((info) => this.webview.postMessage({ type: "linkInfo", reqId: msg.reqId, info } satisfies ToWebview));
        return;
      case "mermaidResult": {
        const done = this.mermaidChecks.get(msg.reqId);
        this.mermaidChecks.delete(msg.reqId);
        // No engine in that webview: it could not check (null, so another one is asked), not a refusal.
        done?.(msg.unavailable === true ? null : { ok: msg.ok === true, message: typeof msg.message === "string" ? msg.message : undefined, line: typeof msg.line === "number" ? msg.line : undefined });
        return;
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    // Not checked (null), never a silent pass.
    for (const done of this.mermaidChecks.values()) done(null);
    this.mermaidChecks.clear();
  }
}
