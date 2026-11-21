/**
 * Code intelligence for overview links and for the builder's checks: the
 * language server first (workspace and document symbols, hover, definition,
 * references), a text search in the changed files when it has nothing.
 */

import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { GuideSymbolResolution } from "../core/adapter";
import { parseGuideLink, type GuideLink } from "../core/adapter";
import { searchDefinitions } from "../symbol-search";
import type { LinkInfo } from "../webview-protocol";
import type { ReaderModel, ReaderSides } from "../reader-model";
import { headUri } from "./uris";
import { headLeavesRepo, realFileInside } from "../safe-path";

const CHAPTER_COLORS = ["charts.yellow", "charts.blue", "charts.purple", "charts.green", "charts.orange", "charts.red"];
const CHAPTER_HEX = ["#e2b93d", "#3794ff", "#b180d7", "#89d185", "#d18616", "#f14c4c"];

export function chapterColorId(index: number): string {
  return CHAPTER_COLORS[index % CHAPTER_COLORS.length];
}

export function chapterColorCss(index: number): string {
  return `var(--vscode-${chapterColorId(index).replace(".", "-")}, ${CHAPTER_HEX[index % CHAPTER_HEX.length]})`;
}

function relInside(root: string, fsPath: string): string | null {
  const rel = relative(root, fsPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

interface SymbolCandidate {
  path: string;
  line: number;
  character: number;
  container?: string;
}

/** Workspace symbols named exactly `name` (or ending in `.name`) under `root`. */
async function workspaceSymbols(name: string, root: string): Promise<SymbolCandidate[]> {
  const short = name.split(".").pop()!;
  let found: vscode.SymbolInformation[] | undefined;
  try {
    found = await vscode.commands.executeCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", short);
  } catch {
    return [];
  }
  const out: SymbolCandidate[] = [];
  for (const s of found ?? []) {
    if (s.name !== short && s.name !== name) continue;
    if (name.includes(".") && s.containerName && !name.startsWith(`${s.containerName}.`)) continue;
    const path = relInside(root, s.location.uri.fsPath);
    if (!path) continue;
    out.push({ path, line: s.location.range.start.line + 1, character: s.location.range.start.character, container: s.containerName });
  }
  return dedupe(out).filter((c) => !isImportLine(root, c));
}

/** Workspace symbols include import and re-export aliases: they are not where a symbol is defined. */
function isImportLine(root: string, c: SymbolCandidate): boolean {
  const real = realFileInside(root, c.path);
  if (!real) return false;
  try {
    const line = readFileSync(real, "utf8").split("\n")[c.line - 1] ?? "";
    return /^\s*(import\b|export\s*(\*|\{|type\s*\{))/.test(line) || /^\s*[\w$,\s{}]*\}\s*from\s*["']/.test(line);
  } catch {
    return false;
  }
}

/** Document symbols of one file named `name`. */
async function documentSymbols(uri: vscode.Uri, name: string, path: string): Promise<SymbolCandidate[]> {
  let symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined;
  try {
    symbols = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>("vscode.executeDocumentSymbolProvider", uri);
  } catch {
    return [];
  }
  const short = name.split(".").pop()!;
  const out: SymbolCandidate[] = [];
  const walk = (list: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, container?: string) => {
    for (const s of list) {
      const range = "selectionRange" in s ? s.selectionRange : s.location.range;
      if (s.name === short) out.push({ path, line: range.start.line + 1, character: range.start.character, container });
      if ("children" in s && s.children?.length) walk(s.children, s.name);
    }
  };
  walk(symbols ?? []);
  return out;
}

function dedupe(list: SymbolCandidate[]): SymbolCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = `${c.path}:${c.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Where a symbol is, in order: language server, then text search in the changed files. */
export async function findSymbol(name: string, path: string | undefined, headRoot: string, changedPaths: readonly string[]): Promise<SymbolCandidate[]> {
  if (path) {
    // A path that leaves the repository (a symlink out of it) is never handed to a language server or read.
    if (!realFileInside(headRoot, path)) return [];
    const fromDoc = await documentSymbols(vscode.Uri.file(join(headRoot, path)), name, path);
    if (fromDoc.length) return fromDoc;
    const hits = await searchDefinitions(headRoot, [path], name);
    return hits.map((h) => ({ ...h, character: 0 }));
  }
  const fromWorkspace = await workspaceSymbols(name, headRoot);
  if (fromWorkspace.length === 1) return fromWorkspace;
  if (fromWorkspace.length > 1) {
    // Prefer the definitions in the change when the name is common.
    const inChange = fromWorkspace.filter((c) => changedPaths.includes(c.path));
    return inChange.length ? inChange : fromWorkspace;
  }
  const hits = await searchDefinitions(headRoot, changedPaths, name);
  return hits.map((h) => ({ ...h, character: 0 }));
}

/** The builder's `resolveSymbol` hook. */
export async function resolveSymbolForBuilder(name: string, path: string | undefined, headRoot: string, changedPaths: readonly string[]): Promise<GuideSymbolResolution> {
  const found = await findSymbol(name, path, headRoot, changedPaths);
  if (found.length === 1) return { status: "found" };
  if (found.length > 1) return { status: "ambiguous", candidates: found.slice(0, 8).map((c) => `symbol:${c.path}#${name} (line ${c.line})`) };
  return { status: "missing" };
}

export interface LinkTarget {
  uri: vscode.Uri;
  /** Repo-relative, when the link points into the repository. */
  path: string;
  range: vscode.Range;
  inChange: boolean;
  chapter: number;
  label: string;
}

/** Where a `code:` or `symbol:` link points in the open guide. */
export async function locateLink(link: GuideLink, reader: ReaderModel, sides: ReaderSides): Promise<LinkTarget | { error: string }> {
  const headRoot = sides.head.kind === "fs" ? sides.head.root : sides.gitRoot;
  const changed = [...reader.files.keys()];
  const fileFor = (path: string) => reader.files.get(path) ?? { path, status: "modified" };
  // A file on disk only when it is a regular file inside the repository once symlinks are followed
  // (the link is the agent's; the change could add a symlink out of the repository).
  const outside = (path: string) => headLeavesRepo(sides, fileFor(path));
  if (link.kind === "code") {
    if (outside(link.path)) return { error: `${link.path} is not a file inside the repository; not opened.` };
    const uri = headUri(sides, fileFor(link.path));
    const start = Math.max(0, (link.startLine ?? 1) - 1);
    const end = Math.max(start, (link.endLine ?? link.startLine ?? 1) - 1);
    return {
      uri,
      path: link.path,
      range: new vscode.Range(start, 0, end, 0),
      inChange: reader.files.has(link.path),
      chapter: reader.chapterOf(link.path),
      label: `${link.path.split("/").pop()}${link.startLine ? `#L${link.startLine}${link.endLine ? `-L${link.endLine}` : ""}` : ""}`,
    };
  }
  if (link.kind === "symbol") {
    // Refused before anything is asked or read: the link's own path may be a symlink out of the repository.
    if (link.path && outside(link.path)) return { error: `${link.path} is not a file inside the repository; not opened.` };
    const found = await findSymbol(link.name, link.path, headRoot, changed);
    if (found.length === 0) return { error: `No symbol named ${link.name} was found.` };
    const hit = { ...found[0] };
    if (outside(hit.path)) return { error: `${hit.path} is not a file inside the repository; not opened.` };
    if (hit.character === 0) hit.character = nameColumn(headRoot, hit.path, hit.line, link.name);
    return {
      uri: headUri(sides, fileFor(hit.path)),
      path: hit.path,
      range: new vscode.Range(hit.line - 1, hit.character, hit.line - 1, hit.character),
      inChange: reader.files.has(hit.path),
      chapter: reader.chapterOf(hit.path),
      label: link.name,
    };
  }
  return { error: "A chapter link has no code location." };
}

export function hoverText(hovers: vscode.Hover[] | undefined): string | undefined {
  const parts: string[] = [];
  for (const h of hovers ?? []) {
    for (const c of h.contents) {
      if (typeof c === "string") parts.push(c);
      else if (c instanceof vscode.MarkdownString) parts.push(c.value);
      else if ("language" in c) parts.push("```" + c.language + "\n" + c.value + "\n```");
      else parts.push((c as { value: string }).value);
    }
  }
  const text = parts.filter((p) => p.trim()).join("\n\n---\n\n");
  return text ? text.slice(0, 6000) : undefined;
}

/** The column of `name` on a line (so hover and references answer for the symbol, not a keyword). */
function nameColumn(root: string, path: string, line: number, name: string): number {
  const real = realFileInside(root, path);
  if (!real) return 0;
  try {
    const text = readFileSync(real, "utf8").split("\n")[line - 1] ?? "";
    const short = name.split(".").pop()!;
    const m = new RegExp(`\\b${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).exec(text);
    return m ? m.index : 0;
  } catch {
    return 0;
  }
}

/** Set while the popover asks the language server, so the guide's own hover line stays out of it. */
export let askingLanguageServer = 0;

/** Run `ask` with the guide's own hover line kept out of the language server's answer. */
export async function withoutGuideHoverLine<T>(ask: () => Promise<T>): Promise<T> {
  askingLanguageServer++;
  try {
    return await ask();
  } finally {
    askingLanguageServer--;
  }
}

/** What the overview's hover popover shows for a link (SPEC 3.5). */
export async function linkInfo(href: string, reader: ReaderModel, sides: ReaderSides): Promise<LinkInfo> {
  const parsed = parseGuideLink(href);
  if (!parsed || !parsed.ok) return { ok: false, label: href, inChange: false, message: parsed && !parsed.ok ? parsed.error : "Not a guide link." };
  const link = parsed.link;
  if (link.kind === "chapter") {
    const i = link.chapter - 1;
    const ch = reader.chapters[i];
    if (!ch) return { ok: false, label: href, inChange: false, message: `The guide has ${reader.chapters.length} chapters.` };
    return {
      ok: true,
      label: `Chapter ${link.chapter}`,
      location: `${ch.files.length} ${ch.files.length === 1 ? "file" : "files"}`,
      hover: ch.overview.split("\n\n")[0],
      inChange: true,
      chapter: { n: link.chapter, title: ch.title, reviewed: reader.reviewed[i], color: chapterColorCss(i) },
    };
  }
  const target = await locateLink(link, reader, sides);
  if ("error" in target) return { ok: false, label: href.replace(/^\w+:/, ""), inChange: false, message: target.error };
  const pos = await firstWordPosition(target.uri, target.range.start);
  askingLanguageServer++;
  const ask = () =>
    Promise.all([
      vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", target.uri, pos).then(undefined, () => undefined),
      vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", target.uri, pos).then(undefined, () => undefined),
      vscode.commands.executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", target.uri, pos).then(undefined, () => undefined),
    ]);
  let [hovers, defs, refs] = await ask().catch(() => [undefined, undefined, undefined] as const);
  if ((!hoverText(hovers) && !defs?.length) || /^\s*(```\w*\s*)?\(loading\.\.\.\)/.test(hoverText(hovers) ?? "")) {
    // A file the language server just opened (a PR worktree is outside the workspace): it may need a moment.
    await new Promise((r) => setTimeout(r, 1200));
    [hovers, defs, refs] = await ask().catch(() => [undefined, undefined, undefined] as const);
  }
  askingLanguageServer--;
  const def = defs?.[0];
  const defUri = def ? ("targetUri" in def ? def.targetUri : def.uri) : undefined;
  return {
    ok: true,
    label: target.label,
    location: `${target.path}:${target.range.start.line + 1}`,
    hover: hoverText(hovers),
    ...(defUri && { definedIn: defUri.path.split("/").pop() }),
    ...(refs && { references: refs.length }),
    inChange: target.inChange,
    ...(target.chapter >= 0 && {
      chapter: { n: target.chapter + 1, title: reader.chapters[target.chapter].title, reviewed: reader.reviewed[target.chapter], color: chapterColorCss(target.chapter) },
    }),
  };
}

/** The first non-space character of the line, where hover and references answer. */
async function firstWordPosition(uri: vscode.Uri, at: vscode.Position): Promise<vscode.Position> {
  try {
    // Open it either way: the language server answers only for documents it has.
    const doc = await vscode.workspace.openTextDocument(uri);
    if (at.character > 0) return at;
    const line = doc.lineAt(Math.min(at.line, doc.lineCount - 1));
    // The first name on the line that is not a keyword: `export async function deliverWebhook(` → `deliverWebhook`.
    const keywords = /^(export|default|async|function|const|let|var|class|interface|type|enum|public|private|protected|static|readonly|abstract|def|fn|func|pub|struct|impl|return|await|new|import|from|CREATE|TABLE|INDEX|UNIQUE)$/i;
    for (const m of line.text.matchAll(/[A-Za-z_$][\w$]*/g)) {
      if (!keywords.test(m[0])) return new vscode.Position(line.lineNumber, m.index ?? 0);
    }
    return new vscode.Position(line.lineNumber, line.firstNonWhitespaceCharacterIndex);
  } catch {
    return at;
  }
}
