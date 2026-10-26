/**
 * An update that lands while a review is open must not lose the reviewer's
 * decision.
 *
 * The extension imports the module its decision messages are written with
 * (generated/prompts.ts) lazily, through `importFresh`, which refuses any
 * import once the package on disk is a different version (#2085). Loaded only
 * when the decision arrived, it was refused whenever `pi install` / `pi update`
 * replaced the package while the reviewer worked: the session showed
 * "Plannotator was updated from … Type /reload" and the feedback never reached
 * it (5 of 5 times on a real Pi 0.84.4). The module now loads when the review
 * opens, from the version the session runs.
 *
 * The test runs a copy of the extension from a scratch folder, so its
 * package.json can change on disk the way an update changes it, without
 * touching this checkout.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AGENT_TOOL", "PLANNOTATOR_INBOX_TOOL"] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

beforeAll(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-update-mid-review-")));
	symlinkSync(join(here, "..", "..", "node_modules"), join(root, "node_modules"));
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "home", ".pi", "agent");
	process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
	process.env.PLANNOTATOR_AGENT_TOOL = "0";
	process.env.PLANNOTATOR_INBOX_TOOL = "0";
});

afterAll(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key]!;
	}
	if (root) rmSync(root, { recursive: true, force: true });
});

/**
 * A copy of the extension of its own (one module graph per copy, as one Pi
 * process loads one): the extension's files, its dependencies through links.
 */
function freshCopy(name: string): string {
	const copy = join(root, name);
	cpSync(here, copy, { recursive: true, filter: (src) => !src.startsWith(join(here, "node_modules")) && !src.endsWith(".test.ts") });
	symlinkSync(join(here, "node_modules"), join(copy, "node_modules"));
	return copy;
}

/** What `pi install` / `pi update` does under a running Pi: a new version of the package on disk. */
function updateOnDisk(copy: string): void {
	const path = join(copy, "package.json");
	const pkg = JSON.parse(readFileSync(path, "utf8")) as { version: string };
	writeFileSync(path, JSON.stringify({ ...pkg, version: `${pkg.version}-next` }, null, 2));
}

/** The copied extension over a fake Pi, with browser sessions whose decisions the test makes. */
async function loadExtension(copy: string) {
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "notes.md"), "# Notes\n\nSome text.\n");
	const plannotator = (await import(join(copy, "index.ts"))).default as (pi: unknown, deps: unknown) => void;
	const decisions: Array<(result: unknown) => void> = [];
	const delivered: string[] = [];
	const notices: string[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
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
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "update-mid-review",
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: () => undefined,
			setWidget: () => undefined,
			theme: { bold: (t: string) => t, fg: (_c: string, t: string) => t, strikethrough: (t: string) => t },
		},
	};
	const start = () => {
		let decide!: (result: unknown) => void;
		const decision = new Promise<unknown>((resolve) => (decide = resolve));
		decisions.push(decide);
		return Promise.resolve({ url: "http://localhost:4399", waitForDecision: () => decision, stop: () => undefined });
	};
	const pi = {
		events: { on: () => () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerTool: () => undefined,
		getFlag: () => false,
		getActiveTools: () => ["read", "bash", "edit", "write"],
		setActiveTools: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getCommands: () => [],
		appendEntry: () => undefined,
		sendMessage: (message: unknown) => delivered.push(JSON.stringify(message)),
		sendUserMessage: (text: string) => delivered.push(text),
	};
	plannotator(pi, { hasPlanBrowserHtml: () => true, hasReviewBrowserHtml: () => true, startAnnotation: start, startCodeReview: start });
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	const settle = async () => {
		for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	};
	return {
		delivered,
		notices,
		update: () => updateOnDisk(copy),
		async command(name: string, args: string) {
			await commands.get(name)!.handler(args, ctx);
			await settle();
		},
		async decide(result: unknown) {
			decisions.at(-1)!(result);
			await settle();
		},
	};
}

describe("an update while a review is open", () => {
	test("annotate: the reviewer's feedback still reaches the session", async () => {
		const pi = await loadExtension(freshCopy("annotate"));
		await pi.command("plannotator-annotate", "notes.md");
		// The package is replaced while the reviewer works.
		pi.update();
		await pi.decide({ feedback: "Rename the heading." });
		expect(pi.notices.filter((text) => /Plannotator was updated from/.test(text))).toEqual([]);
		expect(pi.delivered.filter((text) => text.includes("Rename the heading."))).toHaveLength(1);
	});

	test("code review: the reviewer's feedback still reaches the session", async () => {
		const pi = await loadExtension(freshCopy("review"));
		await pi.command("plannotator-review", "");
		pi.update();
		await pi.decide({ approved: false, feedback: "Fix the null check." });
		expect(pi.notices.filter((text) => /Plannotator was updated from/.test(text))).toEqual([]);
		expect(pi.delivered.filter((text) => text.includes("Fix the null check."))).toHaveLength(1);
	});
});
