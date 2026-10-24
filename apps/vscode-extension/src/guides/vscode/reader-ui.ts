/**
 * "You are here" in the native diff editor (SPEC 3.4): a CodeLens at the top
 * of each guide file ("● Chapter 2 of 5 · title | Mark reviewed | Next file
 * ›"), a chapter-colored gutter mark and highlight of the agent's focus
 * lines, a status-bar item, and a line in the hover for symbols changed in a
 * chapter.
 */

import * as vscode from "vscode";
import type { ReaderModel, ReaderSides } from "../reader-model";
import { GUIDE_SCHEME, headPathOf } from "./uris";
import * as intel from "./intel";
import { chapterColorId } from "./intel";

const DOT_HEX = ["#e2b93d", "#3794ff", "#b180d7", "#89d185", "#d18616", "#f14c4c"];

export interface ReaderUiHost {
  current(): { model: ReaderModel; sides: ReaderSides } | null;
}

export class ReaderUi implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lensChanged = new vscode.EventEmitter<void>();
  private readonly status: vscode.StatusBarItem;
  private readonly gutter: vscode.TextEditorDecorationType[];
  private readonly focus: vscode.TextEditorDecorationType;
  private inHover = false;
  /** A question being answered: the status bar says so, and opens its answer. */
  private answering: { text: string; answerId: string } | null = null;

  constructor(private readonly host: ReaderUiHost) {
    const selector: vscode.DocumentSelector = [{ scheme: "file" }, { scheme: GUIDE_SCHEME }];
    this.disposables.push(
      vscode.languages.registerCodeLensProvider(selector, {
        onDidChangeCodeLenses: this.lensChanged.event,
        provideCodeLenses: (doc) => this.lenses(doc),
      }),
      vscode.languages.registerHoverProvider(selector, { provideHover: (doc, pos, token) => this.hover(doc, pos, token) }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.decorate()),
      this.lensChanged,
    );
    this.status = vscode.window.createStatusBarItem("plannotator.guides.status", vscode.StatusBarAlignment.Left, 50);
    this.status.name = "Plannotator Guide";
    this.status.command = "plannotator.guides.openChapter";
    this.gutter = DOT_HEX.map((hex) =>
      vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4" fill="${hex}"/></svg>`)}`),
        gutterIconSize: "contain",
        overviewRulerColor: hex,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      }),
    );
    this.focus = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.rangeHighlightForeground"),
    });
  }

  /** Redraw everything after the guide, the ticks or the current file changed. */
  refresh(): void {
    this.lensChanged.fire();
    this.decorate();
    this.updateStatus();
  }

  private pathOf(doc: vscode.TextDocument): { path: string; model: ReaderModel } | null {
    const cur = this.host.current();
    if (!cur) return null;
    const path = headPathOf(cur.sides, doc.uri);
    if (!path || cur.model.chapterOf(path) < 0) return null;
    return { path, model: cur.model };
  }

  private lenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const hit = this.pathOf(doc);
    if (!hit) return [];
    const { model, path } = hit;
    const chapter = model.chapterOf(path);
    const range = new vscode.Range(0, 0, 0, 0);
    const reviewed = model.fileTicks.has(path);
    const next = model.nextFile(path);
    return [
      new vscode.CodeLens(range, {
        title: `● Chapter ${chapter + 1} of ${model.chapters.length} · ${model.chapters[chapter].title}`,
        command: "plannotator.guides.openChapter",
        arguments: [chapter + 1, { openFile: false }],
        tooltip: "Show the chapter overview",
      }),
      new vscode.CodeLens(range, {
        title: reviewed ? "✓ Reviewed" : "Mark reviewed",
        command: "plannotator.guides.toggleFileReviewed",
        arguments: [path],
        tooltip: reviewed ? "Untick this file" : "Tick this file; the chapter ticks itself when all its files are ticked",
      }),
      new vscode.CodeLens(range, {
        title: "Ask…",
        command: "plannotator.guides.askAboutFile",
        arguments: [path],
        tooltip: "Ask the agent about the selected lines, or the whole file; the answer opens beside the diff",
      }),
      new vscode.CodeLens(range, next
        ? { title: "Next file ›", command: "plannotator.guides.nextFile", arguments: [path], tooltip: `${next.path} (chapter ${next.chapter + 1})` }
        : { title: "Last file", command: "" }),
    ];
  }

  private decorate(): void {
    const cur = this.host.current();
    for (const editor of vscode.window.visibleTextEditors) {
      for (const g of this.gutter) editor.setDecorations(g, []);
      editor.setDecorations(this.focus, []);
      if (!cur) continue;
      const path = headPathOf(cur.sides, editor.document.uri);
      if (!path) continue;
      const chapter = cur.model.chapterOf(path);
      if (chapter < 0) continue;
      const hunks = cur.model.files.get(path)?.hunks ?? [];
      const marks = (hunks.length ? hunks : [{ start: 1, end: 1 }]).map((h) => new vscode.Range(h.start - 1, 0, h.start - 1, 0));
      editor.setDecorations(this.gutter[chapter % this.gutter.length], marks);
      const focus = cur.model.focusRanges(path).map((r) => new vscode.Range(r.start - 1, 0, Math.max(r.start, r.end) - 1, 0));
      editor.setDecorations(this.focus, focus);
    }
  }

  /** Say in the status bar that a question is being answered (null: it was). */
  setAnswering(text: string | null, answerId: string | null): void {
    this.answering = text && answerId ? { text, answerId } : null;
    this.updateStatus(this.lastFile);
  }

  private lastFile: string | null | undefined = null;

  updateStatus(currentFile?: string | null): void {
    this.lastFile = currentFile;
    const cur = this.host.current();
    if (this.answering) {
      const q = this.answering.text.length > 48 ? `${this.answering.text.slice(0, 46)}…` : this.answering.text;
      this.status.text = `$(loading~spin) Answering · ${q}`;
      this.status.tooltip = `The agent is answering: ${this.answering.text}`;
      this.status.command = { command: "plannotator.guides.openAnswer", title: "Show the answer", arguments: [this.answering.answerId] };
      this.status.show();
      return;
    }
    if (!cur) {
      this.status.hide();
      return;
    }
    const m = cur.model;
    const chapter = m.currentChapter;
    this.status.text = `$(book) Guide: Chapter ${chapter + 1}/${m.chapters.length} · ${m.filesReviewedCount()}/${m.orderedFiles().length} files reviewed`;
    this.status.tooltip = `${m.title}\n${m.chapters[chapter]?.title ?? ""}${currentFile ? `\n${currentFile}` : ""}`;
    this.status.command = { command: "plannotator.guides.openChapter", title: "Show chapter", arguments: [chapter + 1, { openFile: false }] };
    this.status.show();
  }

  /**
   * The language server's own hover stays as it is; this adds one line when
   * the symbol under the pointer is defined in a file of the guide.
   */
  private async hover(doc: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    const cur = this.host.current();
    if (!cur || this.inHover || intel.askingLanguageServer > 0) return undefined;
    if (!headPathOf(cur.sides, doc.uri)) return undefined;
    const word = doc.getWordRangeAtPosition(pos);
    if (!word) return undefined;
    this.inHover = true;
    try {
      const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", doc.uri, pos);
      if (token.isCancellationRequested) return undefined;
      for (const def of defs ?? []) {
        const uri = "targetUri" in def ? def.targetUri : def.uri;
        const path = headPathOf(cur.sides, uri);
        if (!path) continue;
        const chapter = cur.model.chapterOf(path);
        if (chapter < 0) continue;
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`$(circle-filled) Changed in **Chapter ${chapter + 1} · ${escape(cur.model.chapters[chapter].title)}**`);
        if (cur.model.reviewed[chapter]) md.appendMarkdown(" &nbsp;$(check) reviewed");
        md.isTrusted = false;
        return new vscode.Hover(md, word);
      }
    } catch {
      return undefined;
    } finally {
      this.inHover = false;
    }
    return undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const g of this.gutter) g.dispose();
    this.focus.dispose();
    this.status.dispose();
  }
}

function escape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}

export { chapterColorId };
