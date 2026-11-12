import * as vscode from "vscode";
import * as path from "path";
import * as http from "http";

let activeProxyPort: number | null = null;
let commentController: vscode.CommentController | null = null;
let annotationDecorationType: vscode.TextEditorDecorationType | null = null;

const threadIds = new Map<vscode.CommentThread, string>();

const decoratedRanges = new Map<string, vscode.Range[]>();

export function setActiveProxyPort(port: number | null): void {
  activeProxyPort = port;
  if (port !== null) {
    createController();
  } else {
    disposeAllThreads();
    clearAllDecorations();
    if (commentController) {
      commentController.dispose();
      commentController = null;
    }
  }
}

function createController(): void {
  if (commentController) return;

  commentController = vscode.comments.createCommentController(
    "plannotator",
    "Plannotator",
  );

  commentController.options = {
    prompt: "Add annotation comment (optional)",
    placeHolder: "Your comment...",
  };
}

export function registerEditorAnnotationCommand(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
): void {
  const gutterIconPath = vscode.Uri.file(
    path.join(context.extensionPath, "images", "annotation-gutter.svg"),
  );

  annotationDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255, 180, 50, 0.15)",
    isWholeLine: true,
    borderWidth: "0 0 0 4px",
    borderStyle: "solid",
    borderColor: "rgba(255, 180, 50, 0.7)",
    overviewRulerColor: "rgba(255, 180, 50, 0.7)",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    gutterIconPath,
    gutterIconSize: "contain",
  });

  const submitCommand = vscode.commands.registerCommand(
    "plannotator-webview.submitComment",
    async (reply: vscode.CommentReply) => {
      if (activeProxyPort === null) return;

      const thread = reply.thread;
      const range = thread.range;
      if (!range) return;

      const document = await vscode.workspace.openTextDocument(thread.uri);
      const selectedText = document.getText(range);
      const filePath = vscode.workspace.asRelativePath(thread.uri, false);
      const lineStart = range.start.line + 1;
      const lineEnd = range.end.line + 1;

      try {
        const body = JSON.stringify({
          filePath,
          selectedText,
          lineStart,
          lineEnd,
          comment: reply.text || undefined,
        });

        const responseBody = await requestProxy(
          activeProxyPort,
          "POST",
          "/api/editor-annotation",
          body,
        );
        const { id } = JSON.parse(responseBody);

        const comment: vscode.Comment = {
          body: reply.text || "_(no comment)_",
          mode: vscode.CommentMode.Preview,
          author: { name: "You" },
        };
        thread.comments = [comment];
        thread.canReply = false;
        thread.contextValue = "plannotator-thread";
        threadIds.set(thread, id);

        addDecoration(thread.uri, range);

        log.info(
          `[editor-annotation] added: ${filePath}:${lineStart}-${lineEnd}`,
        );
      } catch (err) {
        log.error(`[editor-annotation] failed: ${err}`);
        vscode.window.showErrorMessage(
          "Plannotator: Failed to add annotation",
        );
        thread.dispose();
      }
    },
  );
  context.subscriptions.push(submitCommand);

  const deleteCommand = vscode.commands.registerCommand(
    "plannotator-webview.deleteEditorAnnotation",
    async (thread: vscode.CommentThread) => {
      if (activeProxyPort === null) return;

      const id = threadIds.get(thread);
      if (id) {
        try {
          await requestProxy(
            activeProxyPort,
            "DELETE",
            `/api/editor-annotation?id=${encodeURIComponent(id)}`,
          );
        } catch (err) {
          log.error(`[editor-annotation] delete failed: ${err}`);
        }
        threadIds.delete(thread);
      }

      if (thread.range) {
        removeDecoration(thread.uri, thread.range);
      }
      thread.dispose();
    },
  );
  context.subscriptions.push(deleteCommand);

  const addCommand = vscode.commands.registerCommand(
    "plannotator-webview.addEditorAnnotation",
    async () => {
      if (activeProxyPort === null) {
        vscode.window.showInformationMessage(
          "No active Plannotator session. Open a plan review first.",
        );
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showInformationMessage(
          "Select text in the editor first.",
        );
        return;
      }

      const range = new vscode.Range(
        editor.selection.start,
        editor.selection.end,
      );
      const thread = commentController!.createCommentThread(editor.document.uri, range, []);
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    },
  );
  context.subscriptions.push(addCommand);

  const codeActionProvider = vscode.languages.registerCodeActionsProvider(
    "*",
    {
      provideCodeActions(document, range) {
        if (activeProxyPort === null || range.isEmpty) return [];

        const action = new vscode.CodeAction(
          "Plannotator: Annotate Selection",
          vscode.CodeActionKind.RefactorInline,
        );
        action.command = {
          command: "plannotator-webview.addEditorAnnotation",
          title: "Plannotator: Annotate Selection",
        };
        return [action];
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.RefactorInline] },
  );
  context.subscriptions.push(codeActionProvider);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) refreshDecorations(editor);
    }),
  );
}

function addDecoration(uri: vscode.Uri, range: vscode.Range): void {
  const key = uri.toString();
  const ranges = decoratedRanges.get(key) ?? [];
  ranges.push(range);
  decoratedRanges.set(key, ranges);

  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === key,
  );
  if (editor) refreshDecorations(editor);
}

function removeDecoration(uri: vscode.Uri, range: vscode.Range): void {
  const key = uri.toString();
  const ranges = decoratedRanges.get(key);
  if (!ranges) return;

  const idx = ranges.findIndex(
    (r) => r.isEqual(range),
  );
  if (idx !== -1) ranges.splice(idx, 1);
  if (ranges.length === 0) decoratedRanges.delete(key);

  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.toString() === key,
  );
  if (editor) refreshDecorations(editor);
}

function refreshDecorations(editor: vscode.TextEditor): void {
  if (!annotationDecorationType) return;
  const uri = editor.document.uri.toString();
  const ranges = decoratedRanges.get(uri) ?? [];
  editor.setDecorations(annotationDecorationType, ranges);
}

function clearAllDecorations(): void {
  if (!annotationDecorationType) return;
  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(annotationDecorationType, []);
  }
  decoratedRanges.clear();
}

function disposeAllThreads(): void {
  for (const [thread] of threadIds) {
    thread.dispose();
  }
  threadIds.clear();
}

function requestProxy(
  port: number,
  method: string,
  urlPath: string,
  body?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {};
    if (body) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
