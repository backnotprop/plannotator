/**
 * Every agent process Ask AI starts carries Plannotator's integration off
 * (ask-ai-env.ts), checked against fake CLIs that record what they were
 * started with. No real agent CLI ever runs. Pi and Qwen Code are checked in
 * their own provider tests (pi-sdk-models.test.ts, qwen-sdk.test.ts), the
 * OpenCode provider's call in opencode-sdk.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createOpencodeServer } from "@opencode-ai/sdk/server";
import { isAskAiChild } from "../../shared/child-env.ts";
import { askAiChildEnv, withAskAiChildEnv } from "./ask-ai-env.ts";
import { ClaudeAgentSDKProvider } from "./claude-agent-sdk.ts";
import { CodexAppServerProvider, codexAskAiConfigArgs, readCodexConfigTexts } from "./codex-app-server.ts";

const dir = mkdtempSync(join(tmpdir(), "plannotator-ask-ai-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posix = process.platform !== "win32";

/** The switches as a fake saw them: `KEY=value` lines its shell wrote. */
function switchesIn(file: string): Record<string, string> {
	if (!existsSync(file)) return {};
	return Object.fromEntries(
		readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

/** A shell prelude that records the three switches in `file`. */
function recordSwitches(file: string): string {
	return [
		`printf 'PLANNOTATOR_ASK_AI_CHILD=%s\\n' "$PLANNOTATOR_ASK_AI_CHILD" >> '${file}'`,
		`printf 'PLANNOTATOR_INBOX_TOOL=%s\\n' "$PLANNOTATOR_INBOX_TOOL" >> '${file}'`,
		`printf 'PLANNOTATOR_AGENT_TOOL=%s\\n' "$PLANNOTATOR_AGENT_TOOL" >> '${file}'`,
	].join("\n");
}

const OFF = { PLANNOTATOR_ASK_AI_CHILD: "1", PLANNOTATOR_INBOX_TOOL: "0", PLANNOTATOR_AGENT_TOOL: "0" };

function fakeCli(name: string, body: string): string {
	const path = join(dir, `${name}-${Math.random().toString(36).slice(2)}`);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

describe("the marker the integrations read", () => {
	test("is set by askAiChildEnv and read only as the exact value 1", () => {
		expect(isAskAiChild(askAiChildEnv({}))).toBe(true);
		expect(isAskAiChild({})).toBe(false);
		for (const value of ["", "0", "true", "yes", " 1", "1 "]) {
			expect(isAskAiChild({ PLANNOTATOR_ASK_AI_CHILD: value })).toBe(false);
		}
	});
});

/** A fake `codex app-server`: answers initialize and model/list. */
function fakeCodex(envFile: string, argvFile: string): string {
	const script = join(dir, "fake-codex-app-server.mjs");
	writeFileSync(
		script,
		`let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    const result = msg.method === "initialize"
      ? { userAgent: "plannotator/0.160.0 (Linux)" }
      : { data: [{ id: "gpt-6-sol", displayName: "GPT-6-Sol", isDefault: true }] };
    process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");
  }
});
`,
	);
	return fakeCli(
		"codex",
		[
			"#!/bin/sh",
			recordSwitches(envFile),
			`printf 'RUN %s\\n' "$*" >> '${argvFile}'`,
			`exec '${process.execPath}' '${script}'`,
		].join("\n") + "\n",
	);
}

/** The runs a fake codex logged: one argv line each. */
function codexRuns(argvFile: string): string[] {
	return existsSync(argvFile) ? readFileSync(argvFile, "utf8").split("\n").filter(Boolean).map((line) => line.slice(4)) : [];
}

/** Run `fn` with CODEX_HOME at a temp folder holding `config` (never the real ~/.codex), and the env keys in `extra`. */
async function inCodexSandbox(config: string | null, extra: Record<string, string>, fn: () => Promise<void>): Promise<void> {
	const home = mkdtempSync(join(dir, "codex-home-"));
	if (config !== null) writeFileSync(join(home, "config.toml"), config);
	const keys = ["CODEX_HOME", ...Object.keys(extra)];
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.CODEX_HOME = home;
	Object.assign(process.env, extra);
	try {
		await fn();
	} finally {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

/** Deep-merge `overlay` into `base`, table into table, as Codex merges a `-c` layer over config.toml. */
function mergeTables(base: Record<string, unknown>, overlay: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(overlay)) {
		const existing = base[key];
		if (value && typeof value === "object" && !Array.isArray(value) && existing && typeof existing === "object" && !Array.isArray(existing)) {
			mergeTables(existing as Record<string, unknown>, value as Record<string, unknown>);
		} else {
			base[key] = value;
		}
	}
}

/** The `plannotator-inbox` entry Codex would build from `config` (one file, or the person's then the project's) plus the override Ask AI chooses for it. */
function inboxEntryAfterOverride(config: string | null | string[]): Record<string, unknown> | undefined {
	const [flag, override] = codexAskAiConfigArgs(config);
	expect(flag).toBe("-c");
	const eq = override!.indexOf("=");
	const layer: Record<string, unknown> = {};
	let at = layer;
	const path = override!.slice(0, eq).split(".");
	for (const part of path.slice(0, -1)) at = (at[part] = {}) as Record<string, unknown>;
	at[path.at(-1)!] = (Bun.TOML.parse(`v = ${override!.slice(eq + 1)}`) as { v: unknown }).v;
	const merged: Record<string, unknown> = {};
	for (const text of config === null ? [] : typeof config === "string" ? [config] : config) {
		mergeTables(merged, Bun.TOML.parse(text) as Record<string, unknown>);
	}
	mergeTables(merged, layer);
	return (merged.mcp_servers as Record<string, Record<string, unknown>> | undefined)?.["plannotator-inbox"];
}

describe("Codex: `codex app-server`", () => {
	// Codex rejects an MCP entry with both `command` and `url`, or neither, and
	// then the whole config: app-server would not start at all.
	test("the override leaves a valid, disabled Inbox entry over a stdio entry, a url entry (any form) and no entry", () => {
		const configs: Record<string, string | null> = {
			"no config.toml": null,
			"no entry": `model = "gpt-6-sol"\n\n[mcp_servers.other]\ncommand = "other"\n`,
			"stdio entry": `[mcp_servers.plannotator-inbox]\ncommand = "/opt/bin/plannotator"\nargs = ["inbox", "mcp"]\nenv = { HTTP_PROXY = "x", url = "not-the-transport" }\nstartup_timeout_sec = 20\nenabled_tools = ["send_message"]\n`,
			"url entry, its table": `[mcp_servers."plannotator-inbox"]\nurl = "http://127.0.0.1:59812/mcp"  # the Inbox\nstartup_timeout_sec = 20\n`,
			"url entry, inline": `[mcp_servers]\nplannotator-inbox = { url = "http://127.0.0.1:59812/mcp", http_headers = { a = "b" } }\n`,
			"url entry, dotted": `mcp_servers.plannotator-inbox.url = "http://127.0.0.1:59812/mcp"\n`,
		};
		for (const [name, config] of Object.entries(configs)) {
			const entry = inboxEntryAfterOverride(config);
			expect({ name, enabled: entry?.enabled, transports: ["command", "url"].filter((key) => entry && key in entry).length }).toEqual({
				name,
				enabled: false,
				transports: 1,
			});
		}
	});

	test("a url entry in a project's .codex/config.toml gets only enabled=false", () => {
		const person = `model = "gpt-6-sol"\n\n[mcp_servers.other]\ncommand = "other"\n`;
		const projectUrl = `[mcp_servers.plannotator-inbox]\nurl = "http://127.0.0.1:59812/mcp"\n`;
		for (const [name, configs] of Object.entries({ "person's config, project's url": [person, projectUrl], "project's url only": [projectUrl] })) {
			const entry = inboxEntryAfterOverride(configs);
			expect({ name, enabled: entry?.enabled, transports: ["command", "url"].filter((key) => entry && key in entry).length }).toEqual({
				name,
				enabled: false,
				transports: 1,
			});
		}
	});

	test("reads $CODEX_HOME's config and each .codex/config.toml from cwd up to the git root, as Codex does", () => {
		const root = mkdtempSync(join(dir, "codex-walk-"));
		const write = (folder: string, text: string) => {
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, "config.toml"), text);
		};
		const home = join(root, "codex-home");
		write(home, "# home");
		write(join(root, ".codex"), "# above the root");
		mkdirSync(join(root, "repo", ".git"), { recursive: true });
		writeFileSync(join(root, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
		write(join(root, "repo", ".codex"), "# repo");
		write(join(root, "repo", "sub", ".codex"), "# sub");
		expect(readCodexConfigTexts(join(root, "repo", "sub"), { CODEX_HOME: home })).toEqual(["# home", "# sub", "# repo"]);
		// The .codex that is CODEX_HOME is read once.
		expect(readCodexConfigTexts(join(root, "repo"), { CODEX_HOME: join(root, "repo", ".codex") })).toEqual(["# repo"]);
		// No git root above: only cwd's own .codex.
		write(join(root, "loose", ".codex"), "# loose");
		write(join(root, "loose", "sub", ".codex"), "# loose sub");
		expect(readCodexConfigTexts(join(root, "loose", "sub"), { CODEX_HOME: home })).toEqual(["# home", "# loose sub"]);
	});

	test.if(posix)("runs with the switches in its env and the override before `app-server`", async () => {
		const envFile = join(dir, "codex-env.txt");
		const argvFile = join(dir, "codex-argv.txt");
		const provider = new CodexAppServerProvider({ type: "codex-sdk", codexExecutablePath: fakeCodex(envFile, argvFile) });
		await inCodexSandbox(null, {}, async () => {
			try {
				await provider.fetchModels();
			} finally {
				provider.dispose();
			}
		});
		expect(switchesIn(envFile)).toEqual(OFF);
		const runs = codexRuns(argvFile);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.startsWith("-c mcp_servers.plannotator-inbox=")).toBe(true);
		expect(runs[0]!.endsWith(" app-server")).toBe(true);
	}, 15_000);

});

describe("Claude: the Agent SDK's `claude`", () => {
	test.if(posix)("runs with the switches in its env and the Inbox MCP server disallowed", async () => {
		const envFile = join(dir, "claude-env.txt");
		const argvFile = join(dir, "claude-argv.txt");
		// Records its env and argv and exits, so the session ends with an error.
		const claude = fakeCli("claude", `#!/bin/sh\n${recordSwitches(envFile)}\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\nexit 1\n`);
		const provider = new ClaudeAgentSDKProvider({ type: "claude-agent-sdk", cwd: dir, claudeExecutablePath: claude });
		const session = await provider.createSession({ context: { mode: "plan-review", plan: { plan: "# Plan" } } });
		for await (const _ of session.query("hello")) {
			// Drain until the fake exits.
		}
		expect(switchesIn(envFile)).toEqual(OFF);
		// The whole server, whatever its transport (an HTTP entry never runs the shim).
		const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
		const at = argv.findIndex((a) => a === "--disallowedTools" || a.startsWith("--disallowedTools="));
		expect(at).toBeGreaterThanOrEqual(0);
		const value = argv[at]!.includes("=") ? argv[at]!.slice(argv[at]!.indexOf("=") + 1) : argv[at + 1]!;
		expect(value.split(",")).toContain("mcp__plannotator-inbox");
	}, 15_000);
});

describe("OpenCode: the installed SDK's createOpencodeServer", () => {
	// The SDK takes no env; withAskAiChildEnv relies on it copying process.env
	// synchronously inside the call. This runs the real SDK, not a mock.
	test.if(posix)("copies the switches into `opencode serve`, and process.env is back as it was when the call returns", async () => {
		const binDir = mkdtempSync(join(dir, "bin-"));
		const envFile = join(dir, "opencode-env.txt");
		writeFileSync(
			join(binDir, "opencode"),
			`#!/bin/sh\n${recordSwitches(envFile)}\necho "opencode server listening on http://127.0.0.1:4999"\nexec sleep 30\n`,
		);
		chmodSync(join(binDir, "opencode"), 0o755);
		const saved = { PATH: process.env.PATH, marker: process.env.PLANNOTATOR_ASK_AI_CHILD };
		process.env.PATH = `${binDir}${delimiter}${saved.PATH ?? ""}`;
		delete process.env.PLANNOTATOR_ASK_AI_CHILD;
		let server: { url: string; close(): void } | undefined;
		try {
			const starting = withAskAiChildEnv(() => createOpencodeServer({ hostname: "127.0.0.1", port: 0, timeout: 10_000 }));
			// Restored before the server is even up: no other code sees the switches.
			expect(process.env.PLANNOTATOR_ASK_AI_CHILD).toBeUndefined();
			server = await starting;
			expect(server.url).toBe("http://127.0.0.1:4999");
			expect(switchesIn(envFile)).toEqual(OFF);
		} finally {
			server?.close();
			process.env.PATH = saved.PATH;
			if (saved.marker === undefined) delete process.env.PLANNOTATOR_ASK_AI_CHILD;
			else process.env.PLANNOTATOR_ASK_AI_CHILD = saved.marker;
		}
	}, 15_000);

	// Newer `opencode serve` prints this line without the "opencode " prefix.
	test.if(posix)("resolves on the unprefixed `server listening on <url>` line", async () => {
		const binDir = mkdtempSync(join(dir, "bin-"));
		writeFileSync(join(binDir, "opencode"), `#!/bin/sh\necho "server listening on http://127.0.0.1:4999"\nexec sleep 30\n`);
		chmodSync(join(binDir, "opencode"), 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`;
		let server: { url: string; close(): void } | undefined;
		try {
			server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0, timeout: 3_000 });
			expect(server.url).toBe("http://127.0.0.1:4999");
		} finally {
			server?.close();
			process.env.PATH = savedPath;
		}
	}, 15_000);
});
