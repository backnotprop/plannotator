import { cn } from "@/lib/utils";
import { PullRequestIcon } from "@plannotator/ui/components/PullRequestIcon";
import type { GitDashboardPR } from "../../../stores/git-dashboard-store";
import { formatRelativeTime } from "./use-git-dashboard";

const STATUS_COLORS: Record<string, string> = {
  open: "text-green-500",
  merged: "text-purple-500",
  closed: "text-red-500",
  draft: "text-muted-foreground/50",
};

const REVIEW_BADGES: Record<string, { label: string; className: string } | null> = {
  APPROVED: { label: "Approved", className: "bg-green-500/10 text-green-600 dark:text-green-400" },
  CHANGES_REQUESTED: {
    label: "Changes requested",
    className: "bg-red-500/10 text-red-600 dark:text-red-400",
  },
  REVIEW_REQUIRED: {
    label: "Review required",
    className: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  },
};

interface PRRowProps {
  pr: GitDashboardPR;
  loading?: boolean;
  onSelect: (pr: GitDashboardPR) => void;
}

export function PRRow({ pr, loading, onSelect }: PRRowProps) {
  const statusKey = pr.isDraft && pr.state === "open" ? "draft" : pr.state;
  const reviewBadge = pr.reviewDecision ? (REVIEW_BADGES[pr.reviewDecision] ?? null) : null;
  const repoName = pr.repoSlug.split("/")[1] ?? pr.repoSlug;

  return (
    <button
      type="button"
      onClick={() => onSelect(pr)}
      disabled={loading}
      className={cn(
        "group flex w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left transition-colors hover:bg-surface-1",
        loading && "opacity-60",
      )}
    >
      <PullRequestIcon className={cn("size-4 shrink-0", STATUS_COLORS[statusKey])} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{pr.title}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {repoName} <span className="text-muted-foreground/40">#{pr.number}</span>
          {" · "}@{pr.author}
          {pr.updatedAt && (
            <>
              {" · "}
              {formatRelativeTime(pr.updatedAt)}
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {reviewBadge && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              reviewBadge.className,
            )}
          >
            {reviewBadge.label}
          </span>
        )}
        {pr.platform === "gitlab" ? (
          // GitLab's MR-list endpoint omits per-MR additions/deletions, so render
          // an em dash ("unknown") rather than a misleading +0/-0.
          <span className="font-mono text-[10px] text-muted-foreground/50">—</span>
        ) : (
          <span className="flex items-center gap-1.5 font-mono text-[10px]">
            <span className="tabular-nums text-green-600 dark:text-green-400">+{pr.additions}</span>
            <span className="tabular-nums text-red-600 dark:text-red-400">-{pr.deletions}</span>
          </span>
        )}
        {pr.commentCount > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/60">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span className="tabular-nums">{pr.commentCount}</span>
          </span>
        )}
      </div>
    </button>
  );
}
