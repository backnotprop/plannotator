/**
 * The Inbox tool, and with it the reply wake, is on by default in Oh My Pi
 * (resolvePiInboxTool). OMP loads this extension as a plugin, but nothing
 * writes `inboxTool.pi` for it (the Inbox's connect step finds the extension
 * only in Pi's own settings.json), so with Pi's default (off) an OMP session
 * had no `plannotator_inbox` tool and nothing polled for its replies: a
 * person's reply never woke it. Driven through setupPiInbox over a fake host,
 * against a fake Inbox that records the wake's polls. The failures this
 * catches: OMP back on Pi's default, Pi's default changed with it, and the
 * person's own switch (config or env) no longer deciding in OMP.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPiInbox } from "./inbox.ts";
import { setPiHost } from "./pi-host.ts";
import { INBOX_BRIDGE_POLL_PATH } from "./generated/inbox/connection.ts";

const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of KEYS) saved[key] = process.env[key];
const ends: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const end of ends.splice(0)) await end();
	setPiHost("pi");
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

/** A data dir whose Inbox is a recorder: its tool list for discovery, and every wake poll. */
function fakeInbox(config?: Record<string, unknown>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-omp-tool-")));
	const dataDir = join(root, "data");
	mkdirSync(join(dataDir, "inbox"), { recursive: true });
	if (config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
	const polls: Record<string, unknown>[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === INBOX_BRIDGE_POLL_PATH) {
				polls.push((await req.json()) as Record<string, unknown>);
				return Response.json({ commands: [] });
			}
			if (url.pathname === "/mcp") {
				return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "send_message", description: "Send.", inputSchema: { type: "object", properties: {} } }] } });
			}
			return Response.json({ serverSession: "srv" });
		},
	});
	writeFileSync(
		join(dataDir, "inbox", "inbox.json"),
		JSON.stringify({ v: 1, pid: process.pid, port: server.port, token: "t".repeat(40), serverSession: "srv", url: `http://127.0.0.1:${server.port}` }),
	);
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	delete process.env.PLANNOTATOR_INBOX_TOOL;
	ends.push(async () => {
		await server.stop(true);
		rmSync(root, { recursive: true, force: true });
	});
	return { polls };
}

/** Pi's ExtensionAPI, or Oh My Pi's (it carries `arktype` and `pi`, which pi-host.ts reads), and one interactive session. */
function fakeHost(ohMyPi: boolean) {
	const handlers = new Map<string, ((event: unknown, ctx?: unknown) => unknown)[]>();
	const tools: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: tmpdir(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "omp-session-1", getBranch: () => [], getSessionName: () => undefined },
		ui: { notify: () => {} },
	};
	const pi = {
		...(ohMyPi ? { arktype: () => undefined, pi: {} } : {}),
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (definition: { name: string }) => {
			tools.push(definition.name);
		},
		getActiveTools: () => [] as string[],
		setActiveTools: () => {},
		sendUserMessage: () => {},
	};
	const emit = (event: string) => {
		for (const handler of handlers.get(event) ?? []) handler({}, ctx);
	};
	return { pi, tools, emit };
}

async function load(ohMyPi: boolean) {
	if (ohMyPi) setPiHost("oh-my-pi");
	const host = fakeHost(ohMyPi);
	await setupPiInbox(host.pi as never, { isAskActive: () => false });
	host.emit("session_start");
	ends.unshift(() => host.emit("session_shutdown"));
	return host;
}

async function until(what: string, check: () => boolean): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await Bun.sleep(25);
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("the Inbox tool's default in Oh My Pi", () => {
	test("with nothing set, an OMP session gets the tool and its replies are polled for", async () => {
		const { polls } = fakeInbox();
		const host = await load(true);
		expect(host.tools).toEqual(["plannotator_inbox"]);
		await until("the wake's first poll", () => polls.length > 0);
		expect(polls[0]!.session).toBe("omp-session-1");
	});

	test("Pi keeps its default: no tool, nothing polls", async () => {
		const { polls } = fakeInbox();
		const host = await load(false);
		await Bun.sleep(300);
		expect(host.tools).toEqual([]);
		expect(polls).toEqual([]);
	});

	test("the person's switch still decides in OMP: inboxTool.pi false, or PLANNOTATOR_INBOX_TOOL=0", async () => {
		const off = fakeInbox({ inboxTool: { pi: false } });
		const fromConfig = await load(true);
		await Bun.sleep(300);
		expect(fromConfig.tools).toEqual([]);
		expect(off.polls).toEqual([]);

		const env = fakeInbox();
		process.env.PLANNOTATOR_INBOX_TOOL = "0";
		const fromEnv = await load(true);
		await Bun.sleep(300);
		expect(fromEnv.tools).toEqual([]);
		expect(env.polls).toEqual([]);
	});

	test("OMP's default never turns the Inbox on: with the Inbox off here (turned-on.ts), no tool and nothing polls", async () => {
		const { polls } = fakeInbox();
		// The mark the gate reads, saying off (packages/shared/inbox/turned-on.ts).
		writeFileSync(join(process.env.PLANNOTATOR_DATA_DIR!, "inbox", "turned-on"), JSON.stringify({ on: false }));
		const host = await load(true);
		await Bun.sleep(300);
		expect(host.tools).toEqual([]);
		expect(polls).toEqual([]);
	});
});
