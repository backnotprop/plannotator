import crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ChecklistItem } from "../generated/checklist.ts";
import { isWithinDirectory } from "../generated/html-assets-node.ts";
import type { TodoProvider, TodoProviderEnv } from "./types.ts";

const TODO_DIR_NAME = path.join(".pi", "todos");
const TODO_PATH_ENV = "PI_TODO_PATH";

const OWNER_TAG = "plannotator";
const STEP_TAG_PATTERN = /^plannotator:step:(\d+)$/;

interface PiTodoFrontMatter {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	assigned_to_session?: string;
}

interface OwnedTodo {
	id: string;
	frontMatter: PiTodoFrontMatter;
	body: string;
}

export function resolveTodoDir(cwd: string): string {
	const fromEnv = process.env[TODO_PATH_ENV]?.trim();
	if (fromEnv) return path.resolve(cwd, fromEnv);
	return path.join(cwd, TODO_DIR_NAME);
}

function resolveThroughExistingAncestor(target: string): string {
	const absolute = path.resolve(target);
	let current = absolute;
	const pending: string[] = [];
	for (;;) {
		try {
			return path.join(realpathSync(current), ...pending);
		} catch {
			const parent = path.dirname(current);
			if (parent === current) return absolute;
			pending.unshift(path.basename(current));
			current = parent;
		}
	}
}

export function resolveContainedTodoDir(cwd: string): string | null {
	const todosDir = resolveTodoDir(cwd);
	if (process.env[TODO_PATH_ENV]?.trim()) return todosDir;
	return isWithinDirectory(resolveThroughExistingAncestor(todosDir), cwd)
		? todosDir
		: null;
}

export function detectPiTodos(cwd: string): boolean {
	const todosDir = resolveContainedTodoDir(cwd);
	return todosDir !== null && existsSync(todosDir);
}

function serialize(frontMatter: PiTodoFrontMatter, body: string): string {
	const closed = ["closed", "done"].includes(frontMatter.status.toLowerCase());
	const json = JSON.stringify(
		{
			id: frontMatter.id,
			title: frontMatter.title,
			tags: frontMatter.tags ?? [],
			status: frontMatter.status,
			created_at: frontMatter.created_at,
			assigned_to_session: closed ? undefined : frontMatter.assigned_to_session || undefined,
		},
		null,
		2,
	);
	const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "");
	return trimmed ? `${json}\n\n${trimmed}\n` : `${json}\n`;
}

function splitFrontMatter(content: string): { json: string; body: string } {
	if (!content.startsWith("{")) return { json: "", body: content };
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < content.length; i += 1) {
		const char = content[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return {
					json: content.slice(0, i + 1),
					body: content.slice(i + 1).replace(/^\r?\n+/, ""),
				};
			}
		}
	}
	return { json: "", body: content };
}

function parseFrontMatter(content: string, id: string): PiTodoFrontMatter | null {
	const { json } = splitFrontMatter(content);
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as Partial<PiTodoFrontMatter>;
		return {
			id,
			title: typeof parsed.title === "string" ? parsed.title : "",
			tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => typeof tag === "string") : [],
			status: typeof parsed.status === "string" && parsed.status ? parsed.status : "open",
			created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
			assigned_to_session:
				typeof parsed.assigned_to_session === "string" ? parsed.assigned_to_session : undefined,
		};
	} catch {
		return null;
	}
}

async function withLock<T>(todosDir: string, id: string, fn: () => Promise<T>): Promise<T | null> {
	const lockPath = path.join(todosDir, `${id}.lock`);
	let handle: FileHandle;
	try {
		handle = await fs.open(lockPath, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return null;
		throw error;
	}
	try {
		try {
			await handle.writeFile(
				JSON.stringify(
					{ id, pid: process.pid, session: null, created_at: new Date().toISOString() },
					null,
					2,
				),
				"utf8",
			);
		} finally {
			await handle.close().catch(() => {});
		}
		return await fn();
	} finally {
		await fs.unlink(lockPath).catch(() => {});
	}
}

async function readOwnedTodos(todosDir: string, planId: string): Promise<Map<number, OwnedTodo>> {
	const owned = new Map<number, OwnedTodo>();
	const entries = await fs.readdir(todosDir).catch(() => [] as string[]);
	const wantPlan = `${OWNER_TAG}:plan:${planId}`;
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const id = entry.slice(0, -3);
		const content = await fs.readFile(path.join(todosDir, entry), "utf8").catch(() => null);
		if (content === null) continue;
		const frontMatter = parseFrontMatter(content, id);
		if (!frontMatter || !frontMatter.tags.includes(wantPlan)) continue;
		const step = frontMatter.tags
			.map((tag) => STEP_TAG_PATTERN.exec(tag)?.[1])
			.find((value): value is string => value !== undefined);
		if (step === undefined) continue;
		owned.set(Number(step), { id, frontMatter, body: splitFrontMatter(content).body });
	}
	return owned;
}

export function createPiTodosProvider(env: TodoProviderEnv): TodoProvider {
	let queue: Promise<void> = Promise.resolve();

	async function runSync(items: ChecklistItem[], planId: string): Promise<void> {
		const todosDir = resolveContainedTodoDir(env.cwd);
		if (todosDir === null) return;
		await fs.mkdir(todosDir, { recursive: true });
		const owned = await readOwnedTodos(todosDir, planId);
		const base = Date.now();

		for (const [index, item] of items.entries()) {
			const title = `${item.step}. ${item.text}`;
			const status = item.completed ? "done" : "open";
			const existing = owned.get(item.step);

			if (existing) {
				if (existing.frontMatter.title === title && existing.frontMatter.status === status) {
					continue;
				}
				await withLock(todosDir, existing.id, () =>
					fs.writeFile(
						path.join(todosDir, `${existing.id}.md`),
						serialize({ ...existing.frontMatter, title, status }, existing.body),
						"utf8",
					),
				);
				continue;
			}

			let id = crypto.randomBytes(4).toString("hex");
			for (
				let attempt = 0;
				attempt < 10 && existsSync(path.join(todosDir, `${id}.md`));
				attempt += 1
			) {
				id = crypto.randomBytes(4).toString("hex");
			}
			await withLock(todosDir, id, () =>
				fs.writeFile(
					path.join(todosDir, `${id}.md`),
					serialize(
						{
							id,
							title,
							tags: [OWNER_TAG, `${OWNER_TAG}:plan:${planId}`, `${OWNER_TAG}:step:${item.step}`],
							status,
							created_at: new Date(base + index).toISOString(),
							assigned_to_session: env.sessionId,
						},
						`Plan step ${item.step} from \`${planId}\`.`,
					),
					"utf8",
				),
			);
		}

		const liveSteps = new Set(items.map((item) => item.step));
		for (const [step, stale] of owned) {
			if (liveSteps.has(step)) continue;
			if (["closed", "done"].includes(stale.frontMatter.status.toLowerCase())) continue;
			await withLock(todosDir, stale.id, () =>
				fs.writeFile(
					path.join(todosDir, `${stale.id}.md`),
					serialize({ ...stale.frontMatter, status: "closed" }, stale.body),
					"utf8",
				),
			);
		}
	}

	return {
		name: "pi-todos",

		sync(items: ChecklistItem[], planId: string): Promise<void> {
			const run = queue.then(() => runSync(items, planId));
			queue = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	};
}
