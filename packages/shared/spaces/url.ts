/**
 * Where "Share this space" sends a plan, and whether it may (docs/agent-guides/inbox-plans.md, "Share this space").
 *
 *   PLANNOTATOR_SPACES_URL env var  →  config.json `spacesUrl`  →  DEFAULT_SPACES_URL
 *
 * Only an origin: `https`, or `http` on this computer (a test server). A sign-in token rides on every call, so a
 * plain-http address anywhere else is never used. The default is a placeholder that resolves nowhere (`.invalid` is
 * reserved for that): until a real address is set, nothing can leave this computer.
 */
import { loadConfig, resolveSharingEnabled, type PlannotatorConfig } from "../config";

export const DEFAULT_SPACES_URL = "https://spaces.invalid";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True for an address on this computer. */
export function isLoopbackSpacesUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** An origin Spaces may be reached at, or null: not a URL, not http(s), or plain http to another machine. */
export function normalizeSpacesUrl(input: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname))) return null;
  return `${parsed.protocol}//${parsed.host}`;
}

/** The Spaces origin. An empty or unusable value falls back to the next one, never breaking a launch. */
export function resolveSpacesUrl(config: PlannotatorConfig = loadConfig({ quiet: true }), env: NodeJS.ProcessEnv = process.env): string {
  for (const raw of [env.PLANNOTATOR_SPACES_URL, config.spacesUrl]) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const normalized = normalizeSpacesUrl(raw);
    if (normalized) return normalized;
  }
  return DEFAULT_SPACES_URL;
}

/**
 * Share this space is on: config.json `inboxSpaceShare` is `true` and sharing is not turned off
 * (`PLANNOTATOR_SHARE=disabled`). Read on every request, quietly.
 */
export function spaceShareOn(config: PlannotatorConfig = loadConfig({ quiet: true }), env: NodeJS.ProcessEnv = process.env): boolean {
  return config.inboxSpaceShare === true && resolveSharingEnabled(config, env);
}
