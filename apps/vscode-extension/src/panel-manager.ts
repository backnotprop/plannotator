import * as vscode from "vscode";
import * as path from "path";
import { buildWrapperThemeScript } from "./vscode-theme";

// Messages the app iframe sends up to the extension host (see the clipboard
// bridge injected in cookie-proxy.ts).
type ClipboardWriteMessage = { type: "plannotator-clipboard-write"; text: string };
type ClipboardReadMessage = { type: "plannotator-clipboard-read"; id: number };
// External links (PR pages, release notes): the nested app iframe inherits the
// webview's sandbox, which has no allow-popups, so window.open and
// target=_blank links are dead there. The cookie-proxy bridge routes absolute
// http(s) URLs up here instead (#1583).
type OpenExternalMessage = { type: "plannotator-open-external"; url: string };
type WebviewMessage = ClipboardWriteMessage | ClipboardReadMessage | OpenExternalMessage;

/** The http(s) URL an open-external message may open, or null. */
export function externalUrlToOpen(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export class PanelManager {
  private panels: Set<vscode.WebviewPanel> = new Set();
  private extensionPath: string = "";

  setExtensionPath(p: string): void {
    this.extensionPath = p;
  }

  async open(url: string): Promise<vscode.WebviewPanel> {
    const resolved = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    const resolvedUrl = resolved.toString();

    const panel = vscode.window.createWebviewPanel(
      "plannotator",
      "Plannotator",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.file(
      path.join(this.extensionPath, "images", "icon.png"),
    );
    const origin = `${resolved.scheme}://${resolved.authority}`;
    panel.webview.html = getHtml(resolvedUrl, origin);

    const messageSub = panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = raw as WebviewMessage;
      if (msg.type === "plannotator-clipboard-write") {
        await vscode.env.clipboard.writeText(msg.text ?? "");
      } else if (msg.type === "plannotator-clipboard-read") {
        const text = await vscode.env.clipboard.readText();
        panel.webview.postMessage({ type: "plannotator-clipboard-data", id: msg.id, text });
      } else if (msg.type === "plannotator-open-external") {
        const target = externalUrlToOpen(msg.url);
        // VS Code asks before opening an untrusted domain.
        if (target) await vscode.env.openExternal(vscode.Uri.parse(target));
      }
    });

    this.panels.add(panel);
    panel.onDidDispose(() => {
      messageSub.dispose();
      this.panels.delete(panel);
    });
    return panel;
  }

  closeAll(): void {
    for (const panel of this.panels) {
      panel.dispose();
    }
  }
}

function getHtml(url: string, origin: string): string {
  const themeScript = buildWrapperThemeScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${origin};">
  <style>
    body { margin: 0; padding: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    iframe { flex: 1; width: 100%; border: none; }
  </style>
</head>
<body>
  <iframe id="pn-frame" src="${url}"></iframe>
  ${themeScript}
  <script>
    (function() {
      var ready = false;
      var reloads = 0;
      var vscodeApi = acquireVsCodeApi();
      window.addEventListener("message", function(e) {
        var d = e.data;
        if (d === "plannotator-ready") { ready = true; return; }
        if (d && d.type === "plannotator-keydown") {
          // Re-dispatch keystrokes forwarded from the nested app iframe so VS
          // Code's keybinding service (which listens on the webview document)
          // can resolve global shortcuts like Cmd+P while the app is focused.
          window.dispatchEvent(new KeyboardEvent("keydown", d.event));
          return;
        }
        // Relay clipboard requests up to the extension host (owns the system
        // clipboard) and responses back down to the app iframe.
        if (d && (d.type === "plannotator-clipboard-write" || d.type === "plannotator-clipboard-read")) {
          vscodeApi.postMessage(d);
          return;
        }
        // Only the app frame itself may ask to open a link: a page nested
        // inside it (an annotated HTML document) has a different source.
        if (d && d.type === "plannotator-open-external") {
          var app = document.getElementById("pn-frame");
          if (app && e.source === app.contentWindow && typeof d.url === "string") {
            vscodeApi.postMessage({ type: "plannotator-open-external", url: d.url });
          }
          return;
        }
        if (d && d.type === "plannotator-clipboard-data") {
          var f = document.getElementById("pn-frame");
          if (f && f.contentWindow) f.contentWindow.postMessage(d, "*");
        }
      });
      setTimeout(function() {
        if (!ready && reloads < 1) {
          reloads++;
          var f = document.getElementById("pn-frame");
          if (f) { f.src = f.src; }
        }
      }, 3000);
    })();
  </script>
</body>
</html>`;
}
