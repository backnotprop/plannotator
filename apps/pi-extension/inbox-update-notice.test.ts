import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STABLE_MS, setupAutoReload } from "./auto-reload.ts";

type Notice = typeof import("./inbox.ts").inboxUpdateNotice;
let inboxUpdateNotice: Notice;
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
const STORE_KEYS = ["__plannotatorAutoReload_v1", "__plannotatorUpdateNoticed_v1", "__plannotatorAutoReloadTried_v1"];

beforeAll(async () => {
	process.env.PLANNOTATOR_DATA_DIR = mkdtempSync(join(tmpdir(), "plannotator-inbox-update-notice-"));
	({ inboxUpdateNotice } = await import("./inbox.ts"));
});

afterAll(() => {
	if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
	else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
	for (const key of STORE_KEYS) delete (globalThis as Record<string, unknown>)[key];
});

async function session(enabled: boolean) {
	for (const key of STORE_KEYS) delete (globalThis as Record<string, unknown>)[key];
	let t = 0;
	const notes: string[] = [];
	const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
	const sent: string[] = [];
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		hasPendingMessages: () => false,
		reload: async () => {},
		ui: {
			notify: (message: string) => notes.push(message),
			getEditorText: () => "",
			onTerminalInput: () => () => {},
		},
	};
	const controller = setupAutoReload(
		{
			on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
			registerCommand: (name, spec) => commands.set(name, spec.handler),
			sendUserMessage: (text) => {
				sent.push(String(text));
			},
		},
		{
			host: "pi",
			enabled,
			plannotatorBusy: () => null,
			piVersion: async () => "0.84.4",
			readOnDisk: () => "1.1.0",
			installSettled: () => true,
			loaded: "1.0.0",
			now: () => t,
			poll: false,
		},
	);
	for (const h of handlers.get("session_start") ?? []) h({ reason: "startup" }, ctx);
	await controller.ready;
	return {
		inboxNote: (told: string | null = null) => inboxUpdateNotice("1.0.0", "1.1.0", told, (v) => controller.claimNotice(v), "pi"),
		advance(ms: number) {
			t += ms;
			controller.check();
		},
		runCommand: () => commands.get("plannotator-reload")!("auto", ctx),
		notes,
		sent,
	};
}

describe("inboxUpdateNotice: the Inbox's /reload note", () => {
	test("quiet while Pi will reload by itself, through the whole wait and the reload", async () => {
		const s = await session(true);
		expect(s.inboxNote()).toBeNull();
		s.advance(0);
		s.advance(STABLE_MS);
		expect(s.sent).toHaveLength(1);
		expect(s.inboxNote()).toBeNull();
		await s.runCommand();
		expect(s.notes).toHaveLength(1);
		expect(s.inboxNote()).toBeNull();
	});

	test("auto-reload off: the Inbox gives the note, once per version", async () => {
		const s = await session(false);
		const note = s.inboxNote();
		expect(note).toContain("1.0.0");
		expect(note).toContain("1.1.0");
		expect(note).toContain("/reload");
		expect(s.inboxNote()).toBeNull();
	});

	test("nothing new on disk, or this version already told: quiet, and the claim is not spent", async () => {
		let claims = 0;
		const claim = () => {
			claims++;
			return true;
		};
		expect(inboxUpdateNotice("1.0.0", "1.0.0", null, claim, "pi")).toBeNull();
		expect(inboxUpdateNotice("1.0.0", null, null, claim, "pi")).toBeNull();
		expect(inboxUpdateNotice(null, "1.1.0", null, claim, "pi")).toBeNull();
		expect(inboxUpdateNotice("1.0.0", "1.1.0", "1.1.0", claim, "pi")).toBeNull();
		expect(claims).toBe(0);
		expect(inboxUpdateNotice("1.0.0", "1.1.0", null, undefined, "oh-my-pi")).toContain("/restart");
	});
});
