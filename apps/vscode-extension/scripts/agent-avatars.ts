/**
 * The agents' avatars in the "Ask the agent" question box: each agent's own mark from
 * packages/ui/components/icons/AgentIcons.tsx (the marks the web app shows), on a 32×32 tile so
 * a mark drawn in `currentColor` reads on light and dark themes. Written to `images/agents/`;
 * `agent-avatars.test.ts` fails when a mark there changed and these files were not rebuilt:
 *
 *   bun scripts/agent-avatars.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const AGENT_ICONS_SOURCE = join(import.meta.dir, "..", "..", "..", "packages", "ui", "components", "icons", "AgentIcons.tsx");
export const AVATAR_DIR = join(import.meta.dir, "..", "images", "agents");

/** The `<svg>` body (viewBox and inner markup) of one icon component. */
function svgOf(source: string, component: string): { viewBox: string; inner: string } {
  const start = source.indexOf(`export function ${component}(`);
  if (start < 0) throw new Error(`${component} is not in AgentIcons.tsx`);
  const svg = source.slice(start).match(/<svg viewBox="([^"]+)"[^>]*>([\s\S]*?)<\/svg>/);
  if (!svg) throw new Error(`${component} has no <svg>`);
  // JSX to SVG: opacity={0.4} -> opacity="0.4".
  const inner = svg[2].replace(/(\w+)=\{([^}]+)\}/g, '$1="$2"').replace(/\s+/g, " ").trim();
  return { viewBox: svg[1], inner };
}

/** `recolor`: a one-color mark (Claude's is drawn in its own orange) is drawn in `color`. */
function tile(background: string, mark: { viewBox: string; inner: string }, color: string, pad = 6, recolor = false): string {
  const size = 32 - pad * 2;
  const inner = (recolor ? mark.inner.replace(/fill="[^"]*"/g, `fill="${color}"`) : mark.inner).replace(/currentColor/g, color);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${background}"/><svg x="${pad}" y="${pad}" width="${size}" height="${size}" viewBox="${mark.viewBox}" fill="${color}">${inner}</svg></svg>\n`;
}

/** File name → contents, by agent id. */
export function buildAgentAvatars(source: string): Record<string, { file: string; content: string | Buffer }> {
  const codex = source.match(/const CODEX_DATA_URI =\s*"data:image\/png;base64,([^"]+)"/);
  if (!codex) throw new Error("CODEX_DATA_URI is not in AgentIcons.tsx");
  return {
    "claude-code": { file: "claude-code.svg", content: tile("#D97757", svgOf(source, "ClaudeIcon"), "#FFFFFF", 5, true) },
    codex: { file: "codex.png", content: Buffer.from(codex[1], "base64") },
    pi: { file: "pi.svg", content: tile("#FFFFFF", svgOf(source, "PiIcon"), "#000000", 4) },
    copilot: { file: "copilot.svg", content: tile("#24292F", svgOf(source, "CopilotIcon"), "#FFFFFF", 6) },
    cursor: { file: "cursor.svg", content: tile("#000000", svgOf(source, "CursorIcon"), "#FFFFFF", 0) },
    opencode: { file: "opencode.svg", content: tile("#211E1E", svgOf(source, "OpenCodeIcon"), "#FFFFFF", 8) },
  };
}

if (import.meta.main) {
  mkdirSync(AVATAR_DIR, { recursive: true });
  for (const [id, a] of Object.entries(buildAgentAvatars(readFileSync(AGENT_ICONS_SOURCE, "utf8")))) {
    writeFileSync(join(AVATAR_DIR, a.file), a.content);
    console.log(`${id}: images/agents/${a.file}`);
  }
}
