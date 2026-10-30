/**
 * `plannotator sessions` discovery for the servers this plugin runs inside
 * OpenCode's process. They go in `sessions/opencode/`, which the update checks
 * never read: these servers do not run the binary, so they never hold back its
 * update (packages/server/sessions.ts).
 */
import { registerInProcessSession, type SessionInfo } from "@plannotator/server/sessions";

type Mode = Extract<SessionInfo["mode"], "plan" | "review" | "annotate">;

/** List a running server; returns the function that removes it (also run at process exit). */
export function listOpenCodeSession(server: { port: number; url: string }, mode: Mode, project?: string | null): () => void {
  const name = project || "unknown";
  return registerInProcessSession("opencode", {
    port: server.port,
    url: server.url,
    mode,
    project: name,
    startedAt: new Date().toISOString(),
    label: `${mode}-${name}`,
  });
}

/**
 * Wait for the decision and close the server after the usual 1.5 s; the
 * session entry is removed first, whether the wait settles or throws.
 */
export async function decideListed<T>(
  server: { port: number; url: string; waitForDecision: () => Promise<T>; stop: () => void },
  mode: Mode,
  project?: string | null,
): Promise<T> {
  let unlist = () => {};
  try {
    unlist = listOpenCodeSession(server, mode, project);
    const result = await server.waitForDecision();
    await Bun.sleep(1500);
    return result;
  } finally {
    unlist();
    server.stop();
  }
}
