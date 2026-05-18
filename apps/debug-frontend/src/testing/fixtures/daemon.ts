import {
  PLANNOTATOR_DAEMON_SESSION_VIEWS,
  getDaemonCapabilities,
} from "@plannotator/shared/daemon-protocol";
import type {
  ShellDaemonStatus,
  ShellSessionBootstrap,
  ShellSessionListResponse,
  ShellSessionMode,
  ShellSessionSummary,
} from "../../daemon/contracts";

const now = "2026-05-17T12:00:00.000Z";

export const daemonCapabilities = getDaemonCapabilities();

export const daemonStatusFixture: ShellDaemonStatus = {
  ok: true,
  protocol: "plannotator-daemon",
  protocolVersion: 1,
  pid: 4242,
  endpoint: {
    hostname: "127.0.0.1",
    port: 19432,
    baseUrl: "http://127.0.0.1:19432",
    isRemote: false,
  },
  startedAt: now,
  activeSessionCount: 5,
  sessionCount: 5,
};

export function sessionSummary(mode: ShellSessionMode, index = 1): ShellSessionSummary {
  return {
    id: `${mode}-session-${index}`,
    mode,
    status: "active",
    url: `http://127.0.0.1:19432/s/${mode}-session-${index}`,
    project: mode === "archive" ? "Personal archive" : "plannotator",
    label: sessionLabel(mode),
    origin: index % 2 === 0 ? "opencode" : "claude-code",
    createdAt: now,
    updatedAt: now,
    expiresAt: "2026-05-21T12:00:00.000Z",
  };
}

function sessionLabel(mode: ShellSessionMode): string {
  switch (mode) {
    case "plan":
      return "Runtime frontend shell plan";
    case "review":
      return "PR #734 daemon runtime review";
    case "annotate":
      return "Annotate docs/runtime.md";
    case "archive":
      return "Plan decision archive";
    case "setup-goal":
      return "Setup goal interview";
    default:
      return `Unsupported ${mode}`;
  }
}

export const sessionListFixture: ShellSessionListResponse = {
  ok: true,
  sessions: [
    sessionSummary("plan", 1),
    sessionSummary("review", 2),
    sessionSummary("annotate", 3),
    sessionSummary("archive", 4),
    sessionSummary("setup-goal", 5),
  ],
};

export function sessionBootstrap(mode: ShellSessionMode, index = 1): ShellSessionBootstrap {
  const session = sessionSummary(mode, index);
  return {
    ok: true,
    session,
    apiBase: `/s/${session.id}/api`,
    capabilities: daemonCapabilities,
    supportedSessionViews: [...PLANNOTATOR_DAEMON_SESSION_VIEWS],
  };
}

export const sessionBootstraps = {
  plan: sessionBootstrap("plan", 1),
  review: sessionBootstrap("review", 2),
  annotate: sessionBootstrap("annotate", 3),
  archive: sessionBootstrap("archive", 4),
  "setup-goal": sessionBootstrap("setup-goal", 5),
  unsupported: sessionBootstrap("unknown-mode", 6),
} as const;

export const emptySessionListFixture: ShellSessionListResponse = {
  ok: true,
  sessions: [],
};
