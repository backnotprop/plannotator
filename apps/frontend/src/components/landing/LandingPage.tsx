import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Code2,
  Folder,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Trash2,
} from "lucide-react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PullRequestIcon } from "@plannotator/ui/components/PullRequestIcon";
import { ASCII_BANNER } from "./ascii-banner";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useProjectStore, projectStore } from "../../stores/project-store";
import { GitDashboard } from "./git-dashboard/GitDashboard";
import { useDaemonEventStore } from "../../daemon/events/event-store";
import { daemonApiClient } from "../../daemon/api/client";
import { getSessionModeMeta, formatSessionLabel } from "../../shared/session-meta";
import type {
  ProjectEntry,
  PRListItem,
  SessionSummary,
  WorktreeEntry,
} from "../../daemon/contracts";

interface LandingPageProps {
  onAddProject: () => void;
}

interface Selection {
  key: string;
  cwd: string;
  label: string;
  prUrl?: string;
}

function selectionKey(sel: Omit<Selection, "key">): string {
  return sel.prUrl ?? sel.cwd;
}

export function LandingPage({ onAddProject }: LandingPageProps) {
  const projects = useProjectStore((s) => s.projects);
  const sessions = useDaemonEventStore((s) => s.sessions);
  const [selections, setSelections] = useState<Map<string, Selection>>(new Map());
  useEffect(() => {
    const cwds = new Set(projects.map((p) => p.cwd));
    setSelections((prev) => {
      const next = new Map<string, Selection>();
      for (const [k, sel] of prev) {
        if (cwds.has(sel.cwd)) next.set(k, sel);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [projects]);
  const [loading, setLoading] = useState<string | null>(null);
  const [viewIndex, setViewIndex] = useState(() =>
    typeof window !== "undefined" && window.location.hash === "#dashboard" ? 1 : 0,
  );
  const navigate = useNavigate();

  const toggleSelection = useCallback((sel: Omit<Selection, "key">) => {
    setSelections((prev) => {
      const key = selectionKey(sel);
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, { ...sel, key });
      }
      return next;
    });
  }, []);

  const selectionCount = selections.size;

  const handleAction = useCallback(
    async (action: "review") => {
      if (selectionCount === 0) return;
      setLoading(action);
      const items = [...selections.values()];

      const results = await Promise.allSettled(
        items.map(async (sel) => {
          const result = await daemonApiClient.createReviewSession(sel.cwd, sel.prUrl);
          return { sel, result };
        }),
      );
      setLoading(null);

      let firstSessionId: string | null = null;
      let successCount = 0;
      const failures: { label: string; message: string }[] = [];

      for (const outcome of results) {
        if (outcome.status === "fulfilled" && outcome.value.result.ok) {
          successCount++;
          if (!firstSessionId) firstSessionId = outcome.value.result.data.session.id;
        } else {
          const label = outcome.status === "fulfilled" ? outcome.value.sel.label : "Unknown";
          const message =
            outcome.status === "fulfilled" && !outcome.value.result.ok
              ? outcome.value.result.error.message
              : outcome.status === "rejected"
                ? String(outcome.reason)
                : "Unknown error";
          failures.push({ label, message });
        }
      }

      if (firstSessionId) {
        setSelections(new Map());
        void navigate({ to: "/s/$sessionId", params: { sessionId: firstSessionId } });
        if (successCount > 1) {
          toast.success(`Launched ${successCount} sessions`);
        }
      }

      for (const fail of failures) {
        toast.error(fail.label, { description: fail.message });
      }
    },
    [selections, selectionCount, navigate],
  );

  return (
    <div className="isolate flex h-full flex-col bg-muted">
      <div className="flex-1 overflow-hidden p-2">
        <div className="relative h-full overflow-hidden rounded-xl bg-card shadow-[var(--card-shadow)]">
          <div className="absolute top-2 left-2 z-10">
            <SidebarTrigger />
          </div>
          <div
            className="flex h-full"
            style={{
              transform: `translateX(${-viewIndex * 100}%)`,
              transition: "transform 500ms cubic-bezier(0.4, 0, 0.2, 1)",
              willChange: "transform",
            }}
          >
            <div className="h-full w-full shrink-0">
              <main className="flex h-full items-center justify-center overflow-auto">
                <div className="w-full max-w-2xl px-6">
                  <pre
                    className="mb-8 select-none overflow-x-auto text-[5px] leading-[1.2] text-foreground/70 sm:text-[6px] md:text-[7px]"
                    aria-hidden="true"
                  >
                    {ASCII_BANNER}
                  </pre>

                  {projects.length === 0 && sessions.length === 0 ? (
                    <EmptyState onAddProject={onAddProject} />
                  ) : (
                    <div className="flex flex-col gap-8">
                      {projects.length > 0 && (
                        <div>
                          <div className="mb-2 flex items-center justify-between">
                            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                              Select project
                            </span>
                            <button
                              type="button"
                              onClick={onAddProject}
                              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-foreground/80 hover:bg-surface-1 hover:text-foreground"
                            >
                              <FolderPlus className="size-3.5" />
                              Add project
                            </button>
                          </div>
                          <ProjectTable
                            projects={projects}
                            selections={selections}
                            onToggle={toggleSelection}
                          />

                          <div className="mt-6">
                            <span className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                              Launch
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={selectionCount === 0 || loading === "review"}
                                onClick={() => handleAction("review")}
                                className={cn(
                                  "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-[12px] font-medium",
                                  "hover:bg-surface-1 active:scale-[0.97]",
                                  "disabled:pointer-events-none disabled:opacity-40",
                                )}
                              >
                                <Code2 className="size-3.5" />
                                {loading === "review"
                                  ? "Starting…"
                                  : selectionCount > 1
                                    ? `Code Review (${selectionCount})`
                                    : "Code Review"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setViewIndex(1)}
                                className="ml-auto text-[12px] text-muted-foreground hover:text-foreground"
                              >
                                Git Dashboard →
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {sessions.length > 0 && (
                        <div>
                          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                            Active sessions
                          </div>
                          <SessionList sessions={sessions} />
                        </div>
                      )}

                      {projects.length === 0 && (
                        <button
                          type="button"
                          onClick={onAddProject}
                          className="inline-flex items-center gap-1.5 text-[12px] text-foreground/80 hover:text-foreground"
                        >
                          <FolderPlus className="size-3.5" />
                          Add project to launch sessions
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </main>
            </div>
            <div className="h-full w-full shrink-0">
              <GitDashboard active={viewIndex === 1} onBack={() => setViewIndex(0)} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProjectTable({
  projects,
  selections,
  onToggle,
}: {
  projects: ProjectEntry[];
  selections: Map<string, Selection>;
  onToggle: (sel: Omit<Selection, "key">) => void;
}) {
  const topLevel = projects.filter((p) => !p.parentCwd);
  const worktreeChildren = (parentCwd: string) => projects.filter((p) => p.parentCwd === parentCwd);

  return (
    <div className="max-h-96 overflow-y-auto rounded-lg border border-border">
      {topLevel.map((project, i) => {
        const children = worktreeChildren(project.cwd);
        return (
          <ProjectNode
            key={project.cwd}
            project={project}
            children={children}
            isFirst={i === 0}
            selections={selections}
            onToggle={onToggle}
          />
        );
      })}
    </div>
  );
}

function ProjectNode({
  project,
  children,
  isFirst,
  selections,
  onToggle,
}: {
  project: ProjectEntry;
  children: ProjectEntry[];
  isFirst: boolean;
  selections: Map<string, Selection>;
  onToggle: (sel: Omit<Selection, "key">) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [worktrees, setWorktrees] = useState<WorktreeEntry[]>([]);
  const [worktreesFetched, setWorktreesFetched] = useState(false);
  const [prs, setPrs] = useState<PRListItem[]>([]);
  const [prPlatform, setPrPlatform] = useState<string | null>(null);
  const [prDefaultBranch, setPrDefaultBranch] = useState("main");
  const [prError, setPrError] = useState<string | null>(null);
  const [prsLoading, setPrsLoading] = useState(false);
  const [prsFetchedAt, setPrsFetchedAt] = useState(0);
  const hasChildren = children.length > 0;

  useEffect(() => {
    if (!expanded || worktreesFetched) return;
    setWorktreesFetched(true);
    daemonApiClient.listWorktrees(project.cwd).then((result) => {
      if (result.ok) {
        setWorktrees(result.data.worktrees.filter((wt) => wt.path !== project.cwd));
      }
    });
  }, [expanded, project.cwd, worktreesFetched]);

  useEffect(() => {
    if (!expanded) return;
    const stale = !prsFetchedAt || Date.now() - prsFetchedAt > 30_000;
    if (!stale || prsLoading) return;
    setPrsLoading(true);
    daemonApiClient.listPRs(project.cwd).then((result) => {
      if (result.ok) {
        setPrs(result.data.prs);
        setPrPlatform(result.data.platform);
        if (result.data.defaultBranch) setPrDefaultBranch(result.data.defaultBranch);
        setPrError(result.data.error ?? null);
      }
      setPrsLoading(false);
      setPrsFetchedAt(Date.now());
    });
  }, [expanded, project.cwd, prsFetchedAt, prsLoading]);

  const hasWorktrees = hasChildren || worktrees.length > 0;
  const isSelected = selections.has(project.cwd);

  const handleRemove = useCallback(async () => {
    const ok = window.confirm(
      `Remove "${project.name}"?\n\nThis will cancel active sessions and delete plan history for this project.`,
    );
    if (!ok) return;
    const removed = await projectStore.getState().removeProject(project.cwd, true);
    if (removed) {
      toast.success(`Removed ${project.name}`);
    } else {
      toast.error(`Failed to remove ${project.name}`);
    }
  }, [project.name, project.cwd]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div>
          <div
            className={cn(
              "flex w-full items-center gap-3 px-3 py-2 text-[13px]",
              !isFirst && "border-t border-border",
              isSelected ? "bg-primary/10 text-foreground" : "text-foreground hover:bg-surface-1",
            )}
          >
            <button
              type="button"
              onClick={() => onToggle({ cwd: project.cwd, label: project.name })}
              className="flex flex-1 items-center gap-3 text-left"
            >
              <Folder className="size-3.5 shrink-0" />
              <span className="font-medium">{project.name}</span>
              {project.branch && (
                <span className="text-[11px] text-muted-foreground">{project.branch}</span>
              )}
              <span className="ml-auto truncate text-[11px] text-muted-foreground">
                {project.cwd}
              </span>
            </button>
            <button
              type="button"
              aria-label={expanded ? "Collapse" : "Expand"}
              onClick={() => setExpanded((prev) => !prev)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          </div>

          {expanded && (
            <div className="border-t border-border bg-muted/50 px-3 py-2 pl-9">
              <Tabs defaultValue="prs">
                <TabsList className="mb-1.5 gap-1">
                  <TabsTrigger value="prs" className="px-2 py-0.5 text-[11px]">
                    PRs
                  </TabsTrigger>
                  <TabsTrigger value="worktrees" className="px-2 py-0.5 text-[11px]">
                    Worktrees
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="prs">
                  <PRList
                    prs={prs}
                    loading={prsLoading}
                    error={prError}
                    platform={prPlatform}
                    defaultBranch={prDefaultBranch}
                    projectCwd={project.cwd}
                    projectName={project.name}
                    selections={selections}
                    onToggle={onToggle}
                  />
                </TabsContent>
                <TabsContent value="worktrees">
                  <WorktreeList
                    children={children}
                    worktrees={worktrees}
                    hasWorktrees={hasWorktrees}
                    projectName={project.name}
                    selections={selections}
                    onToggle={onToggle}
                  />
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[160px] overflow-hidden rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-lg">
          <ContextMenu.Item
            onSelect={handleRemove}
            className="mx-1 flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-destructive outline-none data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Remove project
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

interface PRStack {
  prs: PRListItem[];
  label: string;
}

function buildStacks(
  prs: PRListItem[],
  defaultBranch: string,
): { stacks: PRStack[]; loose: PRListItem[] } {
  const byHead = new Map<string, PRListItem>();
  for (const pr of prs) byHead.set(pr.headBranch, pr);

  const stacked = new Set<string>();
  const chains: PRListItem[][] = [];

  for (const pr of prs) {
    if (stacked.has(pr.id)) continue;
    if (pr.baseBranch === defaultBranch) continue;

    const chain: PRListItem[] = [];
    let current: PRListItem | undefined = pr;
    while (current && !stacked.has(current.id)) {
      chain.unshift(current);
      stacked.add(current.id);
      current = byHead.get(current.baseBranch);
    }
    if (chain.length > 1) {
      chains.push(chain);
    } else {
      stacked.delete(pr.id);
    }
  }

  const stacks = chains.map((chain) => ({
    prs: chain,
    label: `#${chain[0].number} → #${chain[chain.length - 1].number}`,
  }));
  const loose = prs.filter((pr) => !stacked.has(pr.id));
  return { stacks, loose };
}

function PRRow({
  pr,
  projectCwd,
  projectName,
  selections,
  onToggle,
}: {
  pr: PRListItem;
  projectCwd: string;
  projectName: string;
  selections: Map<string, Selection>;
  onToggle: (sel: Omit<Selection, "key">) => void;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        onToggle({ cwd: projectCwd, label: `${projectName} / #${pr.number}`, prUrl: pr.url })
      }
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 py-1 text-left text-[11px]",
        selections.has(pr.url)
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border bg-background text-foreground/80 hover:border-foreground/20 hover:text-foreground",
      )}
    >
      <PullRequestIcon
        className={cn(
          "size-3.5 shrink-0",
          pr.state === "open" && "text-green-500",
          pr.state === "merged" && "text-purple-500",
          pr.state === "closed" && "text-muted-foreground",
        )}
      />
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">#{pr.number}</span>
      <span className="truncate">{pr.title}</span>
      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">@{pr.author}</span>
    </button>
  );
}

function StackIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 500 400"
      fill="none"
      stroke="currentColor"
      strokeWidth={28}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <polygon points="250,30 470,160 250,290 30,160" />
      <polyline points="30,220 250,350 470,220" />
      <polyline points="30,280 250,410 470,280" />
    </svg>
  );
}

function StackGroup({
  stack,
  projectCwd,
  projectName,
  selections,
  onToggle,
}: {
  stack: PRStack;
  projectCwd: string;
  projectName: string;
  selections: Map<string, Selection>;
  onToggle: (sel: Omit<Selection, "key">) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-border bg-background">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] text-foreground/80 hover:text-foreground"
      >
        <StackIcon className="size-3.5 shrink-0 text-accent" />
        <span className="font-mono text-[10px] text-muted-foreground">{stack.label}</span>
        <span className="text-[10px] text-muted-foreground">({stack.prs.length} PRs)</span>
      </button>
      {expanded && (
        <div className="flex flex-col gap-1 px-1 pb-1">
          {stack.prs.map((pr) => (
            <PRRow
              key={pr.id}
              pr={pr}
              projectCwd={projectCwd}
              projectName={projectName}
              selections={selections}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PRList({
  prs,
  loading,
  error,
  platform,
  defaultBranch,
  projectCwd,
  projectName,
  selections,
  onToggle,
}: {
  prs: PRListItem[];
  loading: boolean;
  error: string | null;
  platform: string | null;
  defaultBranch: string;
  projectCwd: string;
  projectName: string;
  selections: Map<string, Selection>;
  onToggle: (sel: Omit<Selection, "key">) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = useMemo(
    () => (showAll ? prs : prs.filter((pr) => pr.state === "open")),
    [prs, showAll],
  );
  const hiddenCount = prs.length - visible.length;
  const { stacks, loose } = useMemo(
    () => buildStacks(visible, defaultBranch),
    [visible, defaultBranch],
  );

  if (loading) {
    return <div className="py-1 text-[11px] text-muted-foreground">Loading PRs…</div>;
  }
  if (error === "no-remote") {
    return <div className="py-1 text-[11px] text-muted-foreground">No git remote detected</div>;
  }
  if (error === "no-cli") {
    return (
      <div className="py-1 text-[11px] text-muted-foreground">
        {platform === "gitlab" ? "GitLab CLI (glab)" : "GitHub CLI (gh)"} not installed
      </div>
    );
  }
  if (error === "auth-failed") {
    return (
      <div className="py-1 text-[11px] text-muted-foreground">
        {platform === "gitlab" ? "glab" : "gh"} not authenticated — run{" "}
        <code className="rounded bg-muted px-1 text-[10px]">
          {platform === "gitlab" ? "glab" : "gh"} auth login
        </code>
      </div>
    );
  }
  if (error === "fetch-failed") {
    return (
      <div className="py-1 text-[11px] text-muted-foreground">
        Failed to load {platform === "gitlab" ? "merge requests" : "pull requests"}
      </div>
    );
  }
  if (visible.length === 0 && !showAll) {
    return (
      <div className="py-1 text-[11px] text-muted-foreground">
        No open pull requests
        {hiddenCount > 0 && (
          <>
            {" · "}
            <button
              type="button"
              onClick={() => setShowAll(true)}
              className="underline hover:text-foreground"
            >
              show {hiddenCount} closed/merged
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {stacks.map((stack) => (
        <StackGroup
          key={stack.label}
          stack={stack}
          projectCwd={projectCwd}
          projectName={projectName}
          selections={selections}
          onToggle={onToggle}
        />
      ))}
      {loose.map((pr) => (
        <PRRow
          key={pr.id}
          pr={pr}
          projectCwd={projectCwd}
          projectName={projectName}
          selections={selections}
          onToggle={onToggle}
        />
      ))}
      {!showAll && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="py-0.5 text-left text-[10px] text-muted-foreground hover:text-foreground"
        >
          Show {hiddenCount} closed/merged
        </button>
      )}
    </div>
  );
}

function WorktreeList({
  children,
  worktrees,
  hasWorktrees,
  projectName,
  selections,
  onToggle,
}: {
  children: ProjectEntry[];
  worktrees: WorktreeEntry[];
  hasWorktrees: boolean;
  projectName: string;
  selections: Map<string, Selection>;
  onToggle: (sel: Omit<Selection, "key">) => void;
}) {
  if (!hasWorktrees) {
    return <div className="py-1 text-[11px] text-muted-foreground">No worktrees</div>;
  }

  const allWorktrees: { path: string; branch: string }[] = [];
  for (const child of children) {
    allWorktrees.push({ path: child.cwd, branch: child.branch ?? child.name });
  }
  for (const wt of worktrees) {
    if (!children.some((c) => c.cwd === wt.path)) {
      allWorktrees.push({ path: wt.path, branch: wt.branch ?? "detached" });
    }
  }

  return (
    <div className="flex flex-col gap-1">
      {allWorktrees.map((wt) => (
        <button
          key={wt.path}
          type="button"
          onClick={() => onToggle({ cwd: wt.path, label: `${projectName} / ${wt.branch}` })}
          className={cn(
            "flex items-center gap-2 rounded-md border px-2 py-1 text-left text-[11px]",
            selections.has(wt.path)
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border bg-background text-foreground/80 hover:border-foreground/20 hover:text-foreground",
          )}
        >
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{wt.branch}</span>
          <span className="ml-auto shrink-0 truncate text-[10px] text-muted-foreground">
            {wt.path}
          </span>
        </button>
      ))}
    </div>
  );
}

function SessionList({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {sessions.map((session, i) => {
        const meta = getSessionModeMeta(session.mode);
        const Icon = meta.icon;
        return (
          <Link
            key={session.id}
            to="/s/$sessionId"
            params={{ sessionId: session.id }}
            className={cn(
              "flex w-full items-center gap-3 px-3 py-2 text-left text-[13px]",
              i > 0 && "border-t border-border",
              "text-foreground hover:bg-surface-1",
            )}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground/50" />
            <span className="text-muted-foreground">
              {formatSessionLabel(session.label, session.mode)}
            </span>
            <span className="ml-auto text-[11px] text-muted-foreground/50">{meta.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

function EmptyState({ onAddProject }: { onAddProject: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <h2 className="text-lg font-semibold">No projects yet</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Projects appear automatically when an agent creates a session, or you can add one manually.
      </p>
      <button
        type="button"
        onClick={onAddProject}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
      >
        <FolderPlus className="size-4" />
        Add project
      </button>
    </div>
  );
}
