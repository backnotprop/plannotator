import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const addAnnotation = vscode.commands.registerTextEditorCommand(
    "plannotator.addAnnotation",
    async (editor) => {
      const config = vscode.workspace.getConfiguration("plannotator");
      const prefix = config.get<string>("annotationPrefix", "@plannotator");
      const closingTag = prefix.startsWith("@")
        ? "/" + prefix.slice(1)
        : "/" + prefix;

      const doc = editor.document;
      const selection = editor.selection;
      const startLine = selection.start.line;
      const endLine = selection.end.line;
      const multiLine = startLine !== endLine;
      const indent = doc.lineAt(startLine).text.match(/^\s*/)![0];

      // Auto-increment ID by scanning existing annotations
      const idPattern = new RegExp(`${escapeRegex(prefix)}\\s+(\\d+)`);
      let maxId = 0;
      for (let i = 0; i < doc.lineCount; i++) {
        const match = doc.lineAt(i).text.match(idPattern);
        if (match) {
          maxId = Math.max(maxId, parseInt(match[1]));
        }
      }
      const nextId = String(maxId + 1).padStart(4, "0");

      const startMarker = `${indent}<!-- ${prefix} ${nextId}:  -->\n`;

      const inserted = await editor.edit((eb) => {
        if (multiLine) {
          // Insert end marker first so startLine doesn't shift
          const endInsertLine = endLine + 1;
          const endMarker = `${indent}<!-- ${closingTag} ${nextId} -->\n`;
          eb.insert(new vscode.Position(endInsertLine, 0), endMarker);
        }
        eb.insert(new vscode.Position(startLine, 0), startMarker);
      });

      if (inserted) {
        const cursorCol =
          indent.length + `<!-- ${prefix} ${nextId}: `.length;
        const pos = new vscode.Position(startLine, cursorCol);
        editor.selection = new vscode.Selection(pos, pos);
      }
    }
  );

  const exportAnnotations = vscode.commands.registerTextEditorCommand(
    "plannotator.exportAnnotations",
    async (editor) => {
      const config = vscode.workspace.getConfiguration("plannotator");
      const prefix = config.get<string>("annotationPrefix", "@plannotator");
      const closingTag = prefix.startsWith("@")
        ? "/" + prefix.slice(1)
        : "/" + prefix;

      const doc = editor.document;
      const escapedPrefix = escapeRegex(prefix);
      const escapedClosing = escapeRegex(closingTag);

      const startPattern = new RegExp(
        `^\\s*<!--\\s*${escapedPrefix}\\s+(\\d{4}):\\s*(.*?)\\s*-->`,
      );
      const endPattern = new RegExp(
        `^\\s*<!--\\s*${escapedClosing}\\s+(\\d{4})\\s*-->`,
      );
      const anyMarkerPattern = new RegExp(
        `^\\s*<!--\\s*(?:${escapedPrefix}|${escapedClosing})\\s`,
      );

      // Collect all start markers
      const starts: { id: string; text: string; lineIndex: number }[] = [];
      for (let i = 0; i < doc.lineCount; i++) {
        const match = doc.lineAt(i).text.match(startPattern);
        if (match && match[2]) {
          starts.push({ id: match[1], text: match[2], lineIndex: i });
        }
      }

      if (starts.length === 0) {
        vscode.window.showInformationMessage(
          "No annotations found in this file.",
        );
        return;
      }

      // Resolve context for each annotation
      const annotations: { text: string; context: string; multiLine: boolean }[] = [];

      for (const start of starts) {
        // Search downward for matching end marker
        let endLineIndex = -1;
        for (let j = start.lineIndex + 1; j < doc.lineCount; j++) {
          const endMatch = doc.lineAt(j).text.match(endPattern);
          if (endMatch && endMatch[1] === start.id) {
            endLineIndex = j;
            break;
          }
        }

        if (endLineIndex > start.lineIndex + 1) {
          // Multi-line: capture lines between markers, strip inner markers
          const lines: string[] = [];
          for (let j = start.lineIndex + 1; j < endLineIndex; j++) {
            const line = doc.lineAt(j).text;
            if (!anyMarkerPattern.test(line)) {
              lines.push(line);
            }
          }
          annotations.push({
            text: start.text,
            context: lines.join("\n"),
            multiLine: true,
          });
        } else {
          // Single-line: next non-empty, non-marker line
          let context = "";
          for (let j = start.lineIndex + 1; j < doc.lineCount; j++) {
            const line = doc.lineAt(j).text;
            if (line.trim() === "") continue;
            if (anyMarkerPattern.test(line)) continue;
            context = line.trim();
            break;
          }
          annotations.push({
            text: start.text,
            context: context || "(end of file)",
            multiLine: false,
          });
        }
      }

      // Format output
      let output = "# Plan Feedback\n\n";
      output += `I've reviewed this plan and have ${annotations.length} piece${annotations.length > 1 ? "s" : ""} of feedback:\n\n`;

      annotations.forEach((ann, i) => {
        if (ann.multiLine) {
          output += `## ${i + 1}. Feedback on:\n`;
          output += "```\n" + ann.context + "\n```\n";
          output += `> ${ann.text}\n\n`;
        } else {
          output += `## ${i + 1}. Feedback on: "${ann.context}"\n`;
          output += `> ${ann.text}\n\n`;
        }
      });

      output += "---\n";

      await vscode.env.clipboard.writeText(output);
      vscode.window.showInformationMessage(
        `Exported ${annotations.length} annotation${annotations.length > 1 ? "s" : ""} to clipboard.`,
      );
    }
  );

  context.subscriptions.push(addAnnotation, exportAnnotations);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function deactivate() {}
