/**
 * Documents for the two sides of a guide's diffs. The base side is always a
 * read-only virtual document from git; the head side is the real file when it
 * is on disk (local changes, a PR worktree), so the language server works on
 * it, and a virtual document otherwise.
 */

import * as vscode from "vscode";
import { join } from "node:path";
import { showFileAt } from "../sources/git";
import type { Runner } from "../sources/runner";
import type { ReaderSides } from "../reader-model";

export const GUIDE_SCHEME = "plannotator-guide";

interface VirtualQuery {
  root: string;
  rev: string | null;
}

function virtualUri(path: string, query: VirtualQuery): vscode.Uri {
  return vscode.Uri.from({ scheme: GUIDE_SCHEME, path: `/${path}`, query: JSON.stringify(query) });
}

/** The base side of a file: its old path at the base revision; empty for an added file. */
export function baseUri(sides: ReaderSides, file: { path: string; oldPath?: string; status: string }): vscode.Uri {
  const path = file.oldPath ?? file.path;
  return virtualUri(path, { root: sides.gitRoot, rev: file.status === "added" ? null : sides.baseRev });
}

/** The head side of a file: the real file, a revision, or empty for a deleted file. */
export function headUri(sides: ReaderSides, file: { path: string; status: string }): vscode.Uri {
  if (file.status === "deleted") return virtualUri(file.path, { root: sides.gitRoot, rev: null });
  if (sides.head.kind === "fs") return vscode.Uri.file(join(sides.head.root, file.path));
  return virtualUri(file.path, { root: sides.gitRoot, rev: sides.head.rev });
}

/** The repo-relative path a document shows, when it belongs to these sides' head. */
export function headPathOf(sides: ReaderSides, uri: vscode.Uri): string | null {
  if (uri.scheme === GUIDE_SCHEME) {
    try {
      const q = JSON.parse(uri.query) as VirtualQuery;
      if (q.root !== sides.gitRoot) return null;
      if (sides.head.kind === "rev" && q.rev !== sides.head.rev && q.rev !== null) return null;
      if (sides.head.kind === "fs" && q.rev !== null) return null;
    } catch {
      return null;
    }
    return uri.path.replace(/^\//, "");
  }
  if (uri.scheme === "file" && sides.head.kind === "fs") {
    const root = sides.head.root.replace(/[\\/]+$/, "");
    const fsPath = uri.fsPath;
    if (fsPath.startsWith(root + "/") || fsPath.startsWith(root + "\\")) return fsPath.slice(root.length + 1).split("\\").join("/");
  }
  return null;
}

/**
 * Which side of the guide a document belongs to, for any file of the
 * repository (not only the change's): the head (the file on disk, the head
 * revision) or the base revision, with the path it shows there. Null for a
 * document of neither.
 */
export function docSideOf(sides: ReaderSides, uri: vscode.Uri): { path: string; side: "head" | "base" } | null {
  if (uri.scheme === GUIDE_SCHEME) {
    try {
      const q = JSON.parse(uri.query) as VirtualQuery;
      if (q.root === sides.gitRoot && q.rev === sides.baseRev && !(sides.head.kind === "rev" && sides.head.rev === sides.baseRev)) {
        return { path: uri.path.replace(/^\//, ""), side: "base" };
      }
    } catch {
      return null;
    }
  }
  const head = headPathOf(sides, uri);
  return head ? { path: head, side: "head" } : null;
}

/**
 * Which side of a guide diff a document is, and the file it shows (the
 * file's path in the change; a renamed file's base side is its old path).
 */
export function guideSideOf(sides: ReaderSides, uri: vscode.Uri, files: ReadonlyMap<string, { path: string; oldPath?: string }>): { path: string; side: "head" | "base" } | null {
  const head = headPathOf(sides, uri);
  if (head) return { path: head, side: "head" };
  if (uri.scheme !== GUIDE_SCHEME) return null;
  try {
    const q = JSON.parse(uri.query) as VirtualQuery;
    if (q.root !== sides.gitRoot || q.rev !== sides.baseRev) return null;
  } catch {
    return null;
  }
  const shown = uri.path.replace(/^\//, "");
  if (files.has(shown)) return { path: shown, side: "base" };
  for (const f of files.values()) if (f.oldPath === shown) return { path: f.path, side: "base" };
  return null;
}

export class GuideContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly runner: Runner) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: VirtualQuery;
    try {
      q = JSON.parse(uri.query) as VirtualQuery;
    } catch {
      return "";
    }
    if (!q.rev) return "";
    return (await showFileAt(this.runner, q.root, q.rev, uri.path.replace(/^\//, ""))) ?? "";
  }
}
