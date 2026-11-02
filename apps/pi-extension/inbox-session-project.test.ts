/**
 * PLANNOTATOR_SESSION_PROJECT on Pi: before each bash call the extension
 * names the session's project (`pi:<session id>:<ctx.cwd>`) in the
 * environment Pi gives that call, so `cd sub && plannotator inbox call …`
 * files where the session's `plannotator_inbox` tool does (ctx.cwd), not in
 * the folder the command cd'd to. Driven through the real extension over a
 * fake Pi, then the real `inbox call` command against a real Inbox in a temp
 * data dir. What can regress: no value, a value naming the session Pi had
 * before a switch, or the command filing in the cd'd folder.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";
import { setPiHost } from "./pi-host.ts";
import { INBOX_BRIDGE_POLL_PATH } from "./generated/inbox/connection.ts";
import { startInboxServer } from "../../packages/server/inbox.ts";
import { runInboxCallCommand } from "../hook/server/inbox-call-command.ts";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AGENT_TOOL", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_SESSION_PROJECT", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
const stops: (() => Promise<void> | void)[] = [];

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pi-session-project-")));
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
	process.env.PLANNOTATOR_AGENT_TOOL = "0";
	process.env.PLANNOTATOR_INBOX_TOOL = "1";
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	delete process.env.PLANNOTATOR_SESSION_PROJECT;
});

afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	setPiHost("pi");
	rmSync(root, { recursive: true, force: true });
});

/** The real extension on a fake Pi in `cwd`, its Inbox a recorder; returns a bash tool_call as Pi raises it. */
async function startPi(cwd: string, sessionId: () => string) {
	const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
	mkdirSync(join(dataDir, "inbox"), { recursive: true });
	const inbox = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === INBOX_BRIDGE_POLL_PATH) return Response.json({ commands: [] });
			if (url.pathname === "/mcp") {
				return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "send_message", description: "Send.", inputSchema: { type: "object", properties: {} } }] } });
			}
			return Response.json({ serverSession: "srv" });
		},
	});
	writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ v: 1, pid: process.pid, port: inbox.port, token: "t".repeat(40), serverSession: "srv", url: `http://127.0.0.1:${inbox.port}` }));
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: sessionId, getSessionFile: () => null, getSessionName: () => undefined },
		ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined, theme: { bold: (t: string) => t, fg: (_c: string, t: string) => t, strikethrough: (t: string) => t } },
	};
	const pi = {
		events: { on: () => () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: () => undefined,
		registerTool: () => undefined,
		getFlag: () => false,
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getCommands: () => [],
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
	};
	await plannotator(pi as never, { hasPlanBrowserHtml: () => true, hasReviewBrowserHtml: () => true } as never);
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	stops.push(async () => {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
		await inbox.stop(true);
	});
	return {
		bash: async () => {
			for (const handler of handlers.get("tool_call") ?? []) await handler({ toolName: "bash", toolCallId: "call-1", input: { command: "ls" } }, ctx);
		},
	};
}

describe("Pi: the session's project in its bash calls", () => {
	test("a bash call carries the session's project; a cd in the command does not move where `inbox call` files", async () => {
		const top = join(root, "top");
		const repo = join(top, "repo");
		mkdirSync(repo, { recursive: true });
		const git = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "init", "-q"], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
		expect(git.exitCode).toBe(0);
		let session = "ses-pi-one";
		const pi = await startPi(top, () => session);
		await pi.bash();
		expect(process.env.PLANNOTATOR_SESSION_PROJECT).toBe(`pi:ses-pi-one:${top}`);
		// /new or /resume: the next bash call names the session Pi has now.
		session = "ses-pi-two";
		await pi.bash();
		expect(process.env.PLANNOTATOR_SESSION_PROJECT).toBe(`pi:ses-pi-two:${top}`);

		// `cd repo && plannotator inbox call send_message …`: Pi's bash environment is this process's plus PI_SESSION_ID.
		const server = await startInboxServer({ dataDir: join(root, "inbox-data"), phones: false });
		stops.push(() => server.stop());
		let out = "";
		let err = "";
		const code = await runInboxCallCommand(["send_message", JSON.stringify({ body: "From a bash call that cd'd into the repository." })], {
			cwd: repo,
			env: { PI_SESSION_ID: session, PLANNOTATOR_SESSION_PROJECT: process.env.PLANNOTATOR_SESSION_PROJECT },
			ensureRunning: async () => ({ port: server.port }) as InboxRegistryEntry,
			out: (text) => void (out += text),
			err: (text) => void (err += text),
		});
		expect(err).toBe("");
		expect(code).toBe(0);
		const id = /"message_id":"(msg_[^"]+)"/.exec(out)?.[1];
		const message = server.store.message(id!)!;
		expect(server.store.project(message.project_id)!.root).toBe(top);
		expect(message.author).toMatchObject({ host: "pi", session: "ses-pi-two" });
	}, 30_000);
});
