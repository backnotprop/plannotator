import * as vscode from "vscode";
import * as path from "path";
import { buildWrapperThemeScript } from "./vscode-theme";

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
    this.panels.add(panel);
    panel.onDidDispose(() => {
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
      window.addEventListener("message", function(e) {
        if (e.data === "plannotator-ready") { ready = true; }
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
