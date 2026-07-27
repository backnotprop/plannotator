import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChecklistItem } from "../generated/checklist.ts";
import { createPiTodosProvider, detectPiTodos } from "./pi-todos.ts";
import { resolveTodoProvider } from "./index.ts";

/**
 * ── Format oracle ────────────────────────────────────────────────────────────
 *
 * pi-todos exposes no importable API, so to prove we write files it can read we
 * re-derive its reader here and parse our own output with it.
 *
 * This is an INDEPENDENT implementation written from the format documented in
 * mitsuhiko/agent-stuff `extensions/todos.ts` @ a3f8ab11 — deliberately not a
 * copy, both to keep this repo's `MIT OR Apache-2.0` grant clean (agent-stuff
 * is Apache-2.0) and because a different strategy makes it a real cross-check
 * instead of the same code twice. Upstream scans braces to find the end of the
 * leading JSON object (`findJsonObjectEnd`, todos.ts:840-880); this walks
 * candidate `}` positions and takes the first that parses.
 *
 * Contract being pinned, per todos.ts:
 *   - leading JSON object, optional blank line, markdown body (header, :1-19)
 *   - `["closed", "done"]` count as closed (`isTodoClosed`, :179-181)
 *   - sort: closed last, then assigned-first, then `created_at` ascending
 *     (`sortTodos`, :189-199)
 *
 * If upstream changes any of that, these tests fail — that failure is the point.
 */
interface OracleFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
}

/** Take the leading JSON object as the first `}`-terminated prefix that parses. */
function oracleSplit(content: string): { frontMatter: unknown; body: string } {
	if (!content.startsWith("{")) return { frontMatter: null, body: content };
	for (let i = content.indexOf("}"); i !== -1; i = content.indexOf("}", i + 1)) {
		try {
			return {
				frontMatter: JSON.parse(content.slice(0, i + 1)) as unknown,
				body: content.slice(i + 1).replace(/^\r?\n+/, ""),
			};
		} catch {
			// Not a complete object yet — a brace inside a string or a nested
			// object. Try the next candidate.
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

/** Read every todo in a dir through the oracle. */
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

// ── Fixture ──────────────────────────────────────────────────────────────────

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

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "plannotator-pi-todos-"));
	todosDir = path.join(cwd, ".pi", "todos");
	await fs.mkdir(todosDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(cwd, { recursive: true, force: true });
	delete process.env.PI_TODO_PATH;
});

describe("pi-todos provider", () => {
	test("writes files the upstream parser reads back intact", async () => {
		await createPiTodosProvider({ cwd, sessionFile: "session.json" }).sync(checklist(), PLAN_ID);

		const todos = await readViaOracle(todosDir);
		expect(todos).toHaveLength(3);
		for (const todo of todos) {
			// A format break shows up here: the oracle falls back to defaults
			// (empty title, empty created_at) when it cannot parse our JSON.
			expect(todo.title).not.toBe("");
			expect(todo.created_at).not.toBe("");
			expect(todo.tags).toContain("plannotator");
			expect(todo.tags).toContain(`plannotator:plan:${PLAN_ID}`);
			expect(todo.status).toBe("open");
			expect(oracleIsTodoClosed(todo.status)).toBe(false);
		}
		// Filenames must match upstream's id pattern or its own loader skips them.
		for (const todo of todos) expect(todo.id).toMatch(/^[a-f0-9]{8}$/);
		expect(new Set(todos.map((todo) => todo.id)).size).toBe(3);
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

	test("reflects DONE markers as closed and clears the session assignment", async () => {
		const provider = createPiTodosProvider({ cwd, sessionFile: "session.json" });
		await provider.sync(checklist(), PLAN_ID);
		await provider.sync(checklist(1, 2), PLAN_ID);

		const byTitle = new Map((await readViaOracle(todosDir)).map((todo) => [todo.title, todo]));
		expect(oracleIsTodoClosed(byTitle.get("1. Add the provider interface")!.status)).toBe(true);
		expect(oracleIsTodoClosed(byTitle.get("2. Implement pi-todos")!.status)).toBe(true);
		expect(oracleIsTodoClosed(byTitle.get("3. Wire the extension")!.status)).toBe(false);
		// Closed todos drop their assignment, matching upstream, so they sort
		// below live work instead of above it.
		expect(byTitle.get("1. Add the provider interface")!.assigned_to_session).toBeUndefined();
		expect(byTitle.get("3. Wire the extension")!.assigned_to_session).toBe("session.json");
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
		// Locked, so the DONE reflection is deferred rather than applied.
		expect(oracleIsTodoClosed(after.status)).toBe(false);
		// The foreign lock survives untouched.
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
