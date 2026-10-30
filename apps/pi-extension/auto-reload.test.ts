/**
 * Pi reloads itself for an updated Plannotator (auto-reload.ts), over a fake
 * Pi: every gate that holds the reload, the Pi version gate, the re-check in
 * the command, one try per version, and the one note per version otherwise.
 * The real-host runs (Pi 0.84.4, Oh My Pi) are the spike's and the PR's
 * captures; this guards the decisions.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	AUTO_RELOAD_COMMAND,
	INPUT_GRACE_MS,
	QUIET_MS,
	STABLE_MS,
	autoReloadedText,
	piSupportsAutoReload,
	reloadBlockedBy,
	setupAutoReload,
	type AutoReloadController,
	type QuietState,
} from "./auto-reload.ts";
import { AUTO_RELOAD_DEFAULT, resolveAutoReload } from "../../packages/shared/config.ts";

const MARKER_KEY = "__plannotatorAutoReload_v1";
const NOTICED_KEY = "__plannotatorUpdateNoticed_v1";
const TRIED_KEY = "__plannotatorAutoReloadTried_v1";

/** A fresh Pi process: what one instance leaves for the next (marker, notes, tries) is gone. */
function freshProcess() {
	const store = globalThis as unknown as Record<string, unknown>;
	delete store[MARKER_KEY];
	delete store[NOTICED_KEY];
	delete store[TRIED_KEY];
}

afterEach(freshProcess);

const quiet = (over: Partial<QuietState> = {}): QuietState => ({
	now: 1_000_000,
	running: false,
	idle: true,
	pendingMessages: false,
	compacting: false,
	openPrompts: 0,
	inputAt: null,
	lastKeyAt: null,
	editorText: "",
	plannotatorBusy: null,
	...over,
});

describe("reloadBlockedBy", () => {
	test("a quiet session can reload", () => {
		expect(reloadBlockedBy(quiet())).toBeNull();
	});

	test("each thing a reload would lose holds it", () => {
		const holds: Array<Partial<QuietState>> = [
			{ running: true },
			{ idle: false },
			{ pendingMessages: true },
			{ compacting: true },
			{ openPrompts: 1 },
			{ plannotatorBusy: "an open review" },
			{ editorText: "half a prompt" },
		];
		for (const over of holds) expect(reloadBlockedBy(quiet(over))).not.toBeNull();
	});

	test("an editor holding only whitespace counts as empty", () => {
		expect(reloadBlockedBy(quiet({ editorText: "  \n" }))).toBeNull();
	});

	test("a submitted prompt holds it until its run starts, or for the grace time", () => {
		expect(reloadBlockedBy(quiet({ inputAt: 1_000_000 - INPUT_GRACE_MS + 1 }))).not.toBeNull();
		expect(reloadBlockedBy(quiet({ inputAt: 1_000_000 - INPUT_GRACE_MS }))).toBeNull();
	});

	test("typing holds it for the quiet time", () => {
		expect(reloadBlockedBy(quiet({ lastKeyAt: 1_000_000 - QUIET_MS + 1 }))).not.toBeNull();
		expect(reloadBlockedBy(quiet({ lastKeyAt: 1_000_000 - QUIET_MS }))).toBeNull();
	});
});

describe("piSupportsAutoReload (sendUserMessage's expandPromptTemplates is Pi 0.84.2+)", () => {
	test("0.84.2 and later reload; older Pi would send the command text to the model", () => {
		for (const v of ["0.84.2", "0.84.4", "0.85.0", "1.0.0", "v0.84.2", "0.84.3-beta.1"]) expect(piSupportsAutoReload(v)).toBe(true);
		for (const v of ["0.84.1", "0.83.9", "0.79.9", "0.9.99"]) expect(piSupportsAutoReload(v)).toBe(false);
	});

	test("an unknown or unparseable version counts as too old", () => {
		for (const v of [null, undefined, "", "dev", "0.84", "0.84.x", "latest"]) expect(piSupportsAutoReload(v)).toBe(false);
	});
});

describe("resolveAutoReload", () => {
	test("the env var wins both ways, then config.json, then the default", () => {
		expect(resolveAutoReload({}, {})).toBe(AUTO_RELOAD_DEFAULT);
		expect(resolveAutoReload({ autoReload: false }, {})).toBe(false);
		expect(resolveAutoReload({ autoReload: "false" as unknown as boolean }, {})).toBe(false);
		expect(resolveAutoReload({ autoReload: true }, {})).toBe(true);
		for (const off of ["0", "false", "off", "disabled", " OFF "]) {
			expect(resolveAutoReload({ autoReload: true }, { PLANNOTATOR_AUTO_RELOAD: off })).toBe(false);
		}
		for (const on of ["1", "true", "on"]) {
			expect(resolveAutoReload({ autoReload: false }, { PLANNOTATOR_AUTO_RELOAD: on })).toBe(true);
		}
		// Empty or unrecognized: unset, so config.json decides.
		expect(resolveAutoReload({ autoReload: false }, { PLANNOTATOR_AUTO_RELOAD: "" })).toBe(false);
		expect(resolveAutoReload({ autoReload: false }, { PLANNOTATOR_AUTO_RELOAD: "maybe" })).toBe(false);
	});

	test("ships on (owner's call 2026-10-29)", () => {
		expect(AUTO_RELOAD_DEFAULT).toBe(true);
	});
});

type Handler = (event: any, ctx?: any) => unknown;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const sent: Array<{ text: string; options: unknown }> = [];
	let sendThrows = false;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, spec);
		},
		sendUserMessage(text: string, options?: unknown) {
			if (sendThrows) throw new Error("session closed");
			sent.push({ text, options });
		},
	};
	const emit = (event: string, payload: any = {}, ctx?: any) => {
		for (const h of handlers.get(event) ?? []) h(payload, ctx);
	};
	return {
		pi,
		emit,
		commands,
		sent,
		failSends() {
			sendThrows = true;
		},
	};
}

function fakeCtx(opts: { hasUI?: boolean } = {}) {
	const notes: Array<{ message: string; kind: string }> = [];
	let keyHandler: (() => unknown) | null = null;
	const ctx = {
		hasUI: opts.hasUI ?? true,
		/** Pi makes the old instance's context throw once a reload went through. */
		stale: false,
		idle: true,
		pending: false,
		editor: "",
		reloads: 0,
		/** What Pi's reload does to the old instance: nothing here; a test plays the new instance. */
		onReload: null as null | (() => void),
		isIdle() {
			return ctx.idle;
		},
		hasPendingMessages() {
			return ctx.pending;
		},
		ui: {
			notify: (message: string, kind: string) => {
				if (ctx.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
				notes.push({ message, kind });
			},
			getEditorText: () => ctx.editor,
			onTerminalInput: (handler: () => unknown) => {
				keyHandler = handler;
				return () => {
					keyHandler = null;
				};
			},
		},
		async reload() {
			ctx.reloads++;
			ctx.onReload?.();
		},
		press() {
			keyHandler?.();
		},
	};
	return { ctx, notes };
}

interface WorldOptions {
	piVersion?: string | null | Error;
	enabled?: boolean;
	host?: "pi" | "oh-my-pi";
	busy?: () => string | null;
	hasUI?: boolean;
}

async function world(opts: WorldOptions = {}) {
	freshProcess();
	let t = 0;
	let onDisk: string | null = "1.0.0";
	const f = fakePi();
	const { ctx, notes } = fakeCtx({ hasUI: opts.hasUI });
	const controller = setupAutoReload(f.pi, {
		host: opts.host ?? "pi",
		enabled: opts.enabled ?? true,
		plannotatorBusy: opts.busy ?? (() => null),
		piVersion: async () => {
			if (opts.piVersion instanceof Error) throw opts.piVersion;
			return opts.piVersion === undefined ? "0.84.4" : opts.piVersion;
		},
		readOnDisk: () => onDisk,
		loaded: "1.0.0",
		now: () => t,
		poll: false,
	});
	f.emit("session_start", { reason: "startup" }, ctx);
	await controller.ready;
	const w = {
		...f,
		ctx,
		notes,
		controller,
		get now() {
			return t;
		},
		/** Time passes, then one poll. */
		advance(ms: number) {
			t += ms;
			controller.check();
		},
		install(version: string | null) {
			onDisk = version;
		},
		/** The new version lands and stays on disk long enough. */
		landStable(version = "1.1.0") {
			onDisk = version;
			w.advance(0);
			w.advance(STABLE_MS);
		},
		runCommand(args = "auto") {
			return f.commands.get(AUTO_RELOAD_COMMAND)!.handler(args, ctx);
		},
		texts() {
			return notes.map((n) => n.message);
		},
	};
	return w;
}

describe("setupAutoReload: when it reloads", () => {
	test("once the same new version has stayed on disk for the stable time, through Pi's own command path", async () => {
		const w = await world();
		w.install("1.1.0");
		w.advance(0);
		w.advance(STABLE_MS - 1);
		expect(w.sent).toEqual([]);
		w.advance(1);
		// expandPromptTemplates is what makes Pi run the command instead of sending the text to the model.
		expect(w.sent).toEqual([{ text: `/${AUTO_RELOAD_COMMAND} auto`, options: { expandPromptTemplates: true } }]);
		await w.runCommand();
		expect(w.ctx.reloads).toBe(1);
	});

	test("a version still changing on disk (an install writing files) restarts the stable time", async () => {
		const w = await world();
		w.install("1.1.0");
		w.advance(0);
		w.advance(STABLE_MS - 1000);
		w.install("1.2.0");
		w.advance(1000);
		w.advance(STABLE_MS - 1);
		expect(w.sent).toEqual([]);
		w.advance(1);
		expect(w.sent).toHaveLength(1);
	});

	test("files gone or unreadable on disk, or back to the loaded version: nothing happens", async () => {
		const w = await world();
		w.install(null);
		w.advance(0);
		w.advance(STABLE_MS * 3);
		w.install("1.0.0");
		w.advance(0);
		w.advance(STABLE_MS * 3);
		expect(w.sent).toEqual([]);
		expect(w.notes).toEqual([]);
	});

	test("one try per version: after it, a later poll sends nothing more", async () => {
		const w = await world();
		w.landStable();
		expect(w.sent).toHaveLength(1);
		w.advance(STABLE_MS * 5);
		expect(w.sent).toHaveLength(1);
	});
});

describe("setupAutoReload: what holds it", () => {
	async function heldUntil(hold: (w: Awaited<ReturnType<typeof world>>) => void, release: (w: Awaited<ReturnType<typeof world>>) => void) {
		const w = await world();
		hold(w);
		w.landStable();
		w.advance(STABLE_MS * 3);
		expect(w.sent).toEqual([]);
		release(w);
		w.advance(1);
		return w;
	}

	test("a run, until it settles (agent_end alone is not the end once Pi sends agent_settled)", async () => {
		const w = await world();
		w.emit("agent_settled");
		w.emit("agent_start");
		w.landStable();
		w.emit("agent_end");
		w.advance(STABLE_MS);
		expect(w.sent).toEqual([]);
		w.emit("agent_settled");
		w.advance(1);
		expect(w.sent).toHaveLength(1);
	});

	test("an older Pi without agent_settled: agent_end ends the run", async () => {
		const w = await heldUntil(
			(w) => w.emit("agent_start"),
			(w) => w.emit("agent_end"),
		);
		expect(w.sent).toHaveLength(1);
	});

	test("Pi not idle", async () => {
		const w = await heldUntil(
			(w) => {
				w.ctx.idle = false;
			},
			(w) => {
				w.ctx.idle = true;
			},
		);
		expect(w.sent).toHaveLength(1);
	});

	test("a queued message", async () => {
		const w = await heldUntil(
			(w) => {
				w.ctx.pending = true;
			},
			(w) => {
				w.ctx.pending = false;
			},
		);
		expect(w.sent).toHaveLength(1);
	});

	test("a compaction, until it ends or fails", async () => {
		for (const end of ["session_compact", "session_compact_failed"]) {
			const w = await heldUntil(
				(w) => w.emit("session_before_compact"),
				(w) => w.emit(end),
			);
			expect(w.sent).toHaveLength(1);
		}
	});

	test("another extension's dialog, until every open one is answered", async () => {
		const w = await world();
		w.emit("ui_prompt_start", { kind: "confirm" });
		w.emit("ui_prompt_start", { kind: "select" });
		w.landStable();
		w.emit("ui_prompt_end", { kind: "select" });
		w.advance(STABLE_MS);
		expect(w.sent).toEqual([]);
		w.emit("ui_prompt_end", { kind: "confirm" });
		w.advance(1);
		expect(w.sent).toHaveLength(1);
	});

	test("a prompt submitted but not yet running: held until its run starts and settles", async () => {
		const w = await world();
		w.install("1.1.0");
		w.advance(0);
		w.advance(STABLE_MS - 1);
		w.emit("input", { text: "hello" });
		w.advance(1);
		w.advance(5_000);
		expect(w.sent).toEqual([]);
		w.emit("agent_start");
		w.advance(1);
		expect(w.sent).toEqual([]);
		w.emit("agent_settled");
		w.advance(1);
		expect(w.sent).toHaveLength(1);
	});

	test("a prompt that never starts a run (an input handler swallowed it) stops holding after the grace time", async () => {
		const w = await world();
		w.install("1.1.0");
		w.advance(0);
		w.emit("input", { text: "handled by another extension" });
		w.advance(STABLE_MS);
		w.advance(INPUT_GRACE_MS - STABLE_MS - 1);
		expect(w.sent).toEqual([]);
		w.advance(1);
		expect(w.sent).toHaveLength(1);
	});

	test("Plannotator's own open review, plan review or Ask question", async () => {
		for (const what of ["an open review", "a plan review", "an Ask question"]) {
			let busy: string | null = what;
			const w = await world({ busy: () => busy });
			w.landStable();
			w.advance(STABLE_MS * 3);
			expect(w.sent).toEqual([]);
			busy = null;
			w.advance(1);
			expect(w.sent).toHaveLength(1);
		}
	});

	test("typing, for the quiet time after the last key", async () => {
		const w = await world();
		w.install("1.1.0");
		w.advance(0);
		w.ctx.press();
		w.advance(STABLE_MS);
		w.advance(QUIET_MS - STABLE_MS - 1);
		expect(w.sent).toEqual([]);
		w.advance(1);
		expect(w.sent).toHaveLength(1);
	});

	test("text in the editor, until it is empty", async () => {
		const w = await heldUntil(
			(w) => {
				w.ctx.editor = "half-written";
			},
			(w) => {
				w.ctx.editor = "";
			},
		);
		expect(w.sent).toHaveLength(1);
	});

	test("a session whose context throws (replaced or closed) is never quiet", async () => {
		const w = await world();
		w.ctx.isIdle = () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		};
		w.landStable();
		w.advance(STABLE_MS * 3);
		expect(w.sent).toEqual([]);
	});

	test("a session without a UI (print or RPC mode) is never reloaded", async () => {
		const w = await world({ hasUI: false });
		w.landStable();
		w.advance(STABLE_MS * 3);
		expect(w.sent).toEqual([]);
	});
});

describe("setupAutoReload: the command checks again, the last moment before the reload", () => {
	const lateStarts: Array<[string, (w: Awaited<ReturnType<typeof world>>) => void]> = [
		["text typed meanwhile", (w) => (w.ctx.editor = "typed just now")],
		["a key pressed meanwhile", (w) => w.ctx.press()],
		["a run started meanwhile", (w) => w.emit("agent_start")],
		["a dialog opened meanwhile", (w) => w.emit("ui_prompt_start")],
		["a prompt submitted meanwhile", (w) => w.emit("input", { text: "x" })],
		["a message queued meanwhile", (w) => (w.ctx.pending = true)],
	];
	for (const [what, start] of lateStarts) {
		test(`${what}: no reload, and the try is not spent`, async () => {
			const w = await world();
			w.landStable();
			expect(w.sent).toHaveLength(1);
			start(w);
			await w.runCommand();
			expect(w.ctx.reloads).toBe(0);
			expect(w.notes).toEqual([]);
		});
	}

	test("after backing off it tries again at the next quiet moment", async () => {
		const w = await world();
		w.landStable();
		w.ctx.editor = "typed just now";
		await w.runCommand();
		w.ctx.editor = "";
		w.advance(1);
		expect(w.sent).toHaveLength(2);
		await w.runCommand();
		expect(w.ctx.reloads).toBe(1);
	});

	test("`/plannotator-reload auto` typed by hand, with no reload pending, does nothing", async () => {
		const w = await world();
		await w.runCommand("auto");
		expect(w.ctx.reloads).toBe(0);
	});

	test("`/plannotator-reload` typed by hand reloads, as /reload does", async () => {
		const w = await world();
		await w.runCommand("");
		expect(w.ctx.reloads).toBe(1);
	});
});

/** Pi's reload: the old context goes stale and the instance Pi loads starts (same process). */
function reloadInto(w: Awaited<ReturnType<typeof world>>, loaded: string, onDisk = loaded) {
	const next = fakePi();
	const { ctx, notes } = fakeCtx();
	let controller: AutoReloadController | null = null;
	w.ctx.onReload = () => {
		w.ctx.stale = true;
		controller = setupAutoReload(next.pi, {
			host: "pi",
			enabled: true,
			plannotatorBusy: () => null,
			piVersion: async () => "0.84.4",
			readOnDisk: () => onDisk,
			loaded,
			now: () => w.now,
			poll: false,
		});
		next.emit("session_start", { reason: "reload" }, ctx);
	};
	return {
		next,
		notes,
		get controller() {
			return controller!;
		},
	};
}

describe("setupAutoReload: what the person sees", () => {
	test("the instance Pi loads says it once, as info, at its first poll (after Pi's own status line)", async () => {
		const w = await world();
		w.landStable();
		const n = reloadInto(w, "1.1.0");
		await w.runCommand();
		// Pi writes "Reloaded …" after session_start, and that status would replace a line sent there.
		expect(n.notes).toEqual([]);
		await n.controller.ready;
		n.controller.check();
		expect(n.notes).toEqual([{ message: autoReloadedText("1.1.0"), kind: "info" }]);
		n.controller.check();
		expect(n.notes).toHaveLength(1);
		// The new instance never announces the version it loaded, and the old one says nothing.
		expect(n.controller.claimNotice("1.1.0")).toBe(false);
		expect(w.notes).toEqual([]);
	});

	test("a reload that loaded another version: the new instance gives the note, and never tries again", async () => {
		const w = await world();
		w.landStable();
		const n = reloadInto(w, "1.0.0", "1.1.0");
		await w.runCommand();
		await n.controller.ready;
		n.controller.check();
		expect(n.notes).toHaveLength(1);
		expect(n.notes[0]!.kind).toBe("warning");
		expect(n.notes[0]!.message).toContain("/reload");
		// One try per version per process: the new instance does not reload again (no loop).
		for (let i = 0; i < 10; i++) {
			w.advance(STABLE_MS);
			n.controller.check();
		}
		expect(n.next.sent).toEqual([]);
		expect(n.notes).toHaveLength(1);
	});

	test("an update that fails to load: Pi says so; the stale old context is never used to speak", async () => {
		const w = await world();
		w.landStable();
		w.ctx.onReload = () => {
			w.ctx.stale = true;
		};
		await w.runCommand();
		expect(w.ctx.reloads).toBe(1);
		expect(w.notes).toEqual([]);
	});

	test("Pi refused the reload: the note with /reload, and no second try", async () => {
		const w = await world();
		w.landStable();
		await w.runCommand();
		expect(w.ctx.reloads).toBe(1);
		expect(w.notes).toHaveLength(1);
		expect(w.notes[0]!.kind).toBe("warning");
		expect(w.notes[0]!.message).toContain("1.0.0");
		expect(w.notes[0]!.message).toContain("1.1.0");
		expect(w.notes[0]!.message).toContain("/reload");
		w.advance(STABLE_MS * 5);
		expect(w.sent).toHaveLength(1);
		expect(w.notes).toHaveLength(1);
	});

	test("sending the command fails: the note instead", async () => {
		const w = await world();
		w.failSends();
		w.landStable();
		expect(w.texts()).toHaveLength(1);
		expect(w.texts()[0]).toContain("/reload");
	});

	test("a stale marker (a reload long ago) is not announced by a later reload", async () => {
		const w = await world();
		w.landStable();
		const next = fakePi();
		const { ctx: nextCtx, notes } = fakeCtx();
		setupAutoReload(next.pi, {
			host: "pi",
			enabled: true,
			plannotatorBusy: () => null,
			piVersion: async () => "0.84.4",
			readOnDisk: () => "1.1.0",
			loaded: "1.1.0",
			now: () => w.now + 120_000,
			poll: false,
		});
		next.emit("session_start", { reason: "reload" }, nextCtx);
		expect(notes).toEqual([]);
	});

	const noteOnly: Array<[string, WorldOptions, string]> = [
		["turned off", { enabled: false }, "/reload"],
		["Pi older than 0.84.2", { piVersion: "0.84.1" }, "/reload"],
		["Pi's version unknown", { piVersion: null }, "/reload"],
		["Pi's version unreadable", { piVersion: new Error("no SDK") }, "/reload"],
		["Oh My Pi", { host: "oh-my-pi" }, "/restart"],
	];
	for (const [what, opts, command] of noteOnly) {
		test(`${what}: never a reload; the note once per version, when the session is free`, async () => {
			const w = await world(opts);
			w.emit("agent_start");
			w.landStable();
			w.advance(STABLE_MS);
			expect(w.notes).toEqual([]);
			w.emit("agent_settled");
			w.advance(1);
			w.advance(STABLE_MS * 3);
			expect(w.sent).toEqual([]);
			expect(w.texts()).toHaveLength(1);
			expect(w.texts()[0]).toContain(command);
			// The next version gets its own note.
			w.landStable("1.2.0");
			expect(w.texts()).toHaveLength(2);
		});
	}

	test("Oh My Pi gets no command (it has no reload for extension code)", async () => {
		const w = await world({ host: "oh-my-pi" });
		expect(w.commands.has(AUTO_RELOAD_COMMAND)).toBe(false);
	});
});

describe("claimNotice (the Inbox's update note)", () => {
	test("stays quiet while Pi will reload by itself, and speaks once the one try is spent", async () => {
		const w = await world();
		expect(w.controller.claimNotice("1.1.0")).toBe(false);
		w.landStable();
		await w.runCommand();
		// The reload loaded nothing new: the controller already said it; the Inbox does not repeat it.
		expect(w.controller.claimNotice("1.1.0")).toBe(false);
		expect(w.notes).toHaveLength(1);
	});

	test("while the Pi version gate is still undecided, it waits", async () => {
		let resolveVersion: (v: string) => void = () => {};
		const f = fakePi();
		const { ctx } = fakeCtx();
		const controller = setupAutoReload(f.pi, {
			host: "pi",
			enabled: true,
			plannotatorBusy: () => null,
			piVersion: () => new Promise<string>((r) => (resolveVersion = r)),
			readOnDisk: () => "1.1.0",
			loaded: "1.0.0",
			poll: false,
		});
		f.emit("session_start", { reason: "startup" }, ctx);
		expect(controller.claimNotice("1.1.0")).toBe(false);
		resolveVersion("0.80.0");
		await controller.ready;
		expect(controller.claimNotice("1.1.0")).toBe(true);
	});

	test("off: once per version per process, shared with the controller's own note", async () => {
		const w = await world({ enabled: false });
		expect(w.controller.claimNotice("1.2.0")).toBe(true);
		expect(w.controller.claimNotice("1.2.0")).toBe(false);
		w.landStable("1.2.0");
		expect(w.notes).toEqual([]);
	});

	test("a session without a UI: auto mode will not run there, so the Inbox may say it", async () => {
		const w = await world({ hasUI: false });
		expect(w.controller.claimNotice("1.1.0")).toBe(true);
	});
});
