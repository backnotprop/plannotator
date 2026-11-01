/**
 * Session labels on Pi (approval "inbox-session-label"): "only if someone named
 * the session". Driven through the real extension over a fake host, with an
 * Inbox that records polls. The failures this catches: an unnamed session
 * sending a made-up name, and a rename not reaching the next poll.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";
import { setPiHost } from "./pi-host.ts";
import { INBOX_BRIDGE_POLL_PATH } from "./generated/inbox/connection.ts";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AGENT_TOOL", "PLANNOTATOR_INBOX_TOOL"] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
const stops: (() => Promise<void> | void)[] = [];

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pi-label-")));
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	process.env.HOME = root;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
	process.env.PLANNOTATOR_AGENT_TOOL = "0";
	process.env.PLANNOTATOR_INBOX_TOOL = "1";
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

async function until(what: string, check: () => boolean): Promise<void> {
	for (let i = 0; i < 600; i++) {
		if (check()) return;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The real extension on a fake Pi whose session manager the test controls, polling a recorder. */
async function startPi(sessionManager: Record<string, unknown>) {
	const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
	mkdirSync(join(dataDir, "inbox"), { recursive: true });
	const bodies: Record<string, unknown>[] = [];
	const inbox = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === INBOX_BRIDGE_POLL_PATH) {
				bodies.push((await req.json()) as Record<string, unknown>);
				return Response.json({ commands: [] });
			}
			if (url.pathname === "/mcp") {
				return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "send_message", description: "Send.", inputSchema: { type: "object", properties: {} } }] } });
			}
			return Response.json({ serverSession: "srv" });
		},
	});
	writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ v: 1, pid: process.pid, port: inbox.port, token: "t".repeat(40), serverSession: "srv", url: `http://127.0.0.1:${inbox.port}` }));
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const ctx = {
		cwd: root,
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "ses-pi-label", getSessionFile: () => null, ...sessionManager },
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
	return { bodies };
}

describe("Pi's session name", () => {
	test("a named session sends its name; a later name replaces it on the next poll", async () => {
		let name: string | undefined = "Fix login redirect";
		const { bodies } = await startPi({ getSessionName: () => name });
		await until("a poll with the name", () => bodies.at(-1)?.label === "Fix login redirect");
		name = "Docs pass";
		await until("a poll with the new name", () => bodies.at(-1)?.label === "Docs pass");
	}, 30_000);

	test("an unnamed session sends nothing to show", async () => {
		const { bodies } = await startPi({ getSessionName: () => undefined });
		await until("a poll", () => bodies.length > 0);
		expect(bodies.every((body) => body.label === "")).toBe(true);
	}, 30_000);
});
