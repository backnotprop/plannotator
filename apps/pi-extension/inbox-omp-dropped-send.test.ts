/**
 * Oh My Pi (18.18.2+) returns a promise from `sendUserMessage` that rejects
 * when it drops the message before a turn starts (a turn began between the
 * wake's idle check and the send). That passes, so the reply must wait and go
 * in at the next idle tick, not be reported as undeliverable. A host that
 * keeps dropping it gets it reported after a few tries, never a loop. Driven
 * through setupPiInbox over a fake OMP host, against a fake Inbox that hands
 * out one reply until it hears it was delivered.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupPiInbox } from "./inbox.ts";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH } from "./generated/inbox/connection.ts";

const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of KEYS) saved[key] = process.env[key];
const ends: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const end of ends.splice(0)) await end();
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

const REPLY = {
	type: "reply",
	id: "msg_r1",
	thread_id: "thr_1",
	reply_to: "msg_a1",
	subject: "Deploy",
	body: "Retry with the same key.",
	url: "http://127.0.0.1/#thread=thr_1",
};

/** An Inbox that hands out REPLY on every poll until a `delivered` event for it arrives. */
function fakeInbox() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-omp-dropped-")));
	const dataDir = join(root, "data");
	mkdirSync(join(dataDir, "inbox"), { recursive: true });
	const delivered: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (req) => {
			const url = new URL(req.url);
			if (url.pathname === INBOX_BRIDGE_POLL_PATH) {
				const body = (await req.json()) as { waitMs?: number };
				if (delivered.length === 0) return Response.json({ commands: [REPLY] });
				if (body.waitMs) await Bun.sleep(Math.min(body.waitMs, 200));
				return Response.json({ commands: [] });
			}
			if (url.pathname === INBOX_BRIDGE_EVENT_PATH) {
				const body = (await req.json()) as { type?: string; id?: string };
				if (body.type === "delivered" && body.id) delivered.push(body.id);
				return Response.json({ ok: true });
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
	return { delivered };
}

/** Oh My Pi's ExtensionAPI (`arktype` and `pi`), idle; `drops(n)`: whether the n-th send (from 1) is dropped. */
async function ompSession(drops: (n: number) => boolean) {
	const handlers = new Map<string, ((event: unknown, ctx?: unknown) => unknown)[]>();
	const notes: string[] = [];
	const sends: string[] = [];
	const started: string[] = [];
	const ctx = {
		hasUI: true,
		cwd: tmpdir(),
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "omp-session-1", getBranch: () => [], getSessionName: () => undefined },
		ui: { notify: (message: string) => notes.push(message) },
	};
	const emit = (event: string, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const pi = {
		arktype: () => undefined,
		pi: {},
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: () => {},
		getActiveTools: () => [] as string[],
		setActiveTools: () => {},
		sendUserMessage: (text: string) => {
			sends.push(text);
			if (drops(sends.length)) return Promise.reject(new Error("the message was dropped before a turn started"));
			// OMP starts the user message: the wake sees it begin.
			started.push(text);
			emit("message_start", { message: { role: "user", content: text } });
			return Promise.resolve();
		},
	};
	await setupPiInbox(pi as never, { isAskActive: () => false });
	emit("session_start");
	ends.unshift(() => emit("session_shutdown"));
	return { notes, sends, started };
}

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
	for (let at = Date.now(); Date.now() - at < ms; ) {
		if (check()) return;
		await Bun.sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}

test.skipIf(process.platform === "win32")("a send OMP drops once goes in at the next idle tick: delivered once, nothing reported", async () => {
	const inbox = fakeInbox();
	const omp = await ompSession((n) => n === 1);
	await until("the delivery", () => inbox.delivered.length > 0);
	expect(omp.sends).toHaveLength(2);
	expect(omp.started).toHaveLength(1);
	expect(omp.started[0]).toContain("Retry with the same key.");
	expect(inbox.delivered).toEqual(["msg_r1"]);
	expect(omp.notes.filter((note) => note.includes("could not be delivered"))).toEqual([]);
}, 40_000);

test.skipIf(process.platform === "win32")("a send OMP always drops is reported after a few tries, not sent forever", async () => {
	const inbox = fakeInbox();
	const omp = await ompSession(() => true);
	await until("the report", () => omp.notes.some((note) => note.includes("could not be delivered")), 40_000);
	const tries = omp.sends.length;
	expect(tries).toBe(4);
	await Bun.sleep(3_000);
	expect(omp.sends).toHaveLength(tries);
	expect(inbox.delivered).toEqual([]);
}, 60_000);
