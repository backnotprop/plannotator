import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { GitPullRequest, GitMerge, FileEdit } from "lucide-react";
import { toast } from "sonner";
import { daemonApiClient } from "../../../daemon/api/client";
import type { GitDashboardPR } from "../../../stores/git-dashboard-store";
import { useGitDashboard } from "./use-git-dashboard";
import { MetricCards } from "./MetricCards";
import { PRGroup } from "./PRGroup";
import { PRRow } from "./PRRow";

interface GitDashboardProps {
  active: boolean;
  onBack: () => void;
}

export function GitDashboard({ active, onBack }: GitDashboardProps) {
  const { groups, metrics, loading, error, isEmpty } = useGitDashboard(active);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleSelect = useCallback(
    async (pr: GitDashboardPR) => {
      setLaunchingId(pr.url);
      const result = await daemonApiClient.createReviewSession(pr.projectCwd, pr.url);
      setLaunchingId(null);
      if (result.ok) {
        void navigate({ to: "/s/$sessionId", params: { sessionId: result.data.session.id } });
      } else {
        toast.error("Failed to start review", { description: result.error.message });
      }
    },
    [navigate],
  );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-10 md:py-14">
        <div className="mb-8">
          <button
            type="button"
            onClick={onBack}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            ← Back
          </button>
        </div>

        {loading && isEmpty && (
          <div className="py-20 text-center text-sm text-muted-foreground">Loading PRs…</div>
        )}

        {!loading && isEmpty && (
          <div className="py-20 text-center text-sm text-muted-foreground">
            {error ?? "No pull requests found across your projects"}
          </div>
        )}

        {!isEmpty && (
          <section>
            <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(13rem,16rem)]">
              <div>
                {groups.open.length > 0 && (
                  <PRGroup
                    id="pr-group-open"
                    title="Open"
                    icon={GitPullRequest}
                    count={groups.open.length}
                  >
                    {groups.open.map((pr) => (
                      <PRRow
                        key={pr.url}
                        pr={pr}
                        loading={launchingId === pr.url}
                        onSelect={handleSelect}
                      />
                    ))}
                  </PRGroup>
                )}
                {groups.draft.length > 0 && (
                  <PRGroup
                    id="pr-group-draft"
                    title="Draft"
                    icon={FileEdit}
                    count={groups.draft.length}
                  >
                    {groups.draft.map((pr) => (
                      <PRRow
                        key={pr.url}
                        pr={pr}
                        loading={launchingId === pr.url}
                        onSelect={handleSelect}
                      />
                    ))}
                  </PRGroup>
                )}
                {groups.merged.length > 0 && (
                  <PRGroup
                    id="pr-group-merged"
                    title="Recently merged"
                    icon={GitMerge}
                    count={groups.merged.length}
                  >
                    {groups.merged.map((pr) => (
                      <PRRow
                        key={pr.url}
                        pr={pr}
                        loading={launchingId === pr.url}
                        onSelect={handleSelect}
                      />
                    ))}
                  </PRGroup>
                )}
              </div>
              <MetricCards metrics={metrics} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
