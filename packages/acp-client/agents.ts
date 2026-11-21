/**
 * Which agents Plannotator can start over ACP, and how: Guided Reviews in the
 * VS Code extension (`KNOWN_AGENTS`), its only user now. `GROK` is kept from
 * the Inbox's removed Grok Build runner (0.28.34 to 0.28.36).
 *
 * A small, bundled list: every entry's launch command and install command come
 * from the agent's own documentation (the source is linked on each entry). An
 * agent that speaks ACP through a separate npm adapter names it (`adapter`,
 * pinned to one version); Guided Reviews installs that adapter into its own
 * storage when it is missing (see `adapters.ts`). It never installs an agent
 * itself, never runs `npx` and never installs globally. Any other ACP agent
 * can be started with the custom agent settings.
 *
 * Guides runs the agent with the user's own configuration and permissions,
 * exactly as they set it up: no mode is forced, no tool is added or removed,
 * no setting source is narrowed. What the agent may do is governed by its own
 * settings; every permission request it sends is shown to the user with all
 * of its options. Guides adds only what a guide needs: its own MCP server (the
 * builder tools), the model and effort the user picked, and the prompt.
 */

import { findExecutable } from "./which";
import { isSameProgram, type SameProgramCheck, type SameProgramSignature } from "./same-program";
import { readEffortSelect, readModelSelect, type ConfigChoice, type ConfigSelect } from "./client";
import type { AuthMethod, SessionConfigOption } from "@agentclientprotocol/sdk";

/** An npm package that starts the agent's ACP server, pinned to one version (Guides installs it: the extension's adapters.ts). */
export interface ManagedAdapterSpec {
  package: string;
  /** Exact version (published at least 7 days before it was pinned). */
  version: string;
  /** The package's `bin` entry to run. */
  bin: string;
  /**
   * `npm install --before`: the day the pin was chosen less 7 days, so every
   * dependency npm resolves was published at least 7 days before the pin.
   */
  before: string;
}

/** What `managedLaunch` answers: run `command args` (with `env`). */
export interface ManagedLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  dir: string;
}

export interface AgentDescriptor {
  id: string;
  label: string;
  /** `generator.engine` in a saved guide. */
  engine: string;
  /** The program on PATH. */
  command: string;
  /** Other names the same program is installed under, tried in order after `command`. */
  altCommands?: readonly string[];
  /**
   * How to tell the agent's own program from another one installed under an
   * `altCommands` name (a generic name such as `agent`). When set, a program
   * found under another name is used only when it has this signature, and is
   * otherwise taken as not installed.
   */
  altCommandsSignature?: SameProgramSignature;
  /** Arguments that start its ACP server on stdio. */
  args: readonly string[];
  /** How to install it, as the agent's docs say (for an npm adapter: a global install of the pinned version). */
  installCommand: string;
  /**
   * The Windows (PowerShell) install command the agent's docs give, when
   * `installCommand` is a shell script; null when the docs give none (the
   * install button then opens the docs). An npm command needs none.
   */
  installCommandWindows?: string | null;
  /**
   * The npm package that is the agent's ACP adapter. Guided Reviews installs
   * this exact version into its own storage when the adapter is missing.
   */
  adapter?: ManagedAdapterSpec;
  /** A program the adapter runs, which must be installed for it to work (Pi's `pi`). */
  requires?: { command: string; label: string; installCommand: string; docsUrl: string };
  docsUrl: string;
  /** Cheap defaults: matched against the agent's own option values and names. */
  defaultModel?: RegExp;
  defaultEffort?: RegExp;
  /**
   * The agent's own modes that let it act without asking: the first is the
   * one Guides switches to, the rest are at least as permissive (a session
   * already in any of them is left alone, never downgraded). Used only when
   * the user opts in to automatic approval; otherwise the session stays in
   * whatever mode the user's config starts it in.
   */
  permissiveModes?: readonly string[];
  /**
   * A known capability gap, shown in the picker. It never stops the agent from
   * being picked or started.
   */
  note?: string;
  /**
   * Sign in in a terminal when the agent lists no terminal sign-in of its own.
   * Without `command`, the program that starts the agent (as resolved) runs `args`.
   */
  signIn?: { command?: string; args: readonly string[] };
  /**
   * The first line `<program> --version` prints, as this agent prints it, so
   * a caller can tell another program installed under the same name from this
   * agent. Set on `GROK`; no caller reads it now (the Inbox's Grok Build
   * runner, which did, was removed).
   */
  versionShape?: RegExp;
}


/**
 * `npm install --before` for every pinned adapter: the pins were chosen on
 * 2026-10-23, so the adapter and every package it pulls in are ones published
 * at least 7 days before (the repo's release-age rule).
 */
export const ADAPTER_PIN_BEFORE = "2026-10-16";

/** Claude Code through its ACP adapter. Source: https://github.com/agentclientprotocol/claude-agent-acp */
export const CLAUDE_CODE: AgentDescriptor = {
  id: "claude-code",
  label: "Claude Code",
  engine: "claude",
  command: "claude-agent-acp",
  args: [],
  installCommand: "npm install -g @agentclientprotocol/claude-agent-acp@0.91.0",
  // 0.91.0 was published 2026-10-15 (the repo installs nothing published in the last 7 days).
  adapter: { package: "@agentclientprotocol/claude-agent-acp", version: "0.91.0", bin: "claude-agent-acp", before: ADAPTER_PIN_BEFORE },
  docsUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
  defaultModel: /sonnet/i,
  defaultEffort: /^low$/i,
  // claude-agent-acp's modes (src/permissions/modes.ts): acceptEdits, auto and bypassPermissions ask less than default and plan.
  permissiveModes: ["acceptEdits", "auto", "bypassPermissions"],
  signIn: { command: "claude", args: ["/login"] },
};

/** Codex through `codex-acp`. Source: https://github.com/agentclientprotocol/codex-acp */
export const CODEX: AgentDescriptor = {
  id: "codex",
  label: "Codex",
  engine: "codex",
  command: "codex-acp",
  args: [],
  installCommand: "npm install -g @agentclientprotocol/codex-acp@2.2.2",
  // 2.2.2 was published 2026-10-10; it brings the Codex CLI with it (@openai/codex).
  adapter: { package: "@agentclientprotocol/codex-acp", version: "2.2.2", bin: "codex-acp", before: ADAPTER_PIN_BEFORE },
  docsUrl: "https://github.com/agentclientprotocol/codex-acp",
  defaultEffort: /^low$/i,
  // codex-acp's `agent` mode ("Auto review") writes in the workspace without asking; `agent-full-access` asks even less; `read-only` asks first.
  permissiveModes: ["agent", "agent-full-access"],
};

/** OpenCode's `opencode acp`. Source: https://opencode.ai/docs/acp/ */
export const OPENCODE: AgentDescriptor = {
  id: "opencode",
  label: "OpenCode",
  engine: "opencode",
  command: "opencode",
  args: ["acp"],
  installCommand: "curl -fsSL https://opencode.ai/install | bash",
  // https://opencode.ai/docs/ lists npm for Windows (also choco and scoop).
  installCommandWindows: "npm install -g opencode-ai",
  docsUrl: "https://opencode.ai/docs/acp/",
  signIn: { args: ["auth", "login"] },
};

/** GitHub Copilot CLI's ACP server. Source: https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server */
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

/**
 * Cursor's CLI in ACP mode. Source: https://cursor.com/docs/cli/acp (`agent
 * acp`); the ACP registry starts the same program as `cursor-agent acp`.
 * Cursor's installer links both names to
 * `~/.local/share/cursor-agent/versions/<version>/cursor-agent`, whose
 * `--version` prints a dated build (`2026.07.08-0c04a8a`, seen on Cursor CLI
 * 2026.07.08). Other tools also install an `agent` (Grok Build's
 * `~/.grok/bin/agent` prints `grok 1.0.70 (f50904eaee6c) [stable]`), so
 * `agent` counts as Cursor only with Cursor's signature.
 */
export const CURSOR: AgentDescriptor = {
  id: "cursor",
  label: "Cursor",
  engine: "cursor",
  command: "cursor-agent",
  altCommands: ["agent"],
  altCommandsSignature: { realName: "cursor-agent", versionLine: /^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,40}$/ },
  args: ["acp"],
  installCommand: "curl https://cursor.com/install -fsS | bash",
  // https://cursor.com/docs/cli/installation, "Windows (native, PowerShell)".
  installCommandWindows: "irm 'https://cursor.com/install?win32=true' | iex",
  docsUrl: "https://cursor.com/docs/cli/acp",
  signIn: { args: ["login"] },
};

/** Kiro CLI's ACP server. Source: https://kiro.dev/docs/cli/acp/ */
export const KIRO: AgentDescriptor = {
  id: "kiro",
  label: "Kiro CLI",
  engine: "kiro",
  command: "kiro-cli",
  args: ["acp"],
  installCommand: "curl -fsSL https://cli.kiro.dev/install | bash",
  // Kiro's docs list Windows 11 (PowerShell) as supported but give no command for it.
  installCommandWindows: null,
  docsUrl: "https://kiro.dev/docs/cli/acp/",
};

/**
 * Kilo Code's CLI. Sources: https://kilo.ai/docs and Kilo-Org/kilocode
 * (`packages/opencode/src/cli/cmd/acp.ts`); the npm package `@kilocode/cli`
 * installs `kilo` and `kilocode`.
 */
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

/**
 * Pi through `pi-acp`. Source: https://github.com/svkozak/pi-acp (README:
 * "MCP servers are accepted in ACP params and stored in session state, but
 * not wired through to pi"). Pi can be picked and started like any agent, but
 * until pi-acp passes MCP servers on it cannot reach the guide's tools.
 */
export const PI: AgentDescriptor = {
  id: "pi",
  label: "Pi",
  engine: "pi",
  command: "pi-acp",
  args: [],
  installCommand: "npm install -g pi-acp@0.0.34",
  // 0.0.34 was published 2026-09-24. pi-acp runs the `pi` program, which must be installed itself.
  adapter: { package: "pi-acp", version: "0.0.34", bin: "pi-acp", before: ADAPTER_PIN_BEFORE },
  requires: { command: "pi", label: "Pi", installCommand: "npm install -g @earendil-works/pi-coding-agent", docsUrl: "https://github.com/svkozak/pi-acp" },
  docsUrl: "https://github.com/svkozak/pi-acp",
  note: "Can't write guides yet: pi-acp does not pass MCP servers on to Pi (its README says they are \"accepted … but not wired through to pi\"), so Pi cannot reach the guide's tools.",
};

/**
 * Grok Build, xAI's terminal agent, in its ACP mode (`grok agent stdio`).
 * Source: ~/.grok/README.md ("Agent mode", "Installation"). Not one of Guides'
 * agents; kept from the Inbox's removed Grok Build runner. It updates itself
 * when it starts.
 */
export const GROK: AgentDescriptor = {
  id: "grok",
  label: "Grok Build",
  engine: "grok",
  command: "grok",
  args: ["agent", "stdio"],
  installCommand: "curl -fsSL https://x.ai/cli/install.sh | bash",
  installCommandWindows: null,
  docsUrl: "https://x.ai/cli",
  // `grok --version`: `grok 1.0.70 (f50904eaee6c) [stable]`.
  versionShape: /^grok \d+\.\d+\.\d+\b/,
};

/** The known agents, in the order the picker lists them (installed ones first). */
export const KNOWN_AGENTS: readonly AgentDescriptor[] = [CLAUDE_CODE, CODEX, OPENCODE, COPILOT, CURSOR, KIRO, KILO, PI];

export const CUSTOM_AGENT_ID = "custom";

/** The custom agent from settings: any other ACP agent. */
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

/** The label for a saved guide's `engine` ("claude" → "Claude Code"). */
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
      /** Set by a caller that adds to the launch (Guides' user-CLI choice): a line for its log on each launch. */
      cliLog?: string;
      /** Set by such a caller: `AgentLaunch.startHint` (added to a failure before the first session is ready). */
      startHint?: string;
    }
  | {
      ok: false;
      message: string;
      /**
       * `adapter`: the agent's npm adapter is missing and Guided Reviews can install it;
       * `agent`: the agent's own CLI is missing (the user installs it);
       * `requires`: a program the adapter runs is missing (Pi's `pi`);
       * `setting`: the command set in settings was not found.
       */
      reason: "adapter" | "agent" | "requires" | "setting";
    };

/** A command override from settings: replaces the program and, when given, its arguments. */
export interface CommandOverride {
  command?: string;
  args?: string[];
}

/**
 * The command to start, in this order: the override when it names a program
 * (its args, else the agent's own); the agent's program on PATH (or one of
 * its other names, when it is the agent's own program: `altCommandsSignature`);
 * the adapter copy Guided Reviews installed (`managed`).
 * When none is there, the answer says whether Guided Reviews can install the
 * adapter now (`reason: "adapter"`) or the user must install the agent. The
 * same for a local run and a pull request run.
 */
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
  /** Other names found on PATH that are some other program. */
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

/**
 * The command to type into a terminal to install something on this platform:
 * on Windows the documented PowerShell command, or the same npm command; null
 * when there is none to give (a bash script with no Windows equivalent), so
 * the caller shows the docs instead.
 */
export function installCommandFor(command: string, windows: string | null | undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (!command) return null;
  if (platform !== "win32") return command;
  if (windows !== undefined) return windows;
  return /^npm\s/.test(command) ? command : null;
}

/** An agent as the picker shows it. */
export interface AgentStatus {
  agent: AgentDescriptor;
  launch: AdapterResolution;
}

/** Every known agent (and the custom one when set), installed ones first, each group in the list's order. */
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

/** Ready to pick: installed, or its adapter is one Guided Reviews installs on first use. */
export function canStart(launch: AdapterResolution, installAdapters: boolean): boolean {
  return launch.ok || (installAdapters && launch.reason === "adapter");
}

export interface AgentOptionsCache {
  agentId: string;
  fetchedAt: number;
  model: ConfigSelect | null;
  effort: ConfigSelect | null;
  /** Efforts per model value, when the agent's effort list depends on the model. */
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

/** The choice to preselect: the remembered value if it is still offered, else the cheap default, else the agent's current. */
export function pickDefault(select: ConfigSelect | null, pattern: RegExp | undefined, remembered?: string): ConfigChoice | null {
  if (!select || select.options.length === 0) return null;
  if (remembered) {
    const hit = select.options.find((o) => o.value === remembered);
    if (hit) return hit;
  }
  const byPattern = pattern ? select.options.find((o) => pattern.test(o.value) || pattern.test(o.name)) : undefined;
  return byPattern ?? select.options.find((o) => o.value === select.current) ?? select.options[0];
}

/** A sign-in the agent offers: run the agent's own command with these args in a terminal. */
export interface LoginCommand {
  label: string;
  description?: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * The terminal sign-ins the agent advertised in `initialize` (ACP terminal
 * auth: run the agent's command with `args`). Empty when it offered none.
 */
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
