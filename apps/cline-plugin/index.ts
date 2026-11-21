/**
 * Plannotator for Cline: a Cline plugin (an `AgentPlugin`) that connects a
 * Cline session to the Plannotator Inbox (inbox.ts): the `plannotator_inbox`
 * tool, the session listed in the Inbox's New message picker, and the
 * person's replies going back into the session as a turn.
 *
 * Cline imports this file in a worker thread per session and calls `setup`
 * on the session's first turn (and again after it stopped an idle worker).
 * The hooks feed the session's busy state. Every hook and setup is guarded:
 * a failure here never fails Cline's run.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClineInboxSession, type ClinePluginApi, type ClineRunContext, type ClineSetupContext, setupClineInbox } from "./inbox";

/** This package's version: package.json beside the source, or one level up from the built `dist/index.js`. */
function readPluginVersion(): string | null {
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (const candidate of [join(here, "package.json"), join(here, "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "@plannotator/cline" && typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      // Next.
    }
  }
  return null;
}

/** The session this worker serves (one worker per session). */
let session: ClineInboxSession | null = null;

export const plugin = {
  name: "plannotator",
  manifest: { capabilities: ["tools", "hooks"] },
  async setup(api: ClinePluginApi, ctx: ClineSetupContext): Promise<void> {
    try {
      session?.dispose();
      session = await setupClineInbox(api, ctx, { version: readPluginVersion() });
    } catch (error) {
      session = null;
      try {
        ctx.logger?.warn?.(`plannotator: the Inbox connection did not start (${error instanceof Error ? error.message : String(error)})`);
      } catch {
        // Logging is best-effort.
      }
    }
  },
  hooks: {
    beforeRun(context: ClineRunContext): undefined {
      try {
        session?.beforeRun(context);
      } catch {
        // Never fail Cline's run.
      }
      return undefined;
    },
    afterRun(context: ClineRunContext): void {
      try {
        session?.afterRun(context);
      } catch {
        // Never fail Cline's run.
      }
    },
  },
};

export default plugin;
