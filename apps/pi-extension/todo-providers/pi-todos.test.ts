import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChecklistItem } from "../generated/checklist.ts";
import {
	createPiTodosProvider,
	detectPiTodos,
	resolveContainedTodoDir,
	resolveTodoDir,
} from "./pi-todos.ts";
import { resolveTodoProvider } from "./index.ts";

interface OracleFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
}

function oracleSplit(content: string): { frontMatter: unknown; body: string } {
	if (!content.startsWith("{")) return { frontMatter: null, body: content };
	for (let i = content.indexOf("}"); i !== -1; i = content.indexOf("}", i + 1)) {
		try {
			return {
				frontMatter: JSON.parse(content.slice(0, i + 1)) as unknown,
				body: content.slice(i + 1).replace(/^\r?\n+/, ""),
			};
		} catch {
		}
	}
	return { frontMatter: null, body: content };
}

function oracleParse(content: string, idFallback: string): OracleFrontMatter {
	const { frontMatter } = oracleSplit(content);
	const raw = (frontMatter ?? {}) as Partial<OracleFrontMatter>;
	return {
		id: typeof raw.id === "string" && raw.id ? raw.id : idFallback,
		title: typeof raw.title === "string" ? raw.title : "",
		tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
		status: typeof raw.status === "string" && raw.status ? raw.status : "open",
		created_at: typeof raw.created_at === "string" ? raw.created_at : "",
		assigned_to_session:
			typeof raw.assigned_to_session === "string" && raw.assigned_to_session.trim()
				? raw.assigned_to_session
				: undefined,
	};
}

function oracleIsTodoClosed(status: string): boolean {
	return ["closed", "done"].includes(status.toLowerCase());
}

function oracleSortTodos(todos: OracleFrontMatter[]): OracleFrontMatter[] {
	const rank = (todo: OracleFrontMatter): number => {
		if (oracleIsTodoClosed(todo.status)) return 2;
		return todo.assigned_to_session ? 0 : 1;
	};
	return [...todos].sort(
		(a, b) => rank(a) - rank(b) || (a.created_at || "").localeCompare(b.created_at || ""),
	);
}

async function readViaOracle(todosDir: string): Promise<OracleFrontMatter[]> {
	const entries = await fs.readdir(todosDir);
	const todos: OracleFrontMatter[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const content = await fs.readFile(path.join(todosDir, entry), "utf8");
		todos.push(oracleParse(content, entry.slice(0, -3)));
	}
	return todos;
}

const PLAN_ID = "PLAN.md";

function checklist(...done: number[]): ChecklistItem[] {
	return [
		{ step: 1, text: "Add the provider interface", completed: done.includes(1) },
		{ step: 2, text: "Implement pi-todos", completed: done.includes(2) },
		{ step: 3, text: "Wire the extension", completed: done.includes(3) },
	];
}

let cwd: string;
let todosDir: string;
let originalPiTodoPath: string | undefined;
let originalTodoProviderEnv: string | undefined;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

beforeEach(async () => {
	originalPiTodoPath = process.env.PI_TODO_PATH;
	originalTodoProviderEnv = process.env.PLANNOTATOR_TODO_PROVIDER;
	delete process.env.PI_TODO_PATH;
	delete process.env.PLANNOTATOR_TODO_PROVIDER;
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-pi-todos-"));
	todosDir = path.join(cwd, ".pi", "todos");
	await fs.mkdir(todosDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
	restoreEnv("PI_TODO_PATH", originalPiTodoPath);
	restoreEnv("PLANNOTATOR_TODO_PROVIDER", originalTodoProviderEnv);
});

describe("pi-todos provider", () => {
	test("writes files the upstream parser reads back intact", async () => {
		await createPiTodosProvider({ cwd, sessionId: "session-1" }).sync(checklist(), PLAN_ID);

		const filenames = (await fs.readdir(todosDir)).filter((entry) => entry.endsWith(".md"));
		expect(filenames).toHaveLength(3);
		for (const filename of filenames) expect(filename).toMatch(/^[a-f0-9]{8}\.md$/);
		expect(new Set(filenames).size).toBe(3);

		const todos = await readViaOracle(todosDir);
		expect(todos).toHaveLength(3);
		for (const todo of todos) {
			expect(todo.title).not.toBe("");
			expect(todo.created_at).not.toBe("");
			expect(todo.tags).toContain("plannotator");
			expect(todo.tags).toContain(`plannotator:plan:${PLAN_ID}`);
			expect(todo.status).toBe("open");
			expect(oracleIsTodoClosed(todo.status)).toBe(false);
		}
	});

	test("keeps plan order under the upstream sort", async () => {
		await createPiTodosProvider({ cwd }).sync(checklist(), PLAN_ID);

		const sorted = oracleSortTodos(await readViaOracle(todosDir));
		expect(sorted.map((todo) => todo.title)).toEqual([
			"1. Add the provider interface",
			"2. Implement pi-todos",
			"3. Wire the extension",
		]);
	});

	test("is idempotent across repeated syncs", async () => {
		const provider = createPiTodosProvider({ cwd });
		await provider.sync(checklist(), PLAN_ID);
		const first = await readViaOracle(todosDir);
		await provider.sync(checklist(), PLAN_ID);
		await provider.sync(checklist(), PLAN_ID);
		const third = await readViaOracle(todosDir);

		expect(third).toHaveLength(3);
		expect(third.map((todo) => todo.id).sort()).toEqual(first.map((todo) => todo.id).sort());
	});

	test("serializes overlapping syncs so a race can't duplicate todos", async () => {
		const provider = createPiTodosProvider({ cwd });
		const first = provider.sync(checklist(), PLAN_ID);
		const second = provider.sync(checklist(1, 2, 3), PLAN_ID);
		await Promise.all([first, second]);

		const todos = await readViaOracle(todosDir);
		expect(todos).toHaveLength(3);
		for (const todo of todos) expect(oracleIsTodoClosed(todo.status)).toBe(true);
	});

	test("reflects DONE markers as closed and clears the session assignment", async () => {
		const provider = createPiTodosProvider({ cwd, sessionId: "session-1" });
		await provider.sync(checklist(), PLAN_ID);
		await provider.sync(checklist(1, 2), PLAN_ID);

		const byTitle = new Map((await readViaOracle(todosDir)).map((todo) => [todo.title, todo]));
		expect(oracleIsTodoClosed(byTitle.get("1. Add the provider interface")!.status)).toBe(true);
		expect(oracleIsTodoClosed(byTitle.get("2. Implement pi-todos")!.status)).toBe(true);
		expect(oracleIsTodoClosed(byTitle.get("3. Wire the extension")!.status)).toBe(false);
		expect(byTitle.get("1. Add the provider interface")!.assigned_to_session).toBeUndefined();
		expect(byTitle.get("3. Wire the extension")!.assigned_to_session).toBe("session-1");
	});

	test("sorts completed steps below open ones", async () => {
		const provider = createPiTodosProvider({ cwd });
		await provider.sync(checklist(), PLAN_ID);
		await provider.sync(checklist(1), PLAN_ID);

		const sorted = oracleSortTodos(await readViaOracle(todosDir));
		expect(sorted.at(-1)?.title).toBe("1. Add the provider interface");
	});

	test("closes steps dropped from an edited plan", async () => {
		const provider = createPiTodosProvider({ cwd });
		await provider.sync(checklist(), PLAN_ID);
		await provider.sync([{ step: 1, text: "Add the provider interface", completed: false }], PLAN_ID);

		const byTitle = new Map((await readViaOracle(todosDir)).map((todo) => [todo.title, todo]));
		expect(oracleIsTodoClosed(byTitle.get("1. Add the provider interface")!.status)).toBe(false);
		expect(oracleIsTodoClosed(byTitle.get("2. Implement pi-todos")!.status)).toBe(true);
		expect(oracleIsTodoClosed(byTitle.get("3. Wire the extension")!.status)).toBe(true);
	});

	test("leaves another plan's todos alone", async () => {
		const provider = createPiTodosProvider({ cwd });
		await provider.sync(checklist(), "other-plan.md");
		await provider.sync(checklist(), PLAN_ID);

		const todos = await readViaOracle(todosDir);
		expect(todos).toHaveLength(6);
		expect(todos.filter((todo) => todo.tags.includes(`plannotator:plan:${PLAN_ID}`))).toHaveLength(3);
		expect(
			todos.filter((todo) => todo.tags.includes("plannotator:plan:other-plan.md")),
		).toHaveLength(3);
	});

	test("skips a locked todo instead of stealing the lock", async () => {
		const provider = createPiTodosProvider({ cwd });
		await provider.sync(checklist(), PLAN_ID);

		const target = (await readViaOracle(todosDir)).find(
			(todo) => todo.title === "2. Implement pi-todos",
		)!;
		const lockPath = path.join(todosDir, `${target.id}.lock`);
		await fs.writeFile(lockPath, JSON.stringify({ id: target.id, pid: 1 }), "utf8");

		await provider.sync(checklist(2), PLAN_ID);

		const after = (await readViaOracle(todosDir)).find((todo) => todo.id === target.id)!;
		expect(oracleIsTodoClosed(after.status)).toBe(false);
		expect(existsSync(lockPath)).toBe(true);
	});

	test("releases its own locks", async () => {
		await createPiTodosProvider({ cwd }).sync(checklist(), PLAN_ID);
		const leftover = (await fs.readdir(todosDir)).filter((entry) => entry.endsWith(".lock"));
		expect(leftover).toEqual([]);
	});

	test("no-ops on an empty checklist", async () => {
		await createPiTodosProvider({ cwd }).sync([], PLAN_ID);
		expect(await fs.readdir(todosDir)).toEqual([]);
	});

	test("closes previously owned todos when the checklist goes empty", async () => {
		const provider = createPiTodosProvider({ cwd });
		await provider.sync(checklist(), PLAN_ID);
		await provider.sync([], PLAN_ID);

		const todos = await readViaOracle(todosDir);
		expect(todos).toHaveLength(3);
		for (const todo of todos) expect(oracleIsTodoClosed(todo.status)).toBe(true);
	});
});

describe("pi-todos detection", () => {
	test("detects an existing .pi/todos directory", () => {
		expect(detectPiTodos(cwd)).toBe(true);
	});

	test("reports absent when there is no todo directory", async () => {
		const bare = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-bare-"));
		try {
			expect(detectPiTodos(bare)).toBe(false);
		} finally {
			await fs.rm(bare, { recursive: true, force: true });
		}
	});

	test("honours PI_TODO_PATH", async () => {
		const custom = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-custom-"));
		const bare = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-bare-"));
		try {
			process.env.PI_TODO_PATH = custom;
			expect(detectPiTodos(bare)).toBe(true);

			await createPiTodosProvider({ cwd: bare }).sync(checklist(), PLAN_ID);
			expect((await fs.readdir(custom)).filter((entry) => entry.endsWith(".md"))).toHaveLength(3);
		} finally {
			await fs.rm(custom, { recursive: true, force: true });
			await fs.rm(bare, { recursive: true, force: true });
		}
	});
});

describe("pi-todos containment", () => {
	const scratch: string[] = [];

	async function makeEscapeFixture(): Promise<{ project: string; outside: string }> {
		const project = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-project-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-outside-"));
		scratch.push(project, outside);
		return { project, outside };
	}

	afterEach(async () => {
		await Promise.all(
			scratch.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
		);
	});

	test("reads absent and writes nothing when .pi/todos escapes the project", async () => {
		const { project, outside } = await makeEscapeFixture();
		await fs.mkdir(path.join(project, ".pi"), { recursive: true });
		await fs.symlink(outside, path.join(project, ".pi", "todos"), "dir");

		expect(detectPiTodos(project)).toBe(false);
		expect(resolveTodoProvider({}, { cwd: project })).toBeUndefined();

		await createPiTodosProvider({ cwd: project, sessionId: "s" }).sync(checklist(), PLAN_ID);
		expect(await fs.readdir(outside)).toEqual([]);
	});

	test("reads absent when .pi is a symlink out of the project and todos does not exist yet", async () => {
		const { project, outside } = await makeEscapeFixture();
		await fs.symlink(outside, path.join(project, ".pi"), "dir");

		expect(detectPiTodos(project)).toBe(false);

		await createPiTodosProvider({ cwd: project, sessionId: "s" }).sync(checklist(), PLAN_ID);
		expect(await fs.readdir(outside)).toEqual([]);
	});

	test("still works when .pi/todos is a symlink to another directory inside the project", async () => {
		const { project } = await makeEscapeFixture();
		const inside = path.join(project, "docs", "todos");
		await fs.mkdir(inside, { recursive: true });
		await fs.mkdir(path.join(project, ".pi"), { recursive: true });
		await fs.symlink(inside, path.join(project, ".pi", "todos"), "dir");

		expect(detectPiTodos(project)).toBe(true);

		await createPiTodosProvider({ cwd: project, sessionId: "s" }).sync(checklist(), PLAN_ID);
		expect((await fs.readdir(inside)).filter((entry) => entry.endsWith(".md"))).toHaveLength(3);
	});

	test("does not false-negative when the project root is reached through a symlink", async () => {
		const { project } = await makeEscapeFixture();
		const real = path.join(project, "real");
		const viaLink = path.join(project, "link");
		await fs.mkdir(path.join(real, ".pi", "todos"), { recursive: true });
		await fs.symlink(real, viaLink, "dir");

		expect(detectPiTodos(viaLink)).toBe(true);

		await createPiTodosProvider({ cwd: viaLink, sessionId: "s" }).sync(checklist(), PLAN_ID);
		const written = await fs.readdir(path.join(real, ".pi", "todos"));
		expect(written.filter((entry) => entry.endsWith(".md"))).toHaveLength(3);
	});

	test("trusts an explicit PI_TODO_PATH pointing outside the project", async () => {
		const { project, outside } = await makeEscapeFixture();
		process.env.PI_TODO_PATH = outside;

		expect(detectPiTodos(project)).toBe(true);

		await createPiTodosProvider({ cwd: project, sessionId: "s" }).sync(checklist(), PLAN_ID);
		expect((await fs.readdir(outside)).filter((entry) => entry.endsWith(".md"))).toHaveLength(3);
	});

	test("resolves a relative PI_TODO_PATH against cwd and still trusts an escape", async () => {
		const { project, outside } = await makeEscapeFixture();
		process.env.PI_TODO_PATH = path.relative(project, outside);

		expect(detectPiTodos(project)).toBe(true);

		await createPiTodosProvider({ cwd: project, sessionId: "s" }).sync(checklist(), PLAN_ID);
		expect((await fs.readdir(outside)).filter((entry) => entry.endsWith(".md"))).toHaveLength(3);
	});

	test("does not throw when the path does not exist", async () => {
		const { project } = await makeEscapeFixture();
		const missingRoot = path.join(project, "gone", "deeper");

		expect(() => detectPiTodos(missingRoot)).not.toThrow();
		expect(detectPiTodos(missingRoot)).toBe(false);
		expect(() => resolveContainedTodoDir(missingRoot)).not.toThrow();

		const removed = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-removed-"));
		await fs.rm(removed, { recursive: true, force: true });
		expect(() => detectPiTodos(removed)).not.toThrow();
		expect(detectPiTodos(removed)).toBe(false);
	});

	test("keeps the contained path identical to the raw upstream resolution", async () => {
		const { project } = await makeEscapeFixture();
		await fs.mkdir(path.join(project, ".pi", "todos"), { recursive: true });
		expect(resolveContainedTodoDir(project)).toBe(resolveTodoDir(project));
	});
});

describe("provider resolution", () => {
	test("returns the pi-todos provider when detected", () => {
		expect(resolveTodoProvider({}, { cwd })?.name).toBe("pi-todos");
	});

	test("returns nothing when todoProvider is off", () => {
		expect(resolveTodoProvider({ todoProvider: "off" }, { cwd })).toBeUndefined();
	});

	test("returns nothing when no provider is present", async () => {
		const bare = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-bare-"));
		try {
			expect(resolveTodoProvider({}, { cwd: bare })).toBeUndefined();
		} finally {
			await fs.rm(bare, { recursive: true, force: true });
		}
	});
});
