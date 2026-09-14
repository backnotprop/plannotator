// Imports the `./origin-session` subpath, not the `@plannotator/server`
// package root — this file is bundled into index.ts/server.ts's --target
// node build, which must not pull in the root barrel's Bun-only modules
// (browser.ts, repo.ts, project.ts, integrations.ts all `import ... from
// "bun"`). The origin-session submodule itself has no such imports.
import { buildOriginSession } from "@plannotator/server/origin-session";
import type { ParentSession } from "@plannotator/ai";

/**
 * Build the Ask AI fork-origin ParentSession for an OpenCode-invoked
 * surface, from the (sessionId, cwd) pair every entry point already has.
 *
 * Thin OpenCode-specific wrapper around the shared builder
 * (`buildOriginSession`, packages/server/origin-session.ts) — that's the one
 * place the {sessionId, cwd, agent} object actually gets constructed;
 * apps/hook/server/index.ts's Claude Code and OpenCode-bridge sites use the
 * same function (#1519).
 */
export function toOriginSession(input: {
  sessionId?: string;
  cwd?: string;
}): ParentSession | null {
  return buildOriginSession({ agent: "opencode", sessionId: input.sessionId, cwd: input.cwd });
}
