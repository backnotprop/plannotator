/**
 * Getting an agent ready to start: resolve it, install its npm ACP adapter
 * when it is missing and the setting allows, and say why when neither works.
 * Kept free of VS Code so the order and the retry are tested directly.
 */

import type { AdapterResolution, AgentDescriptor } from "./agents";

/** What installing an adapter answered (the extension's adapters.ts `installAdapter`). */
export type InstallResult = { ok: true; dir: string } | { ok: false; message: string };

export type ReadyLaunch = Extract<AdapterResolution, { ok: true }>;

export interface EnsureLaunchDeps {
  /** Setting, then PATH, then the copy Guided Reviews installed. */
  resolve(agent: AgentDescriptor): AdapterResolution;
  /** `plannotator.guides.installAdapters`. */
  installAdapters: boolean;
  install(agent: AgentDescriptor): Promise<InstallResult>;
  /** An install failed: show the one-line reason with Retry. */
  installFailed(agent: AgentDescriptor, message: string): Promise<"retry" | "stop">;
  /** The agent cannot start for another reason (or auto-install is off): show how to fix it. Answers a launch when the user fixed it there. */
  missing(agent: AgentDescriptor, launch: Extract<AdapterResolution, { ok: false }>): Promise<ReadyLaunch | null>;
}

export async function ensureAgentLaunch(agent: AgentDescriptor, deps: EnsureLaunchDeps): Promise<ReadyLaunch | null> {
  let installed = false;
  for (;;) {
    const launch = deps.resolve(agent);
    if (launch.ok) return launch;
    if (launch.reason === "adapter" && installed) {
      return deps.missing(agent, { ...launch, message: `${agent.label}'s ACP adapter was installed but could not be started from there. Run \`${agent.installCommand}\` yourself, then try again.` });
    }
    if (launch.reason !== "adapter" || !deps.installAdapters || !agent.adapter) return deps.missing(agent, launch);
    const result = await deps.install(agent);
    if (result.ok) {
      installed = true;
      continue;
    }
    if ((await deps.installFailed(agent, result.message)) === "stop") return null;
  }
}
