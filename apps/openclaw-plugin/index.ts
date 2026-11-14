import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENCLAW_PLUGIN_ID, OPENCLAW_PLUGIN_PACKAGE, type OpenClawPluginApi } from "./openclaw";
import { registerPlannotator } from "./plugin";

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
      if (pkg.name === OPENCLAW_PLUGIN_PACKAGE && typeof pkg.version === "string" && pkg.version) return pkg.version;
    } catch {
      continue;
    }
  }
  return null;
}

export default {
  id: OPENCLAW_PLUGIN_ID,
  name: "Plannotator",
  description: "The Plannotator Inbox in your own OpenClaw chats: the agent sends you messages and questions, and your replies come back into the same chat.",
  register(api: OpenClawPluginApi): void {
    registerPlannotator(api, { version: readPluginVersion() });
  },
};
