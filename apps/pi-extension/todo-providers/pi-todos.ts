/**
 * pi-todos provider.
 *
 * pi-todos (mitsuhiko/agent-stuff `extensions/todos.ts`) stores each todo as a
 * standalone markdown file with a JSON front-matter block. It exposes no
 * programmatic API to other extensions, so the files ARE the integration
 * surface. Everything below mirrors that on-disk contract as verified against
 * upstream commit a3f8ab11 (2026-05-07):
 *
 *   - directory: $PI_TODO_PATH, else <cwd>/.pi/todos
 *   - todo file: <8 lowercase hex>.md
 *   - lock file: <8 lowercase hex>.lock, created with O_EXCL, 30 min TTL
 *   - body: JSON.stringify(frontMatter, null, 2), then "\n", then optional
 *     markdown body separated by a blank line
 *   - status: free-form string; "closed" and "done" (case-insensitive) count as
 *     closed, anything else is open. New todos default to "open".
 *   - a closed todo drops its `assigned_to_session`, which also keeps it from
 *     sorting above open work in the `/todos` list.
 *
 * `pi-todos.test.ts` re-derives that reader independently and round-trips our
 * output through it, so a drift in either direction fails loudly.
 */
import crypto from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ChecklistItem } from "../generated/checklist.ts";
// Containment is single-sourced from the shared helper every other sink uses
// (see its docstring: duplicating it is how #927/#929 escaped one runtime).
// It is already vendored into generated/, so reusing it adds no new vendoring.
import { isWithinDirectory } from "../generated/html-assets-node.ts";
import type { TodoProvider, TodoProviderEnv } from "./types.ts";

const TODO_DIR_NAME = path.join(".pi", "todos");
const TODO_PATH_ENV = "PI_TODO_PATH";

/** Tag marking every todo this provider owns. */
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

/**
 * Resolve the todo directory the way pi-todos itself resolves it.
 *
 * This is the RAW upstream resolution, and it is deliberately not the path this
 * provider writes to — see `resolveContainedTodoDir`, which applies the trust
 * split described there. Exported for callers that need to report or compare
 * the nominal location.
 */
export function resolveTodoDir(cwd: string): string {
	const fromEnv = process.env[TODO_PATH_ENV]?.trim();
	if (fromEnv) return path.resolve(cwd, fromEnv);
	return path.join(cwd, TODO_DIR_NAME);
}

/**
 * Realpath the deepest existing ancestor of `target`, re-appending the segments
 * that do not exist yet.
 *
 * `isWithinDirectory` keeps a nonexistent path LEXICAL, which is correct for a
 * read sink (the read simply fails) but not for a write sink: `<cwd>/.pi` can
 * itself be a symlink out of the project with `todos` not yet created, and
 * `mkdir -p` would then create — and write into — the external target while a
 * lexical check still saw `<cwd>/.pi/todos`. Resolving the existing prefix makes
 * the containment check see the directory a write would actually land in.
 *
 * Never throws: an unreadable or absent prefix walks up to the filesystem root
 * and, in the worst case, returns the plain lexical resolution.
 */
function resolveThroughExistingAncestor(target: string): string {
	const absolute = path.resolve(target);
	let current = absolute;
	const pending: string[] = [];
	for (;;) {
		try {
			return path.join(realpathSync(current), ...pending);
		} catch {
			const parent = path.dirname(current);
			// Reached the filesystem root without finding anything resolvable.
			if (parent === current) return absolute;
			pending.unshift(path.basename(current));
			current = parent;
		}
	}
}

/**
 * The todo directory this provider is allowed to touch, or null when the
 * repository-implied path escapes the project.
 *
 * TRUST SPLIT — read this before relaxing either branch:
 *
 *   - `$PI_TODO_PATH` is trusted verbatim, including targets outside the
 *     project. It is an explicit choice by the USER, at the same trust level as
 *     `~/.plannotator/config.json`, and pi-todos itself honours it that way;
 *     pointing your own todo store at `~/notes/todos` is a supported workflow.
 *   - `<cwd>/.pi/todos` is implied by whatever repository happens to be checked
 *     out, so it is NOT trusted. A hostile repo can commit `.pi/todos` (or
 *     `.pi`) as a symlink to any path on disk; without this check `sync()` would
 *     create todo files there on the first plan approval, with no confirmation.
 *     That path must therefore realpath to somewhere inside `cwd`.
 *
 * Containment is a realpath comparison on BOTH sides, not a "is it a symlink"
 * rejection: a symlink that stays inside the project (`.pi` -> `docs/.pi`) keeps
 * working, and a project root reached through a symlink (macOS `/tmp` ->
 * `/private/tmp`) is not a false negative.
 *
 * Failing closed is cheap: absent means no mirror, which is the documented
 * no-op behaviour for anyone not running pi-todos.
 */
export function resolveContainedTodoDir(cwd: string): string | null {
	const todosDir = resolveTodoDir(cwd);
	if (process.env[TODO_PATH_ENV]?.trim()) return todosDir;
	return isWithinDirectory(resolveThroughExistingAncestor(todosDir), cwd)
		? todosDir
		: null;
}

/**
 * True when pi-todos looks present and in use.
 *
 * Detection only checks whether the todo directory exists, because that is the
 * only signal available: pi-todos exposes no API and writes no marker.
 * PI_TODO_PATH does not detect the provider by itself; it only redirects which
 * directory gets checked, so setting it with that directory absent still reads
 * as "absent".
 *
 * The directory exists from an installed pi-todos' FIRST session onward — its
 * `session_start` handler calls `ensureTodosDir()` unconditionally, not lazily
 * on the first todo. So do not weaken detection on the premise that an
 * existing-but-empty directory means "installed but never used": it does not,
 * and there is nothing finer-grained to test.
 *
 * A directory that escapes the project (see `resolveContainedTodoDir`) reads as
 * absent, and the provider then never writes: a false negative only costs the
 * mirror, which the widget does not depend on.
 */
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

/**
 * Split the leading JSON object off a todo file. Scans braces instead of using
 * a greedy regex so bodies containing braces survive intact.
 */
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

/**
 * Take the same O_EXCL lock pi-todos takes, so a concurrent `/todos` edit can
 * never interleave with our write. Returns null when the todo is already
 * locked: pi-todos prompts the user before stealing a stale lock, and a
 * background sync has no business doing that, so we skip the todo and pick it
 * up on the next sync instead of blocking the agent.
 */
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
			// Always release the fd, even when the write above threw, so a
			// write failure can never leak a lock-file handle. Swallow the
			// close error itself so it can never mask the original failure.
			await handle.close().catch(() => {});
		}
		return await fn();
	} finally {
		await fs.unlink(lockPath).catch(() => {});
	}
}

/** Existing plannotator-owned todos for a plan, keyed by step number. */
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
	// Serializes overlapping sync() calls on this instance. pi-todos has no
	// atomic upsert: two syncs racing between readOwnedTodos and its writes
	// would both see the same step as "missing" and each create a todo for
	// it. Chaining keeps every call's read-then-write pair uninterrupted.
	let queue: Promise<void> = Promise.resolve();

	async function runSync(items: ChecklistItem[], planId: string): Promise<void> {
		// Re-derived per sync rather than snapshotted at construction: the check
		// is cheap, and a repo that grows a `.pi/todos` symlink mid-session must
		// not be followed either. Not atomic with the mkdir below — nothing short
		// of openat2/O_NOFOLLOW would be — but it shrinks the window from a whole
		// session to microseconds.
		const todosDir = resolveContainedTodoDir(env.cwd);
		// Fail closed. `resolveTodoProvider` already gates on `detectPiTodos`,
		// which applies the same containment check; re-deriving it here keeps a
		// provider constructed directly (tests, a future caller) safe too.
		if (todosDir === null) return;
		await fs.mkdir(todosDir, { recursive: true });
		const owned = await readOwnedTodos(todosDir, planId);
		// pi-todos sorts by created_at and has no explicit order field, and
		// Date.now() only has ms resolution, so a tight creation loop would
		// collide and fall back to readdir order (random hex filenames).
		// Stamping base+index keeps todo order equal to plan order.
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

		// Steps that vanished from the plan (edited and re-approved,
		// renumbered, or an empty resubmission) would otherwise sit in
		// /todos as permanently-open work. Close them rather than unlink:
		// the user's notes stay readable, and pi-todos' own GC reaps closed
		// todos after gcDays. An empty `items` closes every owned step
		// still open, so reconciling against nothing left to do still
		// clears out what this planId used to own.
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
			// Recover the queue after a rejection so the next call still
			// runs; `run` itself still rejects, so the caller (index.ts)
			// sees the error and handles/notifies it.
			queue = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	};
}
