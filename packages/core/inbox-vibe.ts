/**
 * Mistral Vibe in the Inbox: a session the Inbox starts from compose (packages/server/inbox-launch-vibe.ts), driven
 * over `vibe-acp` (the Agent Client Protocol over stdio).
 */
import { inboxLaunchTokenOk, type InboxLaunchChoices } from "./inbox-launch-choice";

export const INBOX_VIBE_HOST = "mistral-vibe";

export const INBOX_VIBE_NAME = "Vibe";

/**
 * Set only in the env of the Inbox MCP server a launched Vibe session runs: the session the shim's calls belong to.
 * Vibe starts stdio MCP servers with a near-empty env and names no session of its own, so the host passes it.
 */
export const INBOX_VIBE_SESSION_ENV = "PLANNOTATOR_VIBE_SESSION";

/** The first `vibe-acp` a launch starts: the one whose session load, MCP env and permission requests were tested. */
export const INBOX_VIBE_LAUNCH_MIN_VERSION = "3.1.3";

/** `vibe-acp -v` ("vibe-acp 3.1.3"), or null. */
export function parseVibeVersion(text: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

type SelectOption = { value?: unknown; options?: unknown };

/**
 * The model select of a `session/new` answer's `configOptions`, as compose's lists: its values (checked as launch
 * tokens, each once). No default model is named: a project's own `.vibe` config can change it per folder. Vibe has no
 * per-session thinking level that leaves the person's config alone (`session/set_config_option` writes
 * `config.toml`), so there is no effort column.
 */
export function parseVibeModels(configOptions: unknown): Omit<InboxLaunchChoices, "last"> | null {
  if (!Array.isArray(configOptions)) return null;
  const select = configOptions.find((option) => option?.type === "select" && (option.category === "model" || option.id === "model"));
  if (!select || !Array.isArray(select.options)) return null;
  const models: string[] = [];
  const add = (option: SelectOption) => {
    if (Array.isArray(option.options)) for (const inner of option.options as SelectOption[]) add(inner);
    else if (inboxLaunchTokenOk(option.value) && !models.includes(option.value)) models.push(option.value);
  };
  for (const option of select.options as SelectOption[]) add(option);
  return { models, efforts: [], effort_word: "Thinking" };
}

/** The env that starts a session on the picked model without writing the person's config (Vibe's `VIBE_*` layer). */
export function vibeModelEnv(model: string | undefined): Record<string, string> {
  return inboxLaunchTokenOk(model) ? { VIBE_ACTIVE_MODEL: model } : {};
}
