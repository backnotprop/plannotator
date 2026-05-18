import type { ShellSessionMode } from "./types";

export type SessionApiGroupStatus = "ready" | "planned";

export interface SessionApiEndpoint {
  method: string;
  path: string;
}

export interface SessionApiGroup {
  id: string;
  title: string;
  status: SessionApiGroupStatus;
  reason?: string;
  endpoints: SessionApiEndpoint[];
}

export const sessionApiGroups: Record<string, SessionApiGroup[]> = {
  plan: [
    endpointGroup("plan-bootstrap", "Plan bootstrap and decision", [
      ["GET", "/api/plan"],
      ["POST", "/api/approve"],
      ["POST", "/api/deny"],
    ]),
    endpointGroup("plan-history", "Plan version history and diff", [
      ["GET", "/api/plan/version"],
      ["GET", "/api/plan/versions"],
      ["POST", "/api/plan/vscode-diff"],
    ]),
    endpointGroup("plan-archive-sidebar", "Archive browsing from plan mode", [
      ["GET", "/api/archive/plans"],
      ["GET", "/api/archive/plan"],
    ]),
  ],
  review: [
    endpointGroup("review-diff", "Diff bootstrap and switching", [
      ["GET", "/api/diff"],
      ["POST", "/api/diff/switch"],
      ["GET", "/api/file-content"],
    ]),
    endpointGroup("review-pr", "Pull request controls", [
      ["GET", "/api/pr-list"],
      ["POST", "/api/pr-switch"],
      ["POST", "/api/pr-diff-scope"],
      ["GET", "/api/pr-context"],
      ["POST", "/api/pr-action"],
      ["POST", "/api/pr-viewed"],
    ]),
    endpointGroup("review-ai", "AI sessions and permissions", [
      ["GET", "/api/ai/capabilities"],
      ["POST", "/api/ai/session"],
      ["POST", "/api/ai/query"],
      ["POST", "/api/ai/abort"],
      ["POST", "/api/ai/permission"],
      ["GET", "/api/ai/sessions"],
    ]),
    endpointGroup("review-code-nav", "Code navigation and staging", [
      ["POST", "/api/code-nav/resolve"],
      ["GET", "/api/code-nav/file"],
      ["POST", "/api/git-add"],
    ]),
    endpointGroup("review-tour", "Code tour result state", [
      ["GET", "/api/tour/:jobId"],
      ["PUT", "/api/tour/:jobId/checklist"],
    ]),
    endpointGroup("review-submit", "Review feedback and exit", [
      ["POST", "/api/feedback"],
      ["POST", "/api/exit"],
    ]),
  ],
  annotate: [
    endpointGroup("annotate-bootstrap", "Annotate content bootstrap", [
      ["GET", "/api/plan"],
      ["POST", "/api/feedback"],
      ["POST", "/api/approve"],
      ["POST", "/api/exit"],
    ]),
    endpointGroup("annotate-source", "Linked source browsing", [
      ["GET", "/api/doc"],
      ["POST", "/api/doc/exists"],
      ["GET", "/api/reference/files"],
    ]),
  ],
  archive: [
    endpointGroup("archive-bootstrap", "Archive browse and close", [
      ["GET", "/api/plan"],
      ["GET", "/api/archive/plans"],
      ["GET", "/api/archive/plan"],
      ["POST", "/api/done"],
    ]),
  ],
  "setup-goal": [
    {
      id: "setup-goal-contract",
      title: "Setup-goal backend contract",
      status: "planned",
      reason: "The current source checkout does not expose setup-goal daemon endpoints yet.",
      endpoints: [],
    },
  ],
  shared: [
    endpointGroup("external-annotations", "External annotation stream and CRUD", [
      ["GET", "/api/external-annotations/stream"],
      ["GET", "/api/external-annotations"],
      ["POST", "/api/external-annotations"],
      ["PATCH", "/api/external-annotations"],
      ["DELETE", "/api/external-annotations"],
    ]),
    endpointGroup("editor-annotations", "VS Code editor annotation bridge", [
      ["GET", "/api/editor-annotations"],
      ["POST", "/api/editor-annotation"],
      ["DELETE", "/api/editor-annotation"],
    ]),
    endpointGroup("agents", "Agent list and background jobs", [
      ["GET", "/api/agents"],
      ["GET", "/api/agents/capabilities"],
      ["GET", "/api/agents/jobs/stream"],
      ["GET", "/api/agents/jobs"],
      ["POST", "/api/agents/jobs"],
      ["DELETE", "/api/agents/jobs"],
      ["DELETE", "/api/agents/jobs/:id"],
    ]),
    endpointGroup("files", "Images, uploads, docs, config, and drafts", [
      ["GET", "/api/image"],
      ["POST", "/api/upload"],
      ["GET", "/api/doc"],
      ["POST", "/api/doc/exists"],
      ["POST", "/api/config"],
      ["GET", "/api/draft"],
      ["POST", "/api/draft"],
      ["DELETE", "/api/draft"],
    ]),
    endpointGroup("notes", "Notes and reference integrations", [
      ["POST", "/api/save-notes"],
      ["GET", "/api/obsidian/vaults"],
      ["GET", "/api/reference/obsidian/files"],
      ["GET", "/api/reference/obsidian/doc"],
    ]),
  ],
};

export function apiGroupsForMode(mode: ShellSessionMode): SessionApiGroup[] {
  return sessionApiGroups[mode] ?? [];
}

export function sharedApiGroups(): SessionApiGroup[] {
  return sessionApiGroups.shared;
}

function endpointGroup(
  id: string,
  title: string,
  endpoints: Array<[method: string, path: string]>,
): SessionApiGroup {
  return {
    id,
    title,
    status: "ready",
    endpoints: endpoints.map(([method, path]) => ({ method, path })),
  };
}
