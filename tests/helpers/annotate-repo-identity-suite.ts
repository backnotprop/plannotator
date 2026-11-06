/**
 * Which repo an annotate session links `#123` and `@name` to (#2290), run
 * against both servers: the source's own repo when it has one, else the repo
 * the session started from. Sessions read it from /api/plan's `repoInfo`; a
 * `display` with no `/` (a repo or folder name, not owner/repo) leaves the
 * document's refs as plain text (`forgeRefLinks`).
 */
import "../setup/sandbox-data-dir";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type StartAnnotateServer = (options: {
	markdown: string;
	filePath: string;
	htmlContent: string;
	mode?: "annotate" | "annotate-last" | "annotate-folder" | "annotate-bundle";
	folderPath?: string;
	bundleFiles?: { path: string; renderAs: "markdown" }[];
}) => Promise<{ url: string; stop: () => void }>;

export function describeAnnotateRepoIdentity(name: string, startAnnotateServer: StartAnnotateServer): void {
	describe(`${name}: annotate repo identity`, () => {
		const LAUNCH = { display: "acme/launch", host: "github.com" };
		const OTHER = { display: "group/other", host: "gitlab.com" };

		let saved: Record<"PLANNOTATOR_PORT" | "PLANNOTATOR_REMOTE" | "HOME", string | undefined>;
		let savedCwd: string;
		let world: string;
		let launchRepo: string;
		let otherRepo: string;
		let outside: string;

		function makeRepo(path: string, origin?: string): string {
			mkdirSync(path, { recursive: true });
			execFileSync("git", ["init", "-q"], { cwd: path });
			if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: path });
			return path;
		}

		function writeDoc(path: string): string {
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, "# Doc\n\nSee #123.\n", "utf-8");
			return path;
		}

		async function repoInfoOf(options: Parameters<StartAnnotateServer>[0]) {
			const server = await startAnnotateServer(options);
			try {
				const payload = (await (await fetch(`${server.url}/api/plan`)).json()) as {
					repoInfo?: { display: string; host?: string } | null;
				};
				return payload.repoInfo;
			} finally {
				server.stop();
			}
		}

		const fileSession = (filePath: string) => ({ markdown: "# Doc\n", filePath, htmlContent: "<html></html>" });
		const folderSession = (folderPath: string) => ({
			markdown: "",
			filePath: folderPath,
			folderPath,
			htmlContent: "<html></html>",
			mode: "annotate-folder" as const,
		});
		const bundleSession = (paths: string[]) => ({
			markdown: "",
			filePath: "",
			htmlContent: "<html></html>",
			mode: "annotate-bundle" as const,
			bundleFiles: paths.map((path) => ({ path, renderAs: "markdown" as const })),
		});

		beforeEach(() => {
			saved = {
				PLANNOTATOR_PORT: process.env.PLANNOTATOR_PORT,
				PLANNOTATOR_REMOTE: process.env.PLANNOTATOR_REMOTE,
				HOME: process.env.HOME,
			};
			savedCwd = process.cwd();
			delete process.env.PLANNOTATOR_PORT;
			process.env.PLANNOTATOR_REMOTE = "0";

			world = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-annotate-repo-identity-")));
			// For git's global config only. os.homedir() ignores this, so it does not
			// protect the data folder: the sandbox-data-dir import above does that.
			process.env.HOME = join(world, "home");
			mkdirSync(process.env.HOME);
			launchRepo = makeRepo(join(world, "launch"), "https://github.com/acme/launch.git");
			otherRepo = makeRepo(join(world, "other"), "git@gitlab.com:group/other.git");
			outside = join(world, "outside");
			mkdirSync(outside);
			process.chdir(launchRepo);
		});

		afterEach(() => {
			process.chdir(savedCwd);
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(world, { recursive: true, force: true });
		});

		describe("a source outside any repo keeps linking to the launch repo", () => {
			test("a file", async () => {
				expect(await repoInfoOf(fileSession(writeDoc(join(outside, "notes", "a.md"))))).toMatchObject(LAUNCH);
			});

			test("a file whose folder is gone", async () => {
				expect(await repoInfoOf(fileSession(join(outside, "gone", "a.md")))).toMatchObject(LAUNCH);
			});

			test("a bundle", async () => {
				const paths = [writeDoc(join(outside, "a.md")), writeDoc(join(outside, "sub", "b.md"))];
				expect(await repoInfoOf(bundleSession(paths))).toMatchObject(LAUNCH);
			});

			test("a bundle across two repos, whose shared folder is in neither", async () => {
				const paths = [writeDoc(join(launchRepo, "a.md")), writeDoc(join(otherRepo, "b.md"))];
				expect(await repoInfoOf(bundleSession(paths))).toMatchObject(LAUNCH);
			});

			test("a folder", async () => {
				writeDoc(join(outside, "a.md"));
				expect(await repoInfoOf(folderSession(outside))).toMatchObject(LAUNCH);
			});
		});

		describe("a source in another repo links to that repo", () => {
			test("a file", async () => {
				expect(await repoInfoOf(fileSession(writeDoc(join(otherRepo, "specs", "a.md"))))).toMatchObject(OTHER);
			});

			test("a bundle", async () => {
				const paths = [writeDoc(join(otherRepo, "a.md")), writeDoc(join(otherRepo, "sub", "b.md"))];
				expect(await repoInfoOf(bundleSession(paths))).toMatchObject(OTHER);
			});

			test("a folder", async () => {
				writeDoc(join(otherRepo, "docs", "a.md"));
				expect(await repoInfoOf(folderSession(join(otherRepo, "docs")))).toMatchObject(OTHER);
			});

			// With no remote the display is just the repo's name, with no `/`, so refs
			// stay plain text: the launch repo's issues are not this repo's.
			test("a repo with no remote keeps its own name, not the launch repo's links", async () => {
				const localRepo = makeRepo(join(world, "local-only"));
				const info = await repoInfoOf(fileSession(writeDoc(join(localRepo, "a.md"))));
				expect(info?.display).toBe("local-only");
				expect(info?.host).toBeUndefined();
			});
		});

		describe("a rootless session uses the launch repo", () => {
			test("a URL", async () => {
				// The repo the URL would name if it were read as a relative path.
				makeRepo(join(launchRepo, "https:", "example.com", "docs"), "git@gitlab.com:group/other.git");
				expect(await repoInfoOf(fileSession("https://example.com/docs/a.md"))).toMatchObject(LAUNCH);
			});

			// Only `annotate` has a file: any other mode's filePath is a label, so
			// it never picks the repo even when it reads like a path in another one.
			test("the last message", async () => {
				const info = await repoInfoOf({
					...fileSession(writeDoc(join(otherRepo, "a.md"))),
					mode: "annotate-last",
				});
				expect(info).toMatchObject(LAUNCH);
			});
		});

		test("started outside any repo, a file outside any repo shows the launch folder, with no links", async () => {
			process.chdir(outside);
			const info = await repoInfoOf(fileSession(writeDoc(join(world, "elsewhere", "a.md"))));
			expect(info?.display).toBe(basename(outside));
			expect(info?.host).toBeUndefined();
		});
	});
}
