import {
  registerSession,
  unregisterSession,
  type SessionInfo,
} from "@plannotator/server/sessions";
import { detectProjectName } from "@plannotator/server/project";

export type EmbeddedSessionMode = Extract<
  SessionInfo["mode"],
  "plan" | "review" | "annotate"
>;

/**
 * Register an embedded (in-process) session so `plannotator sessions` and other
 * discovery tools can find it.
 *
 * The embedded OpenCode runtime hosts several concurrent sessions inside the
 * single OpenCode process, so each session is keyed by `<pid>-<port>` instead of
 * the pid alone (see SessionInfo.id). Returns the registry key to pass to
 * unregisterEmbeddedSession().
 */
export async function registerEmbeddedSession(
  server: { port: number; url: string },
  mode: EmbeddedSessionMode,
  labelPrefix: string,
  project?: string | null,
): Promise<string> {
  const resolvedProject =
    project ?? (await detectProjectName().catch(() => null)) ?? "unknown";
  const key = `${process.pid}-${server.port}`;
  registerSession({
    id: key,
    pid: process.pid,
    port: server.port,
    url: server.url,
    mode,
    project: resolvedProject,
    startedAt: new Date().toISOString(),
    label: `${labelPrefix}-${resolvedProject}`,
  });
  return key;
}

/** Remove a session registered by registerEmbeddedSession(). No-op if absent. */
export function unregisterEmbeddedSession(key: string): void {
  unregisterSession(key);
}
