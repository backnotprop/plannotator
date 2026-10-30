/**
 * The Guide tab's code intelligence: a position the reader's diff reports
 * (a file of the change, a side, a line and a column, the token there) is
 * found in the real document (the head side is the file on disk or in the PR
 * worktree; the base side the `plannotator-guide:` document from git), and
 * the language server answers for it through the `vscode.execute*Provider`
 * commands: hover, definition, references.
 */

import * as vscode from "vscode";
import { isAbsolute, relative } from "node:path";
import type { ReaderModel, ReaderSides } from "../reader-model";
import { locateToken, splitHoverMarkdown, type TokenSpot } from "../reader-mapping";
import type { DiffPosition, HoverAnswer } from "../reader-protocol";
import { chapterColorCss, hoverText, withoutGuideHoverLine } from "./intel";
import { baseUri, docSideOf, headUri } from "./uris";
import { headLeavesRepo } from "../safe-path";

export interface ReaderContext {
  model: ReaderModel;
  sides: ReaderSides;
}

export interface ResolvedPosition {
  uri: vscode.Uri;
  position: vscode.Position;
  spot: TokenSpot;
}

/** The document and position a diff position names, or null when the token is not there any more. */
export async function resolvePosition(at: DiffPosition, ctx: ReaderContext): Promise<ResolvedPosition | null> {
  // Only a file of the guide: the reader's diffs show nothing else.
  const file = ctx.model.files.get(at.path);
  if (!file) return null;
  // The head on disk only when it is a regular file inside the repository once symlinks are
  // followed: a change can add `notes.md -> ~/.aws/credentials`, never opened (nor hovered).
  if (at.side === "new" && headLeavesRepo(ctx.sides, file)) return null;
  const uri = at.side === "new" ? headUri(ctx.sides, file) : baseUri(ctx.sides, file);
  let doc: vscode.TextDocument;
  try {
    // Open it either way: the language server answers only for documents it has.
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return null;
  }
  const spot = locateToken((l) => (l >= 1 && l <= doc.lineCount ? doc.lineAt(l - 1).text : undefined), at.line, at.character, at.token);
  if (!spot) return null;
  return { uri, position: new vscode.Position(spot.line - 1, spot.character), spot };
}

/**
 * A location as the reader names it: repo-relative with its side when it is
 * one of the guide's two versions (the head on disk or at its revision, the
 * base revision), else its file name.
 */
function readerPath(uri: vscode.Uri, ctx: ReaderContext): { path: string; inRepo: boolean; side: "old" | "new" | null } {
  const doc = docSideOf(ctx.sides, uri);
  if (doc) return { path: doc.path, inRepo: true, side: doc.side === "base" ? "old" : "new" };
  const root = ctx.sides.head.kind === "fs" ? ctx.sides.head.root : null;
  if (root && uri.scheme === "file") {
    const rel = relative(root, uri.fsPath);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return { path: rel.split("\\").join("/"), inRepo: true, side: "new" };
  }
  return { path: uri.path.split("/").pop() ?? uri.path, inRepo: false, side: null };
}

/** The guide file a definition is in (the file's path in the change), on its side; null when the guide does not show it. */
export function guideFileAt(where: { path: string; side: "old" | "new" | null }, ctx: ReaderContext): { path: string; side: "old" | "new" } | null {
  if (!where.side) return null;
  if (where.side === "new") return ctx.model.chapterOf(where.path) >= 0 && ctx.model.files.get(where.path)?.status !== "deleted" ? { path: where.path, side: "new" } : null;
  for (const f of ctx.model.files.values()) {
    if (f.status === "added") continue;
    if ((f.oldPath ?? f.path) === where.path && ctx.model.chapterOf(f.path) >= 0) return { path: f.path, side: "old" };
  }
  return null;
}

function locationOf(d: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
  return "targetUri" in d ? { uri: d.targetUri, range: d.targetSelectionRange ?? d.targetRange } : { uri: d.uri, range: d.range };
}

/**
 * The definition to show: the first one the language server gives, past an
 * import of the name (a server that has not loaded the project yet answers
 * with the import line in the same file; asking again from there reaches the
 * declaration).
 */
async function realDefinition(defs: Array<vscode.Location | vscode.LocationLink> | undefined): Promise<{ uri: vscode.Uri; range: vscode.Range } | null> {
  if (!defs?.length) return null;
  let loc = locationOf(defs[0]);
  for (let hop = 0; hop < 2; hop++) {
    let line = "";
    try {
      line = (await vscode.workspace.openTextDocument(loc.uri)).lineAt(loc.range.start.line).text;
    } catch {
      return loc;
    }
    if (!/^\s*(import|export\s*\{[^}]*\}\s*from)\b/.test(line)) return loc;
    const next = await vscode.commands
      .executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", loc.uri, loc.range.start)
      .then(undefined, () => undefined);
    const other = next?.map(locationOf).find((n) => n.uri.toString() !== loc.uri.toString() || n.range.start.line !== loc.range.start.line);
    if (!other) return loc;
    loc = other;
  }
  return loc;
}

const LOADING = /^\s*(```\w*\s*)?\(loading\.\.\.\)/;
const LOADING_POLL_MS = 300;
const LOADING_WAIT_MS = 5_000;

/** The hover card's contents: the language server's hover and the definition, plus the guide's chapter. */
export async function readerHover(at: DiffPosition, ctx: ReaderContext): Promise<HoverAnswer | null> {
  const t0 = Date.now();
  const where = await resolvePosition(at, ctx);
  if (!where) return null;
  const ask = () =>
    withoutGuideHoverLine(() =>
      Promise.all([
        vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", where.uri, where.position).then(undefined, () => undefined),
        vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", where.uri, where.position).then(undefined, () => undefined),
      ]),
    );
  let [hovers, defs] = await ask();
  // A language server still loading the project answers "(loading...)" (a PR worktree outside the
  // workspace, the first hover in a window): ask again for a few seconds, as the editor's own hover does.
  for (let waited = 0; LOADING.test(hoverText(hovers) ?? "") && waited < LOADING_WAIT_MS; waited += LOADING_POLL_MS) {
    await new Promise((r) => setTimeout(r, LOADING_POLL_MS));
    [hovers, defs] = await ask();
  }
  const text = hoverText(hovers) ?? "";
  const blocks = LOADING.test(text) ? [] : splitHoverMarkdown(text);
  const first = await realDefinition(defs);
  const def = first ? { ...readerPath(first.uri, ctx), line: first.range.start.line + 1, character: first.range.start.character } : null;
  if (!blocks.length && !def) return null;
  const inGuide = def ? guideFileAt(def, ctx) : null;
  const chapterIndex = inGuide ? ctx.model.chapterOf(inGuide.path) : -1;
  return {
    symbol: at.token,
    blocks,
    definition: def,
    chapter:
      chapterIndex >= 0
        ? { n: chapterIndex + 1, title: ctx.model.chapters[chapterIndex].title, reviewed: ctx.model.reviewed[chapterIndex], color: chapterColorCss(chapterIndex) }
        : null,
    referenceCount: null,
    stale: where.spot.stale,
    elapsedMs: Date.now() - t0,
  };
}

/** How many references the language server finds (null when it cannot say). */
export async function readerReferences(at: DiffPosition, ctx: ReaderContext): Promise<number | null> {
  const where = await resolvePosition(at, ctx);
  if (!where) return null;
  const refs = await vscode.commands
    .executeCommand<vscode.Location[]>("vscode.executeReferenceProvider", where.uri, where.position)
    .then(undefined, () => undefined);
  return refs ? refs.length : null;
}

/**
 * Where the definition is: in the guide (a changed file's side the reader
 * shows: the head for a definition found on the new side, the base for one
 * found on a removed line) or elsewhere (its own document, on its own side).
 */
export async function readerDefinition(at: DiffPosition, ctx: ReaderContext): Promise<{ uri: vscode.Uri; range: vscode.Range; inGuide: { path: string; side: "old" | "new" } | null } | null> {
  const where = await resolvePosition(at, ctx);
  if (!where) return null;
  const defs = await vscode.commands
    .executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", where.uri, where.position)
    .then(undefined, () => undefined);
  const loc = await realDefinition(defs);
  if (!loc) return null;
  return { uri: loc.uri, range: loc.range, inGuide: guideFileAt(readerPath(loc.uri, ctx), ctx) };
}
