/**
 * T3 Code in Settings → Agents (`InboxAgentsModel.t3`): whether T3 is on this
 * computer, whether its `t3` command sends replies here, whether it is open,
 * and the saved sign-ins. Read on every agents read, so it runs no process:
 * files, `which` and the wake's own grants only.
 *
 * Found: T3's home folder, its launcher, or a `t3` on PATH, Windows included
 * (where the local route is off, inbox-t3-local.ts, and a sign-in is the
 * only way a reply wakes a thread).
 */

import { existsSync } from "node:fs";
import type { InboxT3Status } from "@plannotator/core/inbox-types";
import { agentHomeAllowed, type AgentEnvironment } from "./inbox-agents";
import { t3HomeOf, t3LauncherOf, type T3Local } from "./inbox-t3-local";
import type { InboxT3Wake } from "./inbox-t3-wake";

export function t3Found(environment: AgentEnvironment): boolean {
  // A test run reads agent files only in a scratch home (never the person's real ~/.t3).
  if (!agentHomeAllowed(environment)) return false;
  return existsSync(t3HomeOf(environment)) || existsSync(t3LauncherOf(environment)) || environment.which("t3") !== null;
}

export async function t3SettingsStatus(environment: AgentEnvironment, local: T3Local, wake: Pick<InboxT3Wake, "signIn">): Promise<InboxT3Status | null> {
  if (!t3Found(environment)) return null;
  const sign_in = await wake.signIn().catch(() => "none" as const);
  return { local: local.installed(), open: local.running(), sign_in };
}
