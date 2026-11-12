import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ClineInboxSession, type ClinePluginApi, type ClineRunContext, type ClineSetupContext, setupClineInbox } from "./inbox";

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
    }
  }
  return null;
}

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
      }
    }
  },
  hooks: {
    beforeRun(context: ClineRunContext): undefined {
      try {
        session?.beforeRun(context);
      } catch {
      }
      return undefined;
    },
    afterRun(context: ClineRunContext): void {
      try {
        session?.afterRun(context);
      } catch {
      }
    },
  },
};

export default plugin;
