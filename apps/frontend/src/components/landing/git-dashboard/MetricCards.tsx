import { cn } from "@/lib/utils";
import type { DashboardMetrics } from "./use-git-dashboard";

interface MetricCardProps {
  label: string;
  count: number;
  active?: boolean;
  onClick?: () => void;
}

function MetricCard({ label, count, active, onClick }: MetricCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors",
        active
          ? "bg-surface-1 font-medium text-foreground"
          : "text-muted-foreground hover:bg-surface-1 hover:text-foreground",
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

function scrollToGroup(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function MetricCards({ metrics }: { metrics: DashboardMetrics }) {
  return (
    <div className="hidden flex-col gap-1 xl:flex xl:sticky xl:top-0 xl:h-fit">
      <h2 className="mb-1 text-sm font-medium text-muted-foreground">Pull Requests</h2>
      <MetricCard
        label="Open"
        count={metrics.open}
        active
        onClick={() => scrollToGroup("pr-group-open")}
      />
      <MetricCard
        label="Draft"
        count={metrics.draft}
        onClick={() => scrollToGroup("pr-group-draft")}
      />
      <MetricCard
        label="Merged"
        count={metrics.merged}
        onClick={() => scrollToGroup("pr-group-merged")}
      />
    </div>
  );
}
