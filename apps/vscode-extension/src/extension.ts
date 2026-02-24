import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const cmd = vscode.commands.registerTextEditorCommand(
    "plannotator.addAnnotation",
    async (editor) => {
      const config = vscode.workspace.getConfiguration("plannotator");
      const prefix = config.get<string>("annotationPrefix", "@plannotator");

      const selection = editor.selection;
      const line = selection.start.line;
      const indent = editor.document.lineAt(line).text.match(/^\s*/)![0];
      const template = `${indent}<!-- ${prefix}:  -->\n`;

      const inserted = await editor.edit((eb) => {
        eb.insert(new vscode.Position(line, 0), template);
      });

      if (inserted) {
        // Position cursor between ": " and " -->"
        const cursorCol = indent.length + `<!-- ${prefix}: `.length;
        const pos = new vscode.Position(line, cursorCol);
        editor.selection = new vscode.Selection(pos, pos);
      }
    }
  );

  context.subscriptions.push(cmd);
}

export function deactivate() {}
