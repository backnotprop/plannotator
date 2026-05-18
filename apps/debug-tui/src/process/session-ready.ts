import type { PluginSessionInfo } from "@plannotator/shared/plugin-protocol";

const SESSION_READY_PREFIX = "PLANNOTATOR_SESSION_READY ";

export function parseSessionReadyLine(line: string): PluginSessionInfo | null {
  const index = line.indexOf(SESSION_READY_PREFIX);
  if (index === -1) return null;

  try {
    const value = JSON.parse(line.slice(index + SESSION_READY_PREFIX.length));
    if (!isSessionInfo(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function isSessionInfo(value: unknown): value is PluginSessionInfo {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<PluginSessionInfo>;
  return (
    (session.mode === "plan" ||
      session.mode === "review" ||
      session.mode === "annotate" ||
      session.mode === "archive") &&
    typeof session.url === "string" &&
    typeof session.port === "number" &&
    typeof session.isRemote === "boolean"
  );
}
