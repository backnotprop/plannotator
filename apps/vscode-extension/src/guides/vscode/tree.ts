/**
 * The Guides side bar (shots 1, 5, 9): the dashboard (this repo, recent
 * guides, PRs waiting on you), a "Building guide" section while an agent
 * works, and the open guide's chapters and files with their ticks.
 */

import * as vscode from "vscode";
import { basename, dirname } from "node:path";
import type { DashboardModel } from "../dashboard";
import type { GenerationState } from "../generation";
import type { ReaderModel } from "../reader-model";
import { isOpenRepository, parsePullRequestUrl, type PullRequestRow, type WaitingRow } from "../sources/github";
import type { RecentEntry } from "../store";
import { chapterColorId } from "./intel";

export type TreeNode =
  | { kind: "section"; id: "building" | "guide" | "repo" | "recent" | "waiting" }
  | { kind: "local" }
  | { kind: "prs" }
  | { kind: "pr"; pr: PullRequestRow }
  | { kind: "recent"; entry: RecentEntry }
  | { kind: "waiting"; row: WaitingRow }
  | { kind: "note"; id: string; text: string; icon: string; tooltip?: string }
  | { kind: "action"; id: "openFolder" | "prByLink" }
  | { kind: "gen"; id: string; row: "agent" | "draft" | "left" }
  | { kind: "guideTitle" }
  | { kind: "chapter"; index: number }
  | { kind: "file"; chapter: number; path: string }
  | { kind: "guideInfo" };

export interface TreeData {
  dashboard: DashboardModel | null;
  loading: boolean;
  generation: GenerationState | null;
  reader: ReaderModel | null;
  readerLabel: string;
  currentFile: string | null;
}

export function relativeTime(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  if (s < 7 * 86400) return new Date(at).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function getChildren(data: TreeData, node?: TreeNode): TreeNode[] {
  if (!node) {
    const out: TreeNode[] = [];
    if (data.generation && isLive(data.generation)) out.push({ kind: "section", id: "building" });
    if (data.reader) out.push({ kind: "section", id: "guide" });
    out.push({ kind: "section", id: "repo" }, { kind: "section", id: "recent" }, { kind: "section", id: "waiting" });
    return out;
  }
  const d = data.dashboard;
  switch (node.kind) {
    case "section":
      switch (node.id) {
        case "building": {
          const id = data.generation!.id;
          return [{ kind: "gen", id, row: "agent" }, { kind: "gen", id, row: "draft" }, ...(data.generation!.progress.remaining.length ? [{ kind: "gen", id, row: "left" } as TreeNode] : [])];
        }
        case "guide": {
          const r = data.reader!;
          const unplaced = r.unplaced.length;
          return [
            { kind: "guideTitle" },
            ...r.chapters.map((_, index) => ({ kind: "chapter", index }) as TreeNode),
            { kind: "guideInfo" },
            ...(unplaced ? [] : []),
          ];
        }
        case "repo": {
          if (data.loading && !d) return [{ kind: "note", id: "loading", text: "Loading…", icon: "loading~spin" }];
          if (!d?.repo) return [{ kind: "action", id: "openFolder" }, { kind: "action", id: "prByLink" }];
          const rows: TreeNode[] = [{ kind: "local" }];
          if (d.gh.state === "ok") rows.push({ kind: "prs" });
          else if (d.gh.state === "missing") rows.push({ kind: "note", id: "gh", text: "Pull requests need the GitHub CLI (gh)", icon: "info" });
          else if (d.gh.state === "signed-out") rows.push({ kind: "note", id: "gh", text: "Run `gh auth login` to list pull requests", icon: "info" });
          else if (d.gh.state === "error") rows.push({ kind: "note", id: "gh", text: "gh did not answer", icon: "warning", tooltip: d.gh.message });
          return rows;
        }
        case "recent":
          if (!d) return [];
          return d.recent.length ? d.recent.map((entry) => ({ kind: "recent", entry }) as TreeNode) : [{ kind: "note", id: "norecent", text: "No guides yet", icon: "book" }];
        case "waiting":
          if (!d) return [];
          if (d.gh.state !== "ok") return [];
          return d.waiting.length ? d.waiting.map((row) => ({ kind: "waiting", row }) as TreeNode) : [{ kind: "note", id: "nowaiting", text: "Nothing waits on your review", icon: "check" }];
      }
      return [];
    case "prs":
      return (d?.prs ?? []).map((pr) => ({ kind: "pr", pr }) as TreeNode);
    case "chapter":
      return (data.reader?.chapters[node.index]?.files ?? []).map((f) => ({ kind: "file", chapter: node.index, path: f.path }) as TreeNode);
    default:
      return [];
  }
}

export function getParent(data: TreeData, node: TreeNode): TreeNode | undefined {
  switch (node.kind) {
    case "file":
      return { kind: "chapter", index: node.chapter };
    case "chapter":
    case "guideTitle":
    case "guideInfo":
      return { kind: "section", id: "guide" };
    case "pr":
      return { kind: "prs" };
    case "local":
    case "prs":
    case "action":
      return { kind: "section", id: "repo" };
    case "recent":
      return { kind: "section", id: "recent" };
    case "waiting":
      return { kind: "section", id: "waiting" };
    case "gen":
      return { kind: "section", id: "building" };
    default:
      return undefined;
  }
}

function isLive(g: GenerationState): boolean {
  return g.status === "starting" || g.status === "running" || g.status === "finishing";
}

export function nodeId(node: TreeNode): string {
  switch (node.kind) {
    case "section":
      return `section:${node.id}`;
    case "pr":
      return `pr:${node.pr.number}`;
    case "recent":
      return `recent:${node.entry.kind}:${node.entry.id}`;
    case "waiting":
      return `waiting:${node.row.url}`;
    case "note":
      return `note:${node.id}`;
    case "action":
      return `action:${node.id}`;
    case "gen":
      return `gen:${node.row}`;
    case "chapter":
      return `chapter:${node.index}`;
    case "file":
      return `file:${node.path}`;
    default:
      return node.kind;
  }
}

export function getTreeItem(data: TreeData, node: TreeNode): vscode.TreeItem {
  const d = data.dashboard;
  const item = (label: string | vscode.TreeItemLabel, state = vscode.TreeItemCollapsibleState.None) => {
    const t = new vscode.TreeItem(label, state);
    t.id = nodeId(node);
    return t;
  };
  switch (node.kind) {
    case "section": {
      const E = vscode.TreeItemCollapsibleState.Expanded;
      const C = vscode.TreeItemCollapsibleState.Collapsed;
      const quiet = !!data.reader || (!!data.generation && isLive(data.generation));
      if (node.id === "building") {
        const g = data.generation!;
        const t = item(`BUILDING GUIDE · ${g.source.label}`, E);
        t.contextValue = "pn.building";
        return t;
      }
      if (node.id === "guide") {
        const r = data.reader!;
        const t = item(`GUIDE · ${data.readerLabel}`, E);
        t.description = `${r.reviewed.filter(Boolean).length}/${r.chapters.length} reviewed`;
        t.contextValue = "pn.guideSection";
        return t;
      }
      if (node.id === "repo") {
        const t = item((d?.repo?.displayName.split("/").pop() ?? "THIS REPO").toUpperCase(), quiet ? C : E);
        if (d?.repo) t.description = d.repo.branch;
        return t;
      }
      if (node.id === "recent") {
        const t = item("RECENT GUIDES", quiet ? C : E);
        if (d?.recent.length) t.description = String(d.recent.length);
        return t;
      }
      const t = item("WAITING ON YOU", quiet ? C : E);
      if (d?.waiting.length) t.description = String(d.waiting.length);
      return t;
    }
    case "local": {
      const l = d?.local;
      const t = item("Local changes");
      t.iconPath = new vscode.ThemeIcon("git-compare");
      t.description = l ? (l.files ? `since ${l.baseLabel} · ${l.files} ${l.files === 1 ? "file" : "files"} · +${l.additions} −${l.deletions}` : "no changes") : "";
      t.tooltip = "Guide everything since the merge base, uncommitted and untracked work included.";
      t.contextValue = "pn.local";
      t.command = { command: "plannotator.guides.guideLocal", title: "Guide local changes" };
      return t;
    }
    case "prs": {
      const t = item("Pull requests", vscode.TreeItemCollapsibleState.Expanded);
      t.iconPath = new vscode.ThemeIcon("git-pull-request");
      t.description = String(d?.prs.length ?? 0);
      return t;
    }
    case "pr": {
      const p = node.pr;
      const t = item(`#${p.number} ${p.title}`);
      t.iconPath = new vscode.ThemeIcon(p.isDraft ? "git-pull-request-draft" : "git-pull-request", new vscode.ThemeColor(p.isDraft ? "descriptionForeground" : "charts.green"));
      const tags = [p.isMine ? "you" : `@${p.author}`, p.reviewRequested ? "waiting on you" : "", p.isDraft ? "draft" : "", d?.currentBranchPR?.number === p.number ? "current" : ""].filter(Boolean);
      t.description = tags.join(" · ");
      t.tooltip = new vscode.MarkdownString(`**#${p.number} ${escapeMd(p.title)}**\n\n${p.baseRefName} ← ${p.headRefName} · ${p.changedFiles} files · +${p.additions} −${p.deletions}`);
      t.contextValue = "pn.pr";
      // Opens its guided review when one exists for the PR's head, else starts one. Never the browser.
      // A row of this repository's own PR list: always the open repository, so only its number is passed.
      t.command = { command: "plannotator.guides.openPullRequest", title: "Open the guided review", arguments: [p.number] };
      return t;
    }
    case "recent": {
      const e = node.entry;
      const t = item(e.title);
      if (e.kind === "draft") {
        t.iconPath = new vscode.ThemeIcon(e.draftInfo?.status === "failed" ? "warning" : "book", e.draftInfo?.status === "failed" ? new vscode.ThemeColor("editorWarning.foreground") : undefined);
        t.description = `Draft · ${e.draftInfo?.chapters ?? 0} chapters · ${e.draftInfo?.filesLeft ?? 0} files left`;
        t.contextValue = "pn.draft";
        t.command = { command: "plannotator.guides.showGeneration", title: "Show draft", arguments: [e.id] };
      } else {
        const done = e.progress && e.progress.total > 0 && e.progress.reviewed === e.progress.total;
        t.iconPath = e.moved ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("editorWarning.foreground")) : new vscode.ThemeIcon(done ? "pass" : "book", done ? new vscode.ThemeColor("testing.iconPassed") : undefined);
        t.description = [e.repoName && !d?.repo ? e.repoName : "", e.label, e.sessionOnly ? "not saved (this session only)" : e.moved ? "head moved" : e.progress ? `${e.progress.reviewed}/${e.progress.total}` : "", relativeTime(e.at)].filter(Boolean).join(" · ");
        t.contextValue = "pn.guide";
        t.command = { command: "plannotator.guides.openGuide", title: "Open guide", arguments: [e.id] };
      }
      return t;
    }
    case "waiting": {
      const w = node.row;
      const t = item(`#${w.number} ${w.title}`);
      t.iconPath = new vscode.ThemeIcon("git-pull-request", new vscode.ThemeColor("charts.yellow"));
      const ref = parsePullRequestUrl(w.url);
      const inRepo = !!ref && isOpenRepository(d?.repo, ref);
      t.description = `${w.repo} · @${w.author}`;
      t.contextValue = "pn.waiting";
      t.command = { command: "plannotator.guides.openPullRequest", title: "Open the guided review", arguments: [{ number: w.number, url: w.url }] };
      if (!inRepo) t.tooltip = `${w.repo}, not open here: Guided Reviews clones it into its own storage to guide this pull request.`;
      return t;
    }
    case "action": {
      const folder = node.id === "openFolder";
      const t = item(folder ? "Open a folder…" : "Guide a pull request by link…");
      t.iconPath = new vscode.ThemeIcon(folder ? "folder-opened" : "git-pull-request");
      t.description = folder ? "a git repository, to guide its changes" : "any GitHub PR";
      t.command = folder
        ? { command: "plannotator.guides.openFolder", title: "Open a folder" }
        : { command: "plannotator.guides.guidePullRequest", title: "Guide a pull request by link" };
      return t;
    }
    case "note": {
      const t = item(node.text);
      t.iconPath = new vscode.ThemeIcon(node.icon);
      if (node.tooltip) t.tooltip = node.tooltip;
      return t;
    }
    case "gen": {
      const g = data.generation!;
      if (node.row === "agent") {
        const t = item(g.agent.label);
        t.iconPath = new vscode.ThemeIcon("sparkle", new vscode.ThemeColor("charts.orange"));
        const elapsed = Math.round((Date.now() - g.startedAt) / 1000);
        t.description = [g.appliedModel ?? g.agent.model?.label, g.appliedEffort ?? g.agent.effort?.label, `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`, g.cost ? `$${g.cost.amount.toFixed(2)}` : ""].filter(Boolean).join(" · ");
        t.command = { command: "plannotator.guides.showGeneration", title: "Show", arguments: [g.id] };
        return t;
      }
      if (node.row === "draft") {
        const t = item(`Draft: ${g.progress.chapters} ${g.progress.chapters === 1 ? "chapter" : "chapters"}`);
        t.iconPath = new vscode.ThemeIcon("loading~spin");
        t.description = `${g.progress.placed} of ${g.progress.total} files placed`;
        t.command = { command: "plannotator.guides.showGeneration", title: "Show", arguments: [g.id] };
        return t;
      }
      const t = item(`Left: ${g.progress.remaining.slice(0, 2).join(", ")}${g.progress.remaining.length > 2 ? ` +${g.progress.remaining.length - 2}` : ""}`);
      t.iconPath = new vscode.ThemeIcon("circle-large-outline");
      return t;
    }
    case "guideTitle": {
      const r = data.reader!;
      const t = item(r.title);
      t.tooltip = r.title;
      t.command = { command: "plannotator.guides.openGuide", title: "Open the Guide tab", arguments: [r.id] };
      return t;
    }
    case "chapter": {
      const r = data.reader!;
      const ch = r.chapters[node.index];
      const current = r.currentChapter === node.index;
      const t = item(`${node.index + 1}. ${ch.title}`, current ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      t.iconPath = new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(chapterColorId(node.index)));
      t.description = `${ch.files.length} ${ch.files.length === 1 ? "file" : "files"}`;
      t.checkboxState = r.reviewed[node.index] ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      t.contextValue = "pn.chapter";
      t.command = { command: "plannotator.guides.openChapter", title: "Show the chapter in the Guide tab", arguments: [node.index + 1] };
      return t;
    }
    case "file": {
      const r = data.reader!;
      const f = r.files.get(node.path);
      const t = item(basename(node.path));
      t.resourceUri = vscode.Uri.file(`/${node.path}`);
      const dir = dirname(node.path);
      t.description = `${dir === "." ? "" : dir}${f ? `  +${f.additions} −${f.deletions}` : ""}`;
      t.checkboxState = r.fileTicks.has(node.path) ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      t.tooltip = r.chapters[node.chapter].files.find((x) => x.path === node.path)?.summary || node.path;
      t.contextValue = "pn.file";
      t.command = { command: "plannotator.guides.openFile", title: "Show the file in the Guide tab", arguments: [node.path] };
      if (data.currentFile === node.path) t.description = `${t.description} ●`;
      return t;
    }
    case "guideInfo": {
      const r = data.reader!;
      const total = r.files.size;
      const placed = r.orderedFiles().length;
      const t = item(r.unplaced.length ? `${r.unplaced.length} ${r.unplaced.length === 1 ? "file is" : "files are"} not in a chapter` : `All ${placed} changed files are in a chapter`);
      t.iconPath = new vscode.ThemeIcon("info");
      t.tooltip = r.unplaced.length ? r.unplaced.join("\n") : `${placed} of ${total} files`;
      return t;
    }
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
