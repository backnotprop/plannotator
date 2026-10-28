/**
 * Per-session folder pins (repo-root-pins.ts): a folder a review session
 * pinned and that was then replaced (`mv repo repo.old; ln -s /elsewhere repo`,
 * or another directory moved into its place) must not be read, must not have
 * git run in it, and a git toplevel above the reviewed folder that the server
 * never pinned must not become the read root. Sessions keep their own pins.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkRepoRoot, readRepoFile, readRepoWorkingTreeBytes, readRepoWorkingTreeEntry } from "./repo-file";
import { checkRepoCommandCwd, checkRepoToplevel, RepoRootPins } from "./repo-root-pins";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("repository folder pins", () => {
	let base = "";
	let repo = "";

	beforeEach(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "pn-root-pins-")));
		repo = join(base, "repo");
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src", "a.ts"), "inside\n");
		mkdirSync(join(base, "outside", "src"), { recursive: true });
		writeFileSync(join(base, "outside", "src", "a.ts"), "TOP SECRET\n");
	});

	afterEach(() => {
		if (base) rmSync(base, { recursive: true, force: true });
	});

	const swapForSymlink = () => {
		renameSync(repo, join(base, "repo.moved"));
		symlinkSync(join(base, "outside"), repo);
	};
	const moveOtherIn = () => {
		renameSync(repo, join(base, "repo.moved"));
		renameSync(join(base, "outside"), repo);
	};

	for (const [how, replace] of [
		["for a symlink to an outside directory", swapForSymlink],
		["by another directory moved into its place", moveOtherIn],
	] as const) {
		test(`a pinned folder swapped ${how} is refused by every reader with its own reason`, async () => {
			const pins = new RepoRootPins([repo]);
			await pins.run(async () => {
				expect(await readRepoFile(repo, "src/a.ts")).toMatchObject({ ok: true, content: "inside\n" });
				replace();
				for (const result of [
					await readRepoFile(repo, "src/a.ts"),
					await readRepoWorkingTreeEntry(repo, "src/a.ts"),
					await readRepoWorkingTreeBytes(repo, "src/a.ts"),
				]) {
					expect(result).toMatchObject({ ok: false, reason: "root-replaced" });
					expect(JSON.stringify(result)).not.toContain("SECRET");
				}
				expect(checkRepoCommandCwd(repo).ok).toBe(false);
				expect(checkRepoCommandCwd(join(repo, "src")).ok).toBe(false);
			});
			pins.release();
		});
	}

	test("a folder first read in a session is pinned by that read", async () => {
		const pins = new RepoRootPins();
		await pins.run(async () => {
			expect(await readRepoFile(repo, "src/a.ts")).toMatchObject({ ok: true });
			swapForSymlink();
			expect(await readRepoFile(repo, "src/a.ts")).toMatchObject({ ok: false, reason: "root-replaced" });
		});
	});

	test("the session is found across awaits and timers inside a request", async () => {
		const pins = new RepoRootPins([repo]);
		swapForSymlink();
		const reason = await pins.run(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			const read = await new Promise<Awaited<ReturnType<typeof readRepoFile>>>((resolve) =>
				setTimeout(() => resolve(readRepoFile(repo, "src/a.ts")), 1),
			);
			return read.ok ? null : read.reason;
		});
		expect(reason).toBe("root-replaced");
	});

	test("sessions keep their own pins: a new session on a recreated folder reads it, the old one still refuses", async () => {
		const old = new RepoRootPins([repo]);
		moveOtherIn();
		const fresh = new RepoRootPins([repo]);
		// Pinning in one session never changes another.
		expect(await fresh.run(() => readRepoFile(repo, "src/a.ts"))).toMatchObject({ ok: true, content: "TOP SECRET\n" });
		expect(await old.run(() => readRepoFile(repo, "src/a.ts"))).toMatchObject({ ok: false, reason: "root-replaced" });
		expect(fresh.run(() => checkRepoCommandCwd(repo)).ok).toBe(true);
		expect(old.run(() => checkRepoCommandCwd(repo)).ok).toBe(false);
		// An old session that is never released affects nobody else.
		expect(await readRepoFile(repo, "src/a.ts")).toMatchObject({ ok: true });
		old.release();
		fresh.release();
	});

	test("outside any session nothing is pinned", async () => {
		const pins = new RepoRootPins([repo]);
		moveOtherIn();
		expect(checkRepoRoot(repo).ok).toBe(true);
		expect(checkRepoCommandCwd(repo)).toEqual({ ok: true });
		pins.release();
		// A released session stops guarding even inside its scope.
		expect(pins.run(() => checkRepoRoot(repo).ok)).toBe(true);
	});

	describe("the toplevel above a reviewed folder", () => {
		let parent = "";
		let child = "";

		beforeEach(() => {
			parent = join(base, "P");
			child = join(parent, "wt", "x");
			mkdirSync(child, { recursive: true });
			writeFileSync(join(parent, "secret.txt"), "TOP SECRET\n");
		});

		test("is refused when the server never pinned it (what a racing rev-parse can name)", () => {
			const pins = new RepoRootPins([child]);
			expect(pins.run(() => checkRepoToplevel(child, parent))).toBeNull();
			// A first-use pin of the toplevel does not make it trusted.
			pins.run(() => checkRepoRoot(parent));
			expect(pins.run(() => checkRepoToplevel(child, parent))).toBeNull();
		});

		test("is accepted when the server pinned it, matched by directory rather than by path", () => {
			const alias = join(base, "alias");
			symlinkSync(parent, alias);
			const pins = new RepoRootPins([child, parent]);
			expect(pins.run(() => checkRepoToplevel(child, parent))).toBe(parent);
			// The same directory named another way is the same pin.
			expect(pins.run(() => checkRepoToplevel(child, alias))).toBe(parent);
		});

		test("a pinned toplevel that was replaced is refused", () => {
			const pins = new RepoRootPins([child, parent]);
			renameSync(parent, join(base, "P.moved"));
			mkdirSync(child, { recursive: true });
			expect(pins.run(() => checkRepoToplevel(child, parent))).toBeNull();
		});

		test("the reviewed folder itself is always its own toplevel", () => {
			const pins = new RepoRootPins([child]);
			expect(pins.run(() => checkRepoToplevel(child, child))).toBe(child);
		});

		test("without a session any toplevel holding the folder is accepted, others are not", () => {
			expect(checkRepoToplevel(child, parent)).toBe(parent);
			expect(checkRepoToplevel(child, join(base, "outside"))).toBeNull();
		});
	});

	describe("the command gate", () => {
		test("passes folders no pin holds", () => {
			const pins = new RepoRootPins([repo]);
			expect(pins.run(() => checkRepoCommandCwd(join(base, "outside")))).toEqual({ ok: true });
		});

		test("refuses a subfolder of a pinned folder that now resolves outside it", () => {
			const pins = new RepoRootPins([repo]);
			renameSync(join(repo, "src"), join(base, "src.moved"));
			symlinkSync(join(base, "outside", "src"), join(repo, "src"));
			expect(pins.run(() => checkRepoCommandCwd(join(repo, "src"))).ok).toBe(false);
		});

		test("passes a pinned member that is itself a link out of the pinned root (a workspace member linked in)", () => {
			const member = join(repo, "linked");
			symlinkSync(join(base, "outside"), member);
			const pins = new RepoRootPins([repo, member]);
			expect(pins.run(() => checkRepoCommandCwd(member))).toEqual({ ok: true, gitCeiling: base });
			// Unpinned, the same link is a subfolder resolving outside the root.
			const unpinned = new RepoRootPins([repo]);
			expect(unpinned.run(() => checkRepoCommandCwd(member)).ok).toBe(false);
		});

		test("sets the git ceiling above the outermost trusted pin, so git cannot find a repository higher up", () => {
			const pins = new RepoRootPins([join(repo, "src"), repo]);
			expect(pins.run(() => checkRepoCommandCwd(join(repo, "src")))).toEqual({ ok: true, gitCeiling: dirname(repo) });
		});
	});
});
