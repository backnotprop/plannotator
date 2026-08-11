import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plannotator from "./index.ts";

/**
 * Extension-level coverage for the todo-provider mirror: proves the plan
 * lifecycle actually drives a provider, which the provider's own unit tests
 * (todo-providers/pi-todos.test.ts) cannot show.
 *
 * The Pi host stub mirrors the one in external-execution.test.ts, trimmed to
 * what a `--plan` session needs to boot, auto-approve (hasUI: false), finish a
 * turn, and toggle back to idle.
 */
const tempDirs: string[] = [];
let originalPiTodoPath: string | undefined;
let originalTodoProviderEnv: string | undefined;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Restore an env var to its pre-test value instead of deleting ambient state. */
function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(() => {
	// The extension resolves a real provider through the real env-sensitive
	// detection code (resolveTodoProvider / detectPiTodos). Snapshot and clear
	// PI_TODO_PATH and PLANNOTATOR_TODO_PROVIDER so an ambient value on the
	// host — or leaked from another test file sharing this process — can
	// never redirect detection or writes outside the temp dirs below.
	originalPiTodoPath = process.env.PI_TODO_PATH;
	originalTodoProviderEnv = process.env.PLANNOTATOR_TODO_PROVIDER;
	delete process.env.PI_TODO_PATH;
	delete process.env.PLANNOTATOR_TODO_PROVIDER;
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	restoreEnv("PI_TODO_PATH", originalPiTodoPath);
	restoreEnv("PLANNOTATOR_TODO_PROVIDER", originalTodoProviderEnv);
});

function createHarness(cwd: string) {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const notifications: string[] = [];
	const widgets: Array<string[] | undefined> = [];
	const state = { activeTools: ["read", "bash", "edit", "write"], thinkingLevel: "medium" };

	const pi = {
		events: { on: () => undefined, emit: () => undefined },
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerFlag: () => undefined,
		registerShortcut: () => undefined,
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => commands.set(name, command),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
			tools.set(tool.name, tool),
		getFlag: () => true,
		getActiveTools: () => [...state.activeTools],
		setActiveTools: (next: string[]) => {
			state.activeTools = [...next];
		},
		getThinkingLevel: () => state.thinkingLevel,
		setThinkingLevel: (level: string) => {
			state.thinkingLevel = level;
		},
		setModel: async () => true,
		appendEntry: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
	};

	const ctx = {
		cwd,
		hasUI: false,
		isIdle: () => true,
		model: { provider: "test", id: "original-model" },
		modelRegistry: { find: (provider: string, id: string) => ({ provider, id }) },
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionId: () => "test-session",
			getSessionFile: () => "session.json",
			getSessionName: () => undefined,
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
			setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
			theme: {
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
		},
	};

	return {
		ctx,
		commands,
		notifications,
		widgets,
		async startSession(): Promise<void> {
			plannotator(pi as never);
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ reason: "startup" }, ctx);
			}
		},
		submitPlan(filePath: string) {
			return tools
				.get("plannotator_submit_plan")!
				.execute("call-1", { filePath }, undefined, undefined, ctx);
		},
		async endTurn(text: string): Promise<void> {
			for (const handler of handlers.get("turn_end") ?? []) {
				await handler({ message: { role: "assistant", content: [{ type: "text", text }] } }, ctx);
			}
		},
		/** The `/plannotator-plan-mode` toggle is the shared exit back to idle. */
		async toggle(): Promise<void> {
			await commands.get("plannotator-plan-mode")?.handler("", ctx);
		},
	};
}

const PLAN_CONTENT = "# Plan\n\n- [ ] First step\n- [ ] Second step\n";

function readTodos(
	todosDir: string,
): Array<{ title: string; status: string; tags: string[]; assigned_to_session?: string }> {
	if (!existsSync(todosDir)) return [];
	return readdirSync(todosDir)
		.filter((entry) => entry.endsWith(".md"))
		.map((entry) => {
			const content = readFileSync(join(todosDir, entry), "utf8");
			const end = content.indexOf("\n}");
			return JSON.parse(content.slice(0, end + 2)) as {
				title: string;
				status: string;
				tags: string[];
				assigned_to_session?: string;
			};
		});
}

describe("plan execution mirrors into a detected todo provider", () => {
	test("approving a plan writes the checklist to .pi/todos", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");

		const todos = readTodos(todosDir);
		expect(todos.map((todo) => todo.title).sort()).toEqual(["1. First step", "2. Second step"]);
		for (const todo of todos) {
			expect(todo.status).toBe("open");
			expect(todo.tags).toContain("plannotator:plan:PLAN.md");
			// TodoProviderEnv carries the session id (ctx.sessionManager.getSessionId()),
			// never the session file path — the harness mock returns a different
			// string for each, so this fails if the wiring regresses.
			expect(todo.assigned_to_session).toBe("test-session");
		}
	});

	test("a DONE marker closes the matching todo", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.endTurn("Finished the first bit. [DONE:1]");

		const byTitle = new Map(readTodos(todosDir).map((todo) => [todo.title, todo]));
		expect(byTitle.get("1. First step")?.status).toBe("done");
		expect(byTitle.get("2. Second step")?.status).toBe("open");
	});

	test("keeps the progress widget even while mirroring", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");

		// The mirror is additive: the tracker still renders both steps...
		const rendered = harness.widgets.filter((content): content is string[] => Array.isArray(content));
		expect(rendered.at(-1)).toHaveLength(2);

		// ...and the provider actually received the same two steps, not just
		// an empty or partial mirror running alongside an unaffected widget.
		const todos = readTodos(todosDir);
		expect(todos.map((todo) => todo.title).sort()).toEqual(["1. First step", "2. Second step"]);
		for (const todo of todos) expect(todo.status).toBe("open");
	});

	test("stays widget-only when no provider is present", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		await harness.endTurn("Done with one. [DONE:1]");

		// No .pi/todos to detect, so nothing is created and nothing warns.
		expect(existsSync(join(cwd, ".pi", "todos"))).toBe(false);
		expect(harness.notifications.filter((note) => note.includes("sync failed"))).toEqual([]);
		const rendered = harness.widgets.filter((content): content is string[] => Array.isArray(content));
		expect(rendered.at(-1)).toHaveLength(2);
	});

	test("re-detects a provider that appears after the first plan", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);
		writeFileSync(join(cwd, "SECOND.md"), "# Plan\n\n- [ ] Later step\n");

		const harness = createHarness(cwd);
		await harness.startSession();
		// First plan runs with no provider installed.
		await harness.submitPlan("PLAN.md");
		expect(readTodos(todosDir)).toEqual([]);

		// Back to idle, provider installed, second plan approved.
		await harness.toggle();
		mkdirSync(todosDir, { recursive: true });
		await harness.toggle();
		await harness.submitPlan("SECOND.md");

		expect(readTodos(todosDir).map((todo) => todo.title)).toEqual(["1. Later step"]);
	});

	test("a sync failure notifies once and latches while the widget keeps updating", async () => {
		const cwd = makeTempDir("plannotator-todo-sync-");
		const todosDir = join(cwd, ".pi", "todos");
		mkdirSync(todosDir, { recursive: true });
		writeFileSync(join(cwd, "PLAN.md"), PLAN_CONTENT);

		const harness = createHarness(cwd);
		await harness.startSession();
		await harness.submitPlan("PLAN.md");
		// The provider is healthy for the initial sync: a real directory.
		expect(readTodos(todosDir)).toHaveLength(2);

		// Break the provider without chmod: replace the todos directory with a
		// plain file, so the next sync's `fs.mkdir(todosDir, { recursive: true })`
		// throws ENOTDIR/EEXIST instead of silently no-oping or needing
		// permissions this process might not even be able to drop.
		rmSync(todosDir, { recursive: true, force: true });
		writeFileSync(todosDir, "not a directory anymore");

		await harness.endTurn("Finished the first bit. [DONE:1]");
		await harness.endTurn("Finished the second bit. [DONE:2]");

		const failureNotices = harness.notifications.filter((note) => note.includes("sync failed"));
		expect(failureNotices).toHaveLength(1);

		// The widget is wired independently of provider health: execution
		// keeps rendering progress after the provider latches disabled.
		const rendered = harness.widgets.filter((content): content is string[] => Array.isArray(content));
		expect(rendered.at(-1)).toHaveLength(2);
	});
});
