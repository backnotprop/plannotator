import { findExecutable } from "./which";
import { isSameProgram, type SameProgramCheck, type SameProgramSignature } from "./same-program";
import { readEffortSelect, readModelSelect, type ConfigChoice, type ConfigSelect } from "./client";
import type { AuthMethod, SessionConfigOption } from "@agentclientprotocol/sdk";

export interface ManagedAdapterSpec {
  package: string;
  version: string;
  bin: string;
  before: string;
}

export interface ManagedLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  dir: string;
}

export interface AgentDescriptor {
  id: string;
  label: string;
  engine: string;
  command: string;
  altCommands?: readonly string[];
  altCommandsSignature?: SameProgramSignature;
  args: readonly string[];
  installCommand: string;
  installCommandWindows?: string | null;
  adapter?: ManagedAdapterSpec;
  requires?: { command: string; label: string; installCommand: string; docsUrl: string };
  docsUrl: string;
  defaultModel?: RegExp;
  defaultEffort?: RegExp;
  permissiveModes?: readonly string[];
  note?: string;
  signIn?: { command?: string; args: readonly string[] };
  versionShape?: RegExp;
}

export const ADAPTER_PIN_BEFORE = "2026-10-16";

export const CLAUDE_CODE: AgentDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  engine: "claude",
  command: "claude-agent-acp",
  args: [],
  installCommand: "npm install -g @agentclientprotocol/claude-agent-acp@0.91.0",
  adapter: { package: "@agentclientprotocol/claude-agent-acp", version: "0.91.0", bin: "claude-agent-acp", before: ADAPTER_PIN_BEFORE },
  docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
  defaultModel: /sonnet/i,
  defaultEffort: /^low$/i,
  permissiveModes: ["acceptEdits", "auto", "bypassPermissions"],
  signIn: { command: "claude", args: ["/login"] },
};

export const CODEX: AgentDescriptor = {
  id: "codex",
  label: "Codex",
  engine: "codex",
  command: "codex-acp",
  args: [],
  installCommand: "npm install -g @agentclientprotocol/codex-acp@2.2.2",
  adapter: { package: "@agentclientprotocol/codex-acp", version: "2.2.2", bin: "codex-acp", before: ADAPTER_PIN_BEFORE },
  docsUrl: "https://github.com/agentclientprotocol/codex-acp",
  defaultEffort: /^low$/i,
  permissiveModes: ["agent", "agent-full-access"],
};

export const OPENCODE: AgentDescriptor = {
  id: "opencode",
  label: "OpenCode",
  engine: "opencode",
  command: "opencode",
  args: ["acp"],
  installCommand: "curl -fsSL https://opencode.ai/install | bash",
  installCommandWindows: "npm install -g opencode-ai",
  docsUrl: "https://opencode.ai/docs/acp/",
  signIn: { args: ["auth", "login"] },
};

export const COPILOT: AgentDescriptor = {
  id: "copilot",
  label: "GitHub Copilot CLI",
  engine: "copilot",
  command: "copilot",
  args: ["--acp", "--stdio"],
  installCommand: "npm install -g @github/copilot",
  docsUrl: "https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server",
  defaultEffort: /^low$/i,
};

export const CURSOR: AgentDescriptor = {
  id: "cursor",
  label: "Cursor",
  engine: "cursor",
  command: "cursor-agent",
  altCommands: ["agent"],
  altCommandsSignature: { realName: "cursor-agent", versionLine: /^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,40}$/ },
  args: ["acp"],
  installCommand: "curl https://cursor.com/install -fsS | bash",
  installCommandWindows: "irm 'https://cursor.com/install?win32=true' | iex",
  docsUrl: "https://cursor.com/docs/cli/acp",
  signIn: { args: ["login"] },
};

export const KIRO: AgentDescriptor = {
  id: "kiro",
  label: "Kiro CLI",
  engine: "kiro",
  command: "kiro-cli",
  args: ["acp"],
  installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
  installCommandWindows: null,
  docsUrl: "https://kiro.dev/docs/cli/acp/",
};

export const KILO: AgentDescriptor = {
  id: "kilo",
  label: "Kilo Code",
  engine: "kilo",
  command: "kilo",
  altCommands: ["kilocode"],
  args: ["acp"],
  installCommand: "npm install -g @kilocode/cli",
  docsUrl: "https://kilo.ai/docs/code-with-ai/platforms/cli",
  signIn: { args: ["auth", "login"] },
};

export const PI: AgentDescriptor = {
  id: "pi",
  label: "Pi",
  engine: "pi",
  command: "pi-acp",
  args: [],
  installCommand: "npm install -g pi-acp@0.0.34",
  adapter: { package: "pi-acp", version: "0.0.34", bin: "pi-acp", before: ADAPTER_PIN_BEFORE },
  requires: { command: "pi", label: "Pi", installCommand: "npm install -g @earendil-works/pi-coding-agent", docsUrl: "https://github.com/svkozak/pi-acp" },
  docsUrl: "https://github.com/svkozak/pi-acp",
  note: "Can't write guides yet: pi-acp does not pass MCP servers on to Pi (its README says they are \"accepted … but not wired through to pi\"), so Pi cannot reach the guide's tools.",
};

export const GROK: AgentDescriptor = {
  id: "grok",
  label: "Grok Build",
  engine: "grok",
  command: "grok",
  args: ["agent", "stdio"],
  installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
  installCommandWindows: null,
  docsUrl: "https://x.ai/cli",
  versionShape: /^grok \d+\.\d+\.\d+\b/,
};

export const KNOWN_AGENTS: readonly AgentDescriptor[] = [CLAUDE_CODE, CODEX, OPENCODE, COPILOT, CURSOR, KIRO, KILO, PI];

export const CUSTOM_AGENT_ID = "custom";

export function customAgent(setting: { command?: string; args?: string[]; label?: string }): AgentDescriptor | null {
  const command = setting.command?.trim();
  if (!command) return null;
  return {
    id: CUSTOM_AGENT_ID,
    label: setting.label?.trim() || "Custom agent",
    engine: "acp",
    command,
    args: setting.args ?? [],
    installCommand: "",
    docsUrl: "https://agentclientprotocol.com/get-started/agents",
  };
}

export function findAgent(id: string, custom: AgentDescriptor | null): AgentDescriptor | null {
  if (id === CUSTOM_AGENT_ID) return custom;
  return KNOWN_AGENTS.find((a) => a.id === id) ?? null;
}

export function engineLabel(engine: string | undefined): string {
  if (!engine) return "";
  return KNOWN_AGENTS.find((a) => a.engine === engine)?.label ?? engine;
}

export type AdapterResolution =
  | {
      ok: true;
      command: string;
      args: string[];
      env?: Record<string, string>;
      source: "setting" | "path" | "managed";
      cliLog?: string;
      startHint?: string;
    }
  | {
      ok: false;
      message: string;
      reason: "adapter" | "agent" | "requires" | "setting";
    };

export interface CommandOverride {
  command?: string;
  args?: string[];
}

export function resolveAgentLaunch(
  agent: AgentDescriptor,
  override: CommandOverride = {},
  find: (name: string) => string | null = findExecutable,
  managed: (agent: AgentDescriptor) => ManagedLaunch | null = () => null,
  platform: NodeJS.Platform = process.platform,
  sameProgram: SameProgramCheck = isSameProgram,
): AdapterResolution {
  const configured = override.command?.trim();
  if (configured) {
    const found = find(configured);
    if (!found) return { ok: false, reason: "setting", message: `The configured command for ${agent.label}, \`${configured}\`, was not found.` };
    const args = override.args && override.args.length > 0 ? override.args : [...agent.args];
    return { ok: true, command: found, args, source: "setting" };
  }
  if (agent.requires && !find(agent.requires.command)) {
    const r = agent.requires;
    return { ok: false, reason: "requires", message: `${r.label} is not installed: \`${r.command}\` is not on PATH. Install it with \`${r.installCommand}\`, then try again.` };
  }
  const own = find(agent.command);
  if (own) return { ok: true, command: own, args: [...agent.args], source: "path" };
  const others: string[] = [];
  for (const name of agent.altCommands ?? []) {
    const found = find(name);
    if (!found) continue;
    if (agent.altCommandsSignature && !sameProgram(found, agent.altCommandsSignature)) {
      others.push(name);
      continue;
    }
    return { ok: true, command: found, args: [...agent.args], source: "path" };
  }
  const copy = agent.adapter ? managed(agent) : null;
  if (copy) return { ok: true, command: copy.command, args: copy.args, ...(copy.env && { env: copy.env }), source: "managed" };
  if (agent.adapter) {
    return {
      ok: false,
      reason: "adapter",
      message: `${agent.label}'s ACP adapter is not installed. Guided Reviews installs ${agent.adapter.package}@${agent.adapter.version} into its own storage when you start a guide; or run \`${agent.installCommand}\` yourself.`,
    };
  }
  const install = installCommandFor(agent.installCommand, agent.installCommandWindows, platform);
  const another = others.length > 0 ? ` (${others.map((n) => `the \`${n}\` there`).join(" and ")} ${others.length > 1 ? "are other programs" : "is another program"})` : "";
  const notOnPath = `\`${agent.command}\` is not on PATH${another}`;
  return {
    ok: false,
    reason: agent.installCommand ? "agent" : "setting",
    message: !agent.installCommand
      ? `${notOnPath}.`
      : install
        ? `${agent.label} is not installed: ${notOnPath}. Install it with \`${install}\`, then try again.`
        : `${agent.label} is not installed: ${notOnPath}. Install it as its docs say (${agent.docsUrl}), then try again.`,
  };
}

export function installCommandFor(command: string, windows: string | null | undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (!command) return null;
  if (platform !== "win32") return command;
  if (windows !== undefined) return windows;
  return /^npm\s/.test(command) ? command : null;
}

export interface AgentStatus {
  agent: AgentDescriptor;
  launch: AdapterResolution;
}

export function detectAgents(
  overrides: (id: string) => CommandOverride,
  custom: AgentDescriptor | null,
  find: (name: string) => string | null = findExecutable,
  managed: (agent: AgentDescriptor) => ManagedLaunch | null = () => null,
  installAdapters = false,
  sameProgram: SameProgramCheck = isSameProgram,
): AgentStatus[] {
  const all = [...KNOWN_AGENTS, ...(custom ? [custom] : [])].map((agent) => ({
    agent,
    launch: resolveAgentLaunch(agent, agent.id === CUSTOM_AGENT_ID ? {} : overrides(agent.id), find, managed, process.platform, sameProgram),
  }));
  const ready = (s: AgentStatus) => s.launch.ok || (installAdapters && s.launch.reason === "adapter");
  return [...all.filter(ready), ...all.filter((s) => !ready(s))];
}

export function canStart(launch: AdapterResolution, installAdapters: boolean): boolean {
  return launch.ok || (installAdapters && launch.reason === "adapter");
}

export interface AgentOptionsCache {
  agentId: string;
  fetchedAt: number;
  model: ConfigSelect | null;
  effort: ConfigSelect | null;
  effortByModel?: Record<string, ConfigSelect | null>;
}

export function readAgentOptions(agentId: string, configOptions: readonly SessionConfigOption[] | null | undefined, now = Date.now()): AgentOptionsCache {
  return {
    agentId,
    fetchedAt: now,
    model: readModelSelect(configOptions),
    effort: readEffortSelect(configOptions),
  };
}

export function pickDefault(select: ConfigSelect | null, pattern: RegExp | undefined, remembered?: string): ConfigChoice | null {
  if (!select || select.options.length === 0) return null;
  if (remembered) {
    const hit = select.options.find((o) => o.value === remembered);
    if (hit) return hit;
  }
  const byPattern = pattern ? select.options.find((o) => pattern.test(o.value) || pattern.test(o.name)) : undefined;
  return byPattern ?? select.options.find((o) => o.value === select.current) ?? select.options[0];
}

export interface LoginCommand {
  label: string;
  description?: string;
  args: string[];
  env?: Record<string, string>;
}

export function loginCommands(authMethods: readonly AuthMethod[] | null | undefined): LoginCommand[] {
  const out: LoginCommand[] = [];
  for (const m of authMethods ?? []) {
    if (!("type" in m) || m.type !== "terminal") continue;
    const t = m as { name: string; description?: string | null; args?: string[]; env?: Record<string, string> };
    if (!Array.isArray(t.args) || !t.args.every((a) => typeof a === "string")) continue;
    out.push({ label: t.name, ...(t.description && { description: t.description }), args: t.args, ...(t.env && { env: t.env }) });
  }
  return out;
}
