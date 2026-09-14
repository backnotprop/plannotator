/**
 * Shared construction of the Ask AI fork-origin `ParentSession` (#1519).
 *
 * Every launch site that can name the agent session it was invoked from
 * (the hook CLI's ancestor-PID resolution, the OpenCode bridge's stdin
 * payloads, the OpenCode plugin's native command/embedded-runtime paths)
 * ends up with the same raw (sessionId, cwd) pair and needs the same
 * {sessionId, cwd, agent} object. `buildOriginSession` is the one place
 * that object gets constructed — apps/hook/server/index.ts and
 * apps/opencode-plugin/origin-session.ts both delegate to it rather than
 * rebuilding it themselves.
 */

import type { ParentSession } from "@plannotator/ai";
import type { Origin } from "@plannotator/shared/agents";

/**
 * Build a `ParentSession` from a raw sessionId/cwd pair. Accepts
 * unknown-typed input so callers reading untrusted JSON (stdin bridge
 * payloads, hook-event fields) don't need their own type guards. Returns
 * null when sessionId is missing/blank — callers just skip offering the
 * fork toggle.
 */
export function buildOriginSession(input: {
  agent: Origin;
  sessionId?: unknown;
  cwd?: unknown;
  /** cwd to use when `cwd` is absent/blank. Defaults to `process.cwd()`. */
  fallbackCwd?: string;
}): ParentSession | null {
  if (typeof input.sessionId !== "string" || !input.sessionId) return null;
  const cwd =
    typeof input.cwd === "string" && input.cwd
      ? input.cwd
      : (input.fallbackCwd ?? process.cwd());
  return { sessionId: input.sessionId, cwd, agent: input.agent };
}

/**
 * Mixin for `ServerOptions`, `AnnotateServerOptions` and `ReviewServerOptions`
 * (packages/server) — one place for the `originSession` field and its doc,
 * previously repeated verbatim in all three. The agent session this surface
 * was launched from, when known. Used server-side to let Ask AI fork it on
 * request (#1519); never echoed to the browser.
 */
export interface OriginSessionOption {
  originSession?: ParentSession | null;
}
