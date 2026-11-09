/**
 * Feedback must start a turn on an idle Oh My Pi (#1423).
 *
 * Oh My Pi's `sendUserMessage` only queues a message that names `deliverAs`,
 * even when the agent is idle, and drains that queue only when the transcript
 * ends in an assistant reply. In a new session, or after a `!command`, the
 * reviewer's feedback then never reaches the agent: the browser says
 * "Feedback Sent" and nothing happens. Driven through the real extension
 * (/plannotator-annotate and /plannotator-review) over a fake host whose
 * ExtensionAPI looks like Oh My Pi's or like Pi's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";
import { setPiHost } from "./pi-host.ts";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AGENT_TOOL", "PLANNOTATOR_INBOX_TOOL"] as const;
const saved: Record<string, string | undefined> = {};
let root = "";

beforeAll(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-omp-idle-")));
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "home", ".pi", "agent");
	process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
	process.env.PLANNOTATOR_AGENT_TOOL = "0";
	process.env.PLANNOTATOR_INBOX_TOOL = "0";
});

afterAll(() => {
	setPiHost("pi");
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key]!;
	}
	if (root) rmSync(root, { recursive: true, force: true });
});

async function loadExtension(host: "pi" | "oh-my-pi", idle: boolean) {
	const cwd = join(root, `project-${host}-${idle}`);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "notes.md"), "# Notes\n\nSome text.\n");
	const decisions: Array<(result: unknown) => void> = [];
	const sent: Array<{ text: string; options: unknown }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => true,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		abort: () => undefined,
		model: undefined,
		modelRegistry: { find: () => undefined },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => `omp-idle-${host}-${idle}`,
			getSessionFile: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			notify: () => undefined,
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
		// What tells Oh My Pi's ExtensionAPI from Pi's (pi-host.ts).
		...(host === "oh-my-pi" ? { arktype: () => undefined, pi: {} } : {}),
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
		sendMessage: () => undefined,
		sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
	};
	plannotator(pi as never, { hasPlanBrowserHtml: () => true, hasReviewBrowserHtml: () => true, startAnnotation: start as never, startCodeReview: start as never });
	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	const settle = async () => {
		for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
	};
	return {
		sent,
		async review(command: string, args: string, result: unknown) {
			await commands.get(command)!.handler(args, ctx);
			await settle();
			decisions.at(-1)!(result);
			await settle();
		},
	};
}

const flows = [
	{ name: "annotate", command: "plannotator-annotate", args: "notes.md", result: { feedback: "Rename the heading." } },
	{ name: "code review", command: "plannotator-review", args: "", result: { approved: false, feedback: "Fix the null check." } },
] as const;

const cases = [
	{ host: "oh-my-pi", idle: true, options: undefined },
	{ host: "oh-my-pi", idle: false, options: { deliverAs: "followUp" } },
	{ host: "pi", idle: true, options: { deliverAs: "followUp" } },
] as const;

describe("review feedback on an idle host", () => {
	for (const flow of flows) {
		for (const { host, idle, options } of cases) {
			test(`${flow.name}, ${host} ${idle ? "idle" : "busy"}: ${options ? "a follow-up" : "no deliverAs, so it starts a turn"}`, async () => {
				const session = await loadExtension(host, idle);
				await session.review(flow.command, flow.args, flow.result);
				expect(session.sent).toHaveLength(1);
				expect(session.sent[0]!.text).toContain(flow.result.feedback);
				expect(session.sent[0]!.options).toEqual(options);
			});
		}
	}
});
