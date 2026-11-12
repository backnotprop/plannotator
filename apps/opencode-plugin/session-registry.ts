import { registerInProcessSession, type SessionInfo } from "@plannotator/server/sessions";

type Mode = Extract<SessionInfo["mode"], "plan" | "review" | "annotate">;

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
