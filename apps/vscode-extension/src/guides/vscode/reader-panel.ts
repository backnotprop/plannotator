/**
 * The Guide tab: one editor tab with Plannotator's guide reader in it
 * (`src/guides/reader/`, built to `dist/reader/`). This side sends the guide
 * and answers what the reader asks; every message from the reader is checked
 * by `parseReaderMessage` first and anything else is dropped. The reader runs
 * only the extension's own scripts (by nonce and from the extension's
 * `dist/reader`), connects nowhere but there (it fetches its highlight worker
 * to start it as a blob worker) and holds no agent HTML.
 */

import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { parseReaderMessage, type FromReader, type ReaderInit, type ToReader } from "../reader-protocol";

export const READER_VIEW_TYPE = "plannotator.guides.guide";

export function readerCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} data: blob:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    // The entry by nonce, and what it loads itself ('strict-dynamic': its lazy chunks, Shiki's
    // grammars and themes, the diagram engine). No host is listed, so no other script can run.
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    // The highlight worker: its source is fetched from the extension's folder and started from a blob.
    `worker-src blob:`,
    `connect-src ${cspSource}`,
  ].join("; ");
}

export function readerHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", ...p)).toString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${readerCsp(webview.cspSource, nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset("codicons", "codicon.css")}">
<link rel="stylesheet" href="${asset("reader", "reader.css")}">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${asset("reader", "reader.js")}"></script>
</body>
</html>`;
}

export interface ReaderPanelHandlers {
  /** What the reader shows; asked again whenever the reader (re)loads. */
  init(): ReaderInit | null;
  /** The reader loaded (again) and has its guide. */
  onReady?(): void;
  onMessage(message: Exclude<FromReader, { type: "ready" } | { type: "mermaidResult" }>): void | Promise<void>;
}

/** One Guide tab and its messages. */
export class ReaderPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  private ready = false;
  private engineUnavailable = false;
  private readonly queue: ToReader[] = [];
  private readonly subscription: vscode.Disposable;
  private nextReq = 1;
  private readonly mermaidChecks = new Map<number, (r: { ok: boolean; message?: string; line?: number } | null) => void>();

  constructor(extensionUri: vscode.Uri, title: string, private readonly handlers: ReaderPanelHandlers, column: vscode.ViewColumn = vscode.ViewColumn.Active) {
    this.panel = vscode.window.createWebviewPanel(READER_VIEW_TYPE, title, { viewColumn: column, preserveFocus: false }, {
      enableScripts: true,
      // The reader keeps its scroll, folds and mounted diffs while another tab is in front.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      enableFindWidget: true,
    });
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "images", "guides.svg");
    this.panel.webview.html = readerHtml(this.panel.webview, extensionUri);
    this.subscription = this.panel.webview.onDidReceiveMessage((raw: unknown) => this.receive(raw));
  }

  /** Send a message now, or once the reader has loaded. */
  send(message: ToReader): void {
    if (!this.ready) {
      // Only the latest of the kinds that replace each other is kept.
      if (message.type !== "init" && message.type !== "hover" && message.type !== "references") this.queue.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** The Guide tab answered that it has no diagram engine: asking again will not help. */
  get diagramEngineUnavailable(): boolean {
    return this.engineUnavailable;
  }

  /** Render a Mermaid source with the reader's engine (the builder's check); null when it could not be checked. */
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
      void this.panel.webview.postMessage({ type: "checkMermaid", reqId, source } satisfies ToReader);
    });
  }

  private receive(raw: unknown): void {
    const msg = parseReaderMessage(raw);
    if (!msg) return;
    if (msg.type === "mermaidResult") {
      const done = this.mermaidChecks.get(msg.reqId);
      this.mermaidChecks.delete(msg.reqId);
      // No engine in the Guide tab: it could not check (null), not a refusal.
      if (msg.unavailable) this.engineUnavailable = true;
      done?.(msg.unavailable ? null : { ok: msg.ok, message: msg.message, line: msg.line });
      return;
    }
    if (msg.type === "ready") {
      this.ready = true;
      const init = this.handlers.init();
      if (init) void this.panel.webview.postMessage({ type: "init", init } satisfies ToReader);
      for (const queued of this.queue.splice(0)) void this.panel.webview.postMessage(queued);
      this.handlers.onReady?.();
      return;
    }
    void Promise.resolve(this.handlers.onMessage(msg)).catch(() => undefined);
  }

  dispose(): void {
    this.subscription.dispose();
    for (const done of this.mermaidChecks.values()) done(null);
    this.mermaidChecks.clear();
    this.panel.dispose();
  }
}
