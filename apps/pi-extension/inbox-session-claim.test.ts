import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiSessionClaims } from "./generated/inbox/pi-session-claim.ts";
import { setupPiInbox } from "./inbox.ts";

const saved = { ...process.env };
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const undo of cleanup.splice(0)) undo();
	for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL"]) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
});

function fakePi() {
	const handlers = new Map<string, ((event: unknown, ctx?: unknown) => unknown)[]>();
	let sessionId = "";
	const ctx = { hasUI: true, cwd: "/tmp", sessionManager: { getSessionId: () => sessionId, getBranch: () => [] } };
	return {
		pi: {
			on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerTool: () => {},
			sendUserMessage: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
		},
		start(id: string) {
			sessionId = id;
			for (const handler of handlers.get("session_start") ?? []) handler({}, ctx);
		},
		shutdown() {
			for (const handler of handlers.get("session_shutdown") ?? []) handler({}, ctx);
		},
	};
}

function dataDirWithInbox(): string {
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-claim-"));
	cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
	mkdirSync(join(dataDir, "inbox"), { recursive: true });
	writeFileSync(join(dataDir, "inbox", "inbox.json"), "{}");
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	return dataDir;
}

describe("the Pi extension's session claim", () => {
	test("with the Inbox tool off, a session is claimed as it starts, moved on /new, and released as it ends", () => {
		const dataDir = dataDirWithInbox();
		process.env.PLANNOTATOR_INBOX_TOOL = "0";
		const one = fakePi();
		expect(setupPiInbox(one.pi as never, { isAskActive: () => false })).toBeUndefined();
		one.start("session-a");
		expect(readPiSessionClaims(dataDir)).toMatchObject([{ session: "session-a", pid: process.pid, rpc: false, title: process.title }]);
		one.shutdown();
		one.start("session-b");
		expect(readPiSessionClaims(dataDir).map((claim) => claim.session)).toEqual(["session-b"]);
		one.shutdown();
		expect(readPiSessionClaims(dataDir)).toEqual([]);
	});

	test("a /reload's new instance keeps its claim when the old one shuts down after it started", () => {
		const dataDir = dataDirWithInbox();
		process.env.PLANNOTATOR_INBOX_TOOL = "0";
		const old = fakePi();
		setupPiInbox(old.pi as never, { isAskActive: () => false });
		old.start("session-a");
		const reloaded = fakePi();
		setupPiInbox(reloaded.pi as never, { isAskActive: () => false });
		reloaded.start("session-a");
		old.shutdown();
		expect(readPiSessionClaims(dataDir).map((claim) => claim.session)).toEqual(["session-a"]);
	});
});
