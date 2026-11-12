import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ASK_AI_CHILD_ENV = "PLANNOTATOR_ASK_AI_CHILD";

export const ASK_AI_CHILD_SWITCHES: Readonly<Record<string, string>> = {
	PLANNOTATOR_INBOX_TOOL: "0",
	PLANNOTATOR_AGENT_TOOL: "0",
	[ASK_AI_CHILD_ENV]: "1",
};

export function askAiChildEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
	return { ...env, ...ASK_AI_CHILD_SWITCHES };
}

export function withAskAiChildEnv<T>(start: () => T): T {
	const saved = Object.keys(ASK_AI_CHILD_SWITCHES).map((key) => [key, process.env[key]] as const);
	Object.assign(process.env, ASK_AI_CHILD_SWITCHES);
	try {
		return start();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const CODEX_INBOX_SERVER = "plannotator-inbox";

export function codexAskAiConfigArgs(configTexts: string | null | readonly string[]): string[] {
  const texts = configTexts === null ? [] : typeof configTexts === "string" ? [configTexts] : configTexts;
  if (texts.some((text) => codexInboxEntryHasUrl(text))) {
    return ["-c", `mcp_servers.${CODEX_INBOX_SERVER}.enabled=false`];
  }
  return [
    "-c",
    `mcp_servers.${CODEX_INBOX_SERVER}={command='plannotator',args=['inbox','mcp'],env={PLANNOTATOR_ASK_AI_CHILD='1'},enabled=false}`,
  ];
}

export function codexOneShotConfigArgs(configTexts: readonly string[]): string[] {
  const names = new Set<string>();
  for (const text of configTexts) {
    for (const m of text.matchAll(/^\s*\[\s*mcp_servers\.(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*[.\]]/gm)) {
      const name = m[1] ?? m[2] ?? m[3]!;
      if (/^[A-Za-z0-9_-]+$/.test(name)) names.add(name);
    }
  }
  return ["-c", "web_search='disabled'", ...[...names].flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`])];
}

export function readCodexConfigTexts(cwd: string, env: Readonly<Record<string, string | undefined>> = process.env): string[] {
  const start = resolve(cwd);
  const home = env.CODEX_HOME?.trim();
  const codexHome = home ? resolve(start, home) : join(homedir(), ".codex");
  const dirs: string[] = [];
  for (let dir = start; ; dir = dirname(dir)) {
    dirs.push(dir);
    if (isGitRoot(dir)) break;
    if (dirname(dir) === dir) {
      dirs.length = 1;
      break;
    }
  }
  const folders = [codexHome, ...dirs.map((dir) => join(dir, ".codex")).filter((dot) => dot !== codexHome)];
  return folders.flatMap((folder) => {
    try {
      return [readFileSync(join(folder, "config.toml"), "utf8")];
    } catch {
      return [];
    }
  });
}

function isGitRoot(dir: string): boolean {
  try {
    const git = statSync(join(dir, ".git"));
    return git.isFile() || (git.isDirectory() && existsSync(join(dir, ".git", "HEAD")));
  } catch {
    return false;
  }
}

function tomlKeyPath(text: string): string[] | null {
  const part = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    part.lastIndex = at;
    const match = part.exec(text);
    if (!match) return null;
    parts.push(match[1] ?? match[2] ?? match[3]!);
    at = part.lastIndex;
    if (match[4] !== ".") break;
  }
  return parts.length > 0 && at >= text.length ? parts : null;
}

function inlineTableKeys(value: string): string[] {
  let inner = value.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').trim();
  if (!inner.startsWith("{")) return [];
  const close = inner.lastIndexOf("}");
  inner = inner.slice(1, close < 0 ? undefined : close);
  const nested = /[{[][^{}[\]]*[}\]]/;
  while (nested.test(inner)) inner = inner.replace(new RegExp(nested.source, "g"), "");
  return inner
    .split(",")
    .map((member) => tomlKeyPath(member.slice(0, Math.max(0, member.indexOf("="))))?.[0])
    .filter((key): key is string => key !== undefined);
}

export function codexInboxEntryHasUrl(configText: string): boolean {
  let table: string[] = [];
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = tomlKeyPath(header[1]!) ?? [""];
      continue;
    }
    const eq = line.indexOf("=");
    const key = eq > 0 ? tomlKeyPath(line.slice(0, eq)) : null;
    if (!key) continue;
    const path = [...table, ...key];
    if (path[0] !== "mcp_servers" || path[1] !== CODEX_INBOX_SERVER) continue;
    if (path.length > 2 ? path[2] === "url" : inlineTableKeys(line.slice(eq + 1)).includes("url")) return true;
  }
  return false;
}
