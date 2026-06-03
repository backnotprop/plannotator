/**
 * PlanContextBrowser — code-file mentions extracted from the current plan.
 *
 * This is an orientation map, not authoritative change metadata. Status badges
 * are best-effort hints from explicit plan headings such as "Modified files".
 */

import React, { useEffect, useMemo, useState } from "react";
import type { PlanContextFile, PlanContextStatus } from "../../utils/planContext";
import { CountBadge } from "./CountBadge";

interface PlanContextBrowserProps {
  files: PlanContextFile[];
  onNavigate: (blockId: string) => void;
}

interface ContextTreeNode {
  type: "folder" | "file";
  name: string;
  path: string;
  mentionCount: number;
  children?: ContextTreeNode[];
  file?: PlanContextFile;
}

interface MutableContextFolder {
  children: Map<string, MutableContextFolder | PlanContextFile>;
}

const STATUS_LABEL: Record<PlanContextStatus, string> = {
  mentioned: "Mentioned",
  modified: "Modified",
  created: "Created",
  deleted: "Deleted",
};

const STATUS_CLASS: Record<PlanContextStatus, string> = {
  mentioned: "border-border/70 bg-muted/60 text-muted-foreground",
  modified: "border-warning/35 bg-warning/10 text-warning",
  created: "border-success/35 bg-success/10 text-success",
  deleted: "border-destructive/35 bg-destructive/10 text-destructive",
};

function buildContextTree(files: PlanContextFile[]): ContextTreeNode[] {
  const root: MutableContextFolder = { children: new Map() };

  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let current = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = current.children.get(segment);
      if (existing && !(existing as PlanContextFile).firstBlockId) {
        current = existing as MutableContextFolder;
      } else {
        const next: MutableContextFolder = { children: new Map() };
        current.children.set(segment, next);
        current = next;
      }
    }

    current.children.set(segments[segments.length - 1], file);
  }

  return folderToNodes(root, "");
}

function folderToNodes(folder: MutableContextFolder, parentPath: string): ContextTreeNode[] {
  const folders: ContextTreeNode[] = [];
  const fileNodes: ContextTreeNode[] = [];

  for (const [name, value] of folder.children) {
    const path = parentPath ? `${parentPath}/${name}` : name;
    if ((value as PlanContextFile).firstBlockId) {
      const file = value as PlanContextFile;
      fileNodes.push({
        type: "file",
        name,
        path: file.path,
        mentionCount: file.mentionCount,
        file,
      });
      continue;
    }

    const children = folderToNodes(value as MutableContextFolder, path);
    folders.push({
      type: "folder",
      name,
      path,
      children,
      mentionCount: children.reduce((sum, child) => sum + child.mentionCount, 0),
    });
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  fileNodes.sort((a, b) => a.name.localeCompare(b.name));
  return [...folders, ...fileNodes];
}

function getFolderPaths(nodes: ContextTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    paths.push(node.path);
    if (node.children) paths.push(...getFolderPaths(node.children));
  }
  return paths;
}

export const PlanContextBrowser: React.FC<PlanContextBrowserProps> = ({
  files,
  onNavigate,
}) => {
  const tree = useMemo(() => buildContextTree(files), [files]);
  const folderPaths = useMemo(() => getFolderPaths(tree), [tree]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(folderPaths));

  useEffect(() => {
    setExpandedFolders(new Set(folderPaths));
  }, [folderPaths]);

  const totalMentions = files.reduce((sum, file) => sum + file.mentionCount, 0);
  const unresolvedCount = files.filter((file) => file.validationStatus === "missing").length;

  if (files.length === 0) {
    return (
      <div className="p-3 text-[11px] text-muted-foreground">
        No code-file references found in this plan.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 py-2 border-b border-border/30">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Plan Context
            </h2>
            <p className="mt-0.5 text-[11px] text-foreground/70">
              {files.length} file{files.length === 1 ? "" : "s"} · {totalMentions} mention{totalMentions === 1 ? "" : "s"}
            </p>
          </div>
          {unresolvedCount > 0 && (
            <span className="rounded border border-border/60 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {unresolvedCount} unresolved
            </span>
          )}
        </div>
      </div>
      <div className="px-1 py-1">
        {tree.map((node) => (
          <ContextNode
            key={node.type === "file" ? node.path : `folder:${node.path}`}
            node={node}
            depth={0}
            expandedFolders={expandedFolders}
            onToggleFolder={(path) => {
              setExpandedFolders((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </div>
  );
};

const ContextNode: React.FC<{
  node: ContextTreeNode;
  depth: number;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onNavigate: (blockId: string) => void;
}> = ({ node, depth, expandedFolders, onToggleFolder, onNavigate }) => {
  const paddingLeft = 8 + depth * 12;

  if (node.type === "folder") {
    const isExpanded = expandedFolders.has(node.path);
    return (
      <>
        <button
          type="button"
          onClick={() => onToggleFolder(node.path)}
          className="w-full flex items-center gap-1.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-sm"
          style={{ paddingLeft }}
          title={node.path}
        >
          <svg
            className={`w-3 h-3 flex-shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <svg className="w-3 h-3 flex-shrink-0 text-muted-foreground/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="truncate">{node.name}</span>
          <CountBadge count={node.mentionCount} className="ml-auto" />
        </button>
        {isExpanded && node.children?.map((child) => (
          <ContextNode
            key={child.type === "file" ? child.path : `folder:${child.path}`}
            node={child}
            depth={depth + 1}
            expandedFolders={expandedFolders}
            onToggleFolder={onToggleFolder}
            onNavigate={onNavigate}
          />
        ))}
      </>
    );
  }

  const file = node.file!;
  const isMissing = file.validationStatus === "missing";
  const statusTitle = `${STATUS_LABEL[file.status]}${file.sectionTitle ? ` in ${file.sectionTitle}` : ""}`;

  return (
    <button
      type="button"
      onClick={() => onNavigate(file.firstBlockId)}
      className={`w-full flex items-center gap-1.5 py-1 text-[11px] transition-colors rounded-sm ${
        isMissing
          ? "text-muted-foreground/55 hover:text-muted-foreground hover:bg-muted/30"
          : "text-foreground/85 hover:text-foreground hover:bg-muted/50"
      }`}
      style={{ paddingLeft: paddingLeft + 15 }}
      title={`${file.path}${isMissing ? " (not found in repo)" : ""}`}
    >
      <svg className="w-3 h-3 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      <span className="min-w-0 flex-1 truncate text-left">{node.name}</span>
      <span
        className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium leading-none ${STATUS_CLASS[file.status]}`}
        title={statusTitle}
      >
        {STATUS_LABEL[file.status]}
      </span>
      <CountBadge count={file.mentionCount} />
    </button>
  );
};
