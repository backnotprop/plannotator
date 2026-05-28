import type {
  DaemonEndpoint,
  DaemonEvent,
  DaemonProjectEntry,
  DaemonSessionBootstrapResponse,
  DaemonSessionStatus,
  DaemonSessionSummary,
  DaemonSessionView,
  DaemonStatus,
  DaemonWebSocketServerMessage,
} from "@plannotator/shared/daemon-protocol";

export type SessionView = DaemonSessionView;
export type SessionMode = SessionView | (string & {});

export interface SessionSummary extends Omit<DaemonSessionSummary, "mode"> {
  mode: SessionMode;
}

export interface DaemonStatusSnapshot extends Omit<DaemonStatus, "endpoint"> {
  endpoint: DaemonEndpoint;
}

export interface SessionBootstrap extends Omit<DaemonSessionBootstrapResponse, "session"> {
  session: SessionSummary;
}

export interface SessionListResponse {
  ok: true;
  sessions: SessionSummary[];
}

export interface SessionResponse {
  ok: true;
  session: SessionSummary;
}

export interface DeleteSessionResponse {
  ok: true;
}

export type ProjectEntry = DaemonProjectEntry;

export interface ProjectListResponse {
  ok: true;
  projects: ProjectEntry[];
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  lastActive: number;
}

export interface WorktreeListResponse {
  ok: true;
  worktrees: WorktreeEntry[];
}

export interface DirectoryEntry {
  name: string;
  path: string;
}

export interface DirectoryListResponse {
  ok: true;
  path: string;
  dirs: DirectoryEntry[];
}

export interface PRListItem {
  id: string;
  number: number;
  title: string;
  author: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
}

export interface PRDetailedListItem extends PRListItem {
  additions: number;
  deletions: number;
  commentCount: number;
  updatedAt: string;
  isDraft: boolean;
  reviewDecision: string;
}

export interface PRDetailedListResponse {
  ok: true;
  prs: PRDetailedListItem[];
  platform: "github" | "gitlab" | null;
  error?: "no-remote" | "no-cli" | "auth-failed" | "fetch-failed";
  message?: string;
}

export interface PRListResponse {
  ok: true;
  prs: PRListItem[];
  platform: "github" | "gitlab" | null;
  defaultBranch?: string;
  error?: "no-remote" | "no-cli" | "auth-failed" | "fetch-failed";
  message?: string;
}

export type SessionLifecycleStatus = DaemonSessionStatus;
export type DaemonServerMessage = DaemonWebSocketServerMessage;

export type DaemonLifecycleEvent =
  | (Omit<Extract<DaemonEvent, { type: "snapshot" }>, "sessions"> & {
      sessions: SessionSummary[];
    })
  | Extract<DaemonEvent, { type: "daemon-status" | "daemon-error" }>
  | Extract<DaemonEvent, { type: "debug-log" }>
  | (Omit<
      Extract<
        DaemonEvent,
        { type: "session-created" | "session-updated" | "session-removed" | "session-notify" }
      >,
      "session"
    > & {
      session: SessionSummary;
    });
