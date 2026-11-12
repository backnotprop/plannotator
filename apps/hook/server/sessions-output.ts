import type { SessionInfo } from "@plannotator/server/sessions";

function ageText(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 60000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatSessionsTable(sessions: readonly SessionInfo[], now: number = Date.now()): string {
  const lines = ["Active Plannotator sessions:", ""];
  sessions.forEach((session, index) => {
    const cells = [
      `#${index + 1}`.padEnd(4),
      session.mode.padEnd(10),
      (session.reviewId ?? "-").padEnd(10),
      session.project.padEnd(20),
      session.url.padEnd(28),
      `${ageText(session.startedAt, now)} ago`.padEnd(10),
      session.target ?? "-",
      session.host === "opencode" ? "(in OpenCode)" : "",
    ];
    lines.push(`  ${cells.join(" ")}`.trimEnd());
  });
  lines.push("", "Reopen with: plannotator sessions --open [N]");
  return lines.join("\n");
}

export function formatSessionsJson(sessions: readonly SessionInfo[]): string {
  return JSON.stringify(
    sessions.map((session, index) => ({
      index: index + 1,
      mode: session.mode,
      ...(session.reviewId ? { reviewId: session.reviewId } : {}),
      ...(session.target ? { target: session.target } : {}),
      url: session.url,
      port: session.port,
      pid: session.pid,
      project: session.project,
      label: session.label,
      startedAt: session.startedAt,
      ...(session.hostSession ? { hostSession: session.hostSession } : {}),
      ...(session.host ? { host: session.host } : {}),
    })),
  );
}
