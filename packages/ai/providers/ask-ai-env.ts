/**
 * The environment of every agent process Ask AI starts (Claude, Codex,
 * OpenCode, Pi, Qwen Code): the live env with Plannotator's own integration
 * switched off inside it.
 *
 * Ask AI drives an agent headlessly, and that agent loads the person's
 * configuration, Plannotator's integration included: the Inbox MCP server
 * (`plannotator inbox mcp`), the agent tool, and the plan hooks (Claude Code's
 * ExitPlanMode PermissionRequest, the Codex Stop hook, Qwen Code's
 * exit_plan_mode). Left on, a question could post to the person's Inbox or
 * block on a plan review nobody is waiting for. So the child gets:
 *
 *  - `PLANNOTATOR_INBOX_TOOL=0` and `PLANNOTATOR_AGENT_TOOL=0`: the switches
 *    the Claude Code mod, the OpenCode plugin and the Pi extension already
 *    read, and which win over config.json (`resolveInboxTool` /
 *    `resolveAgentTool` in packages/shared/config.ts).
 *  - `PLANNOTATOR_ASK_AI_CHILD=1`: the marker the rest honours
 *    (`isAskAiChild` in packages/shared/child-env.ts): the Inbox MCP shim
 *    lists no tools, the plan-review hook (`plannotator` with no arguments)
 *    exits 0 at once, and the OpenCode plugin stands down.
 *
 * Codex does not pass the env to a stdio MCP server, so codex-app-server.ts
 * also turns the Inbox server off by config (`codexAskAiConfigArgs`, below).
 * Claude sessions disallow it by name (claude-agent-sdk.ts).
 *
 * The review server's agent jobs (code review, Code Tour, Guided Review,
 * `agent-jobs.ts` in both runtimes) get the same env and, for `codex exec`,
 * the same `-c` override: none of them uses Plannotator's integration (each
 * returns its result on stdout or in its `-o` file).
 *
 * Bun-free and Node-safe: vendored into the Pi extension.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The marker's name. Only the exact value "1" counts. */
export const ASK_AI_CHILD_ENV = "PLANNOTATOR_ASK_AI_CHILD";

/** What `askAiChildEnv` lays over the env it copies. */
export const ASK_AI_CHILD_SWITCHES: Readonly<Record<string, string>> = {
	PLANNOTATOR_INBOX_TOOL: "0",
	PLANNOTATOR_AGENT_TOOL: "0",
	[ASK_AI_CHILD_ENV]: "1",
};

/** A copy of `env` (default: the LIVE process.env) with Plannotator's integration off. */
export function askAiChildEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
	return { ...env, ...ASK_AI_CHILD_SWITCHES };
}

/**
 * Run `start` with `ASK_AI_CHILD_SWITCHES` set on process.env, and put
 * process.env back before returning. Only for a spawn API that takes no env
 * and copies process.env synchronously inside the call: the OpenCode SDK's
 * `createOpencodeServer` (its `cross-spawn` call with `{ ...process.env }`
 * comes before its first await). JavaScript runs one call at a time, so no
 * other code, a concurrent Ask AI start included, sees the change.
 * `ask-ai-env.test.ts` runs the installed SDK against a fake `opencode` to
 * keep that true.
 */
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

/** The Inbox MCP server Plannotator connects to Codex (`INBOX_MCP_SERVER_NAME` in packages/server/inbox-agents.ts). */
const CODEX_INBOX_SERVER = "plannotator-inbox";

/**
 * The global `-c` override every `codex app-server` that Ask AI starts gets,
 * and every `codex exec` agent job of the review server (code review, Code
 * Tour, Guided Review). It turns off the Inbox MCP server. The marker in the
 * agent's env (`askAiChildEnv`) cannot do this, because Codex starts a stdio MCP server with
 * a cleared environment that holds only HOME, PATH and a few others
 * (codex-rs/rmcp-client `create_env_for_mcp_server`). Codex hooks get the
 * whole env, so the Stop hook does see the marker.
 *
 * Codex deep-merges `-c` tables over config.toml and then rejects an entry
 * that has both `command` and `url`, or neither. So:
 *  - the person's entry has a `url` (the HTTP transport): only
 *    `enabled=false`, because the entry already has its transport;
 *  - otherwise: a whole disabled stdio server. It is merged over a stdio entry,
 *    or added when there is none. Its own `env` carries the marker, so a Codex
 *    that ignored `enabled` would still start a shim that lists no tools.
 * `configTexts` is every config.toml Codex merges for the run
 * (`readCodexConfigTexts`): a `url` in any of them, the person's or the
 * project's, picks the first form. Gap, not handled (rare): Codex ignores the
 * config of a project it does not trust, so a `url` entry only there, with no
 * entry in `$CODEX_HOME`, leaves `enabled=false` with no transport, and Codex
 * (without `--strict-config`) warns "Invalid configuration; using defaults."
 * and runs that session or job on its default config. Literal strings and no
 * spaces: the argument stays unquoted on the cmd.exe line of a Windows `.cmd`
 * shim.
 */
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

/**
 * The config.toml files Codex reads for a run in `cwd`, read only, the
 * unreadable ones left out: `$CODEX_HOME/config.toml` (a relative CODEX_HOME
 * resolved against `cwd`, as Codex does; else `~/.codex`), then the
 * `.codex/config.toml` of each folder from `cwd` up to the project root, the
 * nearest folder with a `.git` (a folder holding `HEAD`, or a worktree's
 * file). With no root, only `cwd`'s. The `.codex` that is CODEX_HOME is not
 * read twice. This is Codex's own walk (codex-rs/config `discover_project_root`
 * and `discover_project_layers`), with its default `project_root_markers`.
 */
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

/** Whether `dir` holds a `.git` that Codex takes as the project root marker. */
function isGitRoot(dir: string): boolean {
  try {
    const git = statSync(join(dir, ".git"));
    return git.isFile() || (git.isDirectory() && existsSync(join(dir, ".git", "HEAD")));
  } catch {
    return false;
  }
}

/** A TOML key (`a."b-c".d`) as its parts; null when the text is not a plain key. */
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

/** The first key of each top-level member of an inline table (`{ url = "…", env = { … } }`). */
function inlineTableKeys(value: string): string[] {
  let inner = value.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').trim();
  if (!inner.startsWith("{")) return [];
  const close = inner.lastIndexOf("}");
  inner = inner.slice(1, close < 0 ? undefined : close);
  // Drop nested tables and arrays, innermost first, so only top-level members remain.
  const nested = /[{[][^{}[\]]*[}\]]/;
  while (nested.test(inner)) inner = inner.replace(new RegExp(nested.source, "g"), "");
  return inner
    .split(",")
    .map((member) => tomlKeyPath(member.slice(0, Math.max(0, member.indexOf("="))))?.[0])
    .filter((key): key is string => key !== undefined);
}

/**
 * Whether config.toml's `mcp_servers.plannotator-inbox` has a `url`, in any
 * form: its `[mcp_servers.plannotator-inbox]` table, an inline table, or
 * dotted keys. A line scan, not a full TOML parser: something it cannot read
 * counts as no `url`.
 */
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
