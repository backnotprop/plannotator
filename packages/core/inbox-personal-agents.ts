/**
 * Personal agents, for the Inbox's one-time "personal agents" dialog (reveals.ts `personal_agents`): the agents that
 * act for the person rather than in a code project. The agents pages and the dialog's banner name four (Hermes
 * Agent, OpenClaw, Muse by Meta, Grok Bot), and a cloud agent added as "Other" counts too: someone who added one
 * already knows the Inbox takes them. A Claude Code routine does not count: it is a coding agent run on a schedule.
 *
 * Connected means any of: a cloud agent of those kinds in Settings (inbox/cloud-agents.json), the Inbox tool turned
 * on for OpenClaw or Hermes Agent on this computer (config.json `inboxTool`), or a thread one of them started.
 */
import { INBOX_CLOUD_HOSTS, type InboxCloudPreset } from "./inbox-cloud";

export const PERSONAL_AGENT_CLOUD_PRESETS: readonly InboxCloudPreset[] = ["hermes", "openclaw", "muse", "grok-bot", "other"];

/** The local hosts with an Inbox tool switch of their own (config.json `inboxTool`, off by default). */
export const PERSONAL_AGENT_TOOL_HOSTS = ["openclaw", "hermes"] as const;

/** Every author host a personal agent writes as: the local plugins, and the cloud kinds above. */
export const PERSONAL_AGENT_HOSTS: readonly string[] = [...PERSONAL_AGENT_TOOL_HOSTS, ...PERSONAL_AGENT_CLOUD_PRESETS.map((preset) => INBOX_CLOUD_HOSTS[preset])];

export interface PersonalAgentSigns {
  cloudPresets: Iterable<string>;
  toolOn: (host: (typeof PERSONAL_AGENT_TOOL_HOSTS)[number]) => boolean;
  /** Read last and lazily: the author host of each thread's first message. */
  threadAuthorHosts: () => Iterable<string | null | undefined>;
}

export function personalAgentConnected(signs: PersonalAgentSigns): boolean {
  for (const preset of signs.cloudPresets) if ((PERSONAL_AGENT_CLOUD_PRESETS as readonly string[]).includes(preset)) return true;
  if (PERSONAL_AGENT_TOOL_HOSTS.some((host) => signs.toolOn(host))) return true;
  for (const host of signs.threadAuthorHosts()) if (host && PERSONAL_AGENT_HOSTS.includes(host)) return true;
  return false;
}

/**
 * The dialog's banner (4:1, 1200x300 at 2x), hosted on the project's site, never bundled. The window's CSP allows
 * pictures from this folder and no other remote place (packages/server/inbox.ts `WINDOW_CSP`).
 */
export const PERSONAL_AGENTS_BANNER_BASE = "https://plannotator.ai/assets/hosted/";

export const PERSONAL_AGENTS_BANNER = {
  light: { x1: `${PERSONAL_AGENTS_BANNER_BASE}personal-agents-b-light.webp`, x2: `${PERSONAL_AGENTS_BANNER_BASE}personal-agents-b-light@2x.webp` },
  dark: { x1: `${PERSONAL_AGENTS_BANNER_BASE}personal-agents-b-dark.webp`, x2: `${PERSONAL_AGENTS_BANNER_BASE}personal-agents-b-dark@2x.webp` },
} as const;

/** The words baked into the banner, for its alt text. */
export const PERSONAL_AGENTS_BANNER_WORDS = "Your personal agents are welcome here.";
