import type { AdapterResolution, AgentDescriptor } from "./agents";

export type InstallResult = { ok: true; dir: string } | { ok: false; message: string };

export type ReadyLaunch = Extract<AdapterResolution, { ok: true }>;

export interface EnsureLaunchDeps {
  resolve(agent: AgentDescriptor): AdapterResolution;
  installAdapters: boolean;
  install(agent: AgentDescriptor): Promise<InstallResult>;
  installFailed(agent: AgentDescriptor, message: string): Promise<"retry" | "stop">;
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
