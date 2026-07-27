/**
 * Annotate server (Pi/Node): folder annotate version history
 *
 * Node mirror of packages/server/annotate.test.ts's "folder annotate history"
 * describe block — exercises the same lazy, memoized per-file history
 * pipeline wired into apps/pi-extension/server/serverAnnotate.ts's /api/doc
 * route, and the path-parameterized /api/plan/version(s) endpoints.
 *
 * History writes go to the real ~/.plannotator data dir (or PLANNOTATOR_DATA_DIR
 * if the environment already had it set before this process's first import of
 * generated/storage.js): that module caches its data directory in a
 * module-level constant at import time, so a per-test PLANNOTATOR_DATA_DIR
 * override taken here would silently no-op once another test file has already
 * imported it. Each test uses its own unique project namespace instead (same
 * approach as the Bun-side suite) so runs never collide.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { deriveAnnotateHistorySlug } from "../generated/annotate-history.ts";
import { getPlannotatorDataDir } from "../generated/data-dir.ts";

describe("pi annotate server: folder annotate history", () => {
	let savedPort: string | undefined;
	let savedRemote: string | undefined;
	let savedHistoryFlag: string | undefined;

	beforeEach(() => {
		savedPort = process.env.PLANNOTATOR_PORT;
		savedRemote = process.env.PLANNOTATOR_REMOTE;
		savedHistoryFlag = process.env.PLANNOTATOR_ANNOTATE_HISTORY;
		delete process.env.PLANNOTATOR_PORT;
		process.env.PLANNOTATOR_REMOTE = "0";
		// Force the toggle on for every test but the one that explicitly flips it
		// off — a real ~/.plannotator/config.json on the machine running these
		// tests must never change the outcome.
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "1";
	});

	afterEach(() => {
		if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
		else process.env.PLANNOTATOR_PORT = savedPort;
		if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
		else process.env.PLANNOTATOR_REMOTE = savedRemote;
		if (savedHistoryFlag === undefined) delete process.env.PLANNOTATOR_ANNOTATE_HISTORY;
		else process.env.PLANNOTATOR_ANNOTATE_HISTORY = savedHistoryFlag;
	});

	// Every minted name is tracked and its history directory removed in
	// afterAll below — this suite must never leave residue in the real data
	// dir (including the stray non-directory file the "unwritable data dir"
	// test deliberately plants inside its own project's history dir; removing
	// the project dir recursively takes that with it).
	const mintedProjects: string[] = [];
	function uniqueProject(label: string): string {
		const project = `_pi_annotate_history_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		mintedProjects.push(project);
		return project;
	}

	afterAll(() => {
		const historyDir = join(getPlannotatorDataDir(), "history");
		for (const project of mintedProjects) {
			rmSync(join(historyDir, project), { recursive: true, force: true });
		}
	});

	test("first open mints one version; reopening in the same session is memoized (no re-snapshot even if the file changes on disk)", async () => {
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-first-open-"));
		const docPath = join(folderPath, "note.md");
		writeFileSync(docPath, "V1\n", "utf-8");
		const project = uniqueProject("first-open");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			const first = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
			const firstJson = (await first.json()) as {
				markdown?: string;
				previousPlan?: string | null;
				versionInfo?: { version: number; totalVersions: number; project: string };
			};
			expect(firstJson.markdown).toBe("V1\n");
			expect(firstJson.previousPlan).toBeNull();
			expect(firstJson.versionInfo).toEqual({ version: 1, totalVersions: 1, project });
			// diffCurrent is intentionally not propagated on the folder /api/doc
			// path — it always equals the doc's own markdown and the client never
			// reads it (unlike single-file /api/plan, which keeps it for shape parity).
			expect("diffCurrent" in firstJson).toBe(false);

			// Change the file on disk between opens — a re-run of the pipeline
			// would mint version 2. Memoization must prevent that.
			writeFileSync(docPath, "V2\n", "utf-8");

			const second = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
			const secondJson = (await second.json()) as {
				markdown?: string;
				previousPlan?: string | null;
				versionInfo?: { version: number; totalVersions: number; project: string };
			};
			// The live document content is always read fresh from disk...
			expect(secondJson.markdown).toBe("V2\n");
			// ...but the history snapshot/diff fields stay exactly what first-open computed.
			expect(secondJson.previousPlan).toBeNull();
			expect(secondJson.versionInfo).toEqual({ version: 1, totalVersions: 1, project });

			const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
			const versionsJson = (await versions.json()) as { versions: unknown[] };
			expect(versionsJson.versions).toHaveLength(1);
		} finally {
			server.stop();
		}
	});

	test("cross-mode slug continuity: a version saved via single-file flow is served as the baseline when a folder session opens the same path", async () => {
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-cross-mode-"));
		const docPath = join(folderPath, "note.md");
		const project = uniqueProject("cross-mode");

		// Single-file session saves "V1" as version 1 for this exact resolved path.
		const seedServer = await startAnnotateServer({
			markdown: "V1\n",
			filePath: docPath,
			htmlContent: "<html></html>",
			mode: "annotate",
			project,
		});
		seedServer.stop();

		// The folder session reads different content off disk, so it mints version 2.
		writeFileSync(docPath, "V2\n", "utf-8");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
			const json = (await response.json()) as {
				previousPlan?: string | null;
				versionInfo?: { version: number; totalVersions: number; project: string };
			};
			expect(json.previousPlan).toBe("V1\n");
			expect(json.versionInfo).toEqual({ version: 2, totalVersions: 2, project });

			const versionOne = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
			const versionOneJson = (await versionOne.json()) as { plan?: string };
			expect(versionOneJson.plan).toBe("V1\n");
		} finally {
			server.stop();
		}
	});

	test("config toggle off: no snapshot, no diff fields, doc still serves", async () => {
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-toggle-off-"));
		const docPath = join(folderPath, "note.md");
		writeFileSync(docPath, "Content\n", "utf-8");
		const project = uniqueProject("toggle-off");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json.markdown).toBe("Content\n");
			expect("previousPlan" in json).toBe(false);
			expect("versionInfo" in json).toBe(false);
			expect("diffCurrent" in json).toBe(false);

			const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
			const versionsJson = (await versions.json()) as { slug: string | null; versions: unknown[] };
			expect(versionsJson).toEqual({ project, slug: null, versions: [] });
		} finally {
			server.stop();
		}
	});

	test("ineligible file type (HTML) serves as today with no snapshot", async () => {
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-html-"));
		const docPath = join(folderPath, "page.html");
		writeFileSync(docPath, "<html><body>Hi</body></html>", "utf-8");
		const project = uniqueProject("html");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json.renderAs).toBe("html");
			expect("previousPlan" in json).toBe(false);
			expect("versionInfo" in json).toBe(false);
			expect("diffCurrent" in json).toBe(false);

			const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
			const versionsJson = (await versions.json()) as { slug: string | null; versions: unknown[] };
			expect(versionsJson).toEqual({ project, slug: null, versions: [] });
		} finally {
			server.stop();
		}
	});

	test("eligibility matches the single-file plain-text set: .mdx mints a snapshot on first open", async () => {
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-mdx-"));
		const docPath = join(folderPath, "note.mdx");
		writeFileSync(docPath, "MDX content\n", "utf-8");
		const project = uniqueProject("mdx");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
			const json = (await response.json()) as {
				previousPlan?: string | null;
				versionInfo?: { version: number; totalVersions: number; project: string };
			};
			expect(json.previousPlan).toBeNull();
			expect(json.versionInfo).toEqual({ version: 1, totalVersions: 1, project });
		} finally {
			server.stop();
		}
	});

	test("cross-mode continuity for config formats: a .yaml with single-file history diffs when opened via its folder", async () => {
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-yaml-"));
		const docPath = join(folderPath, "config.yaml");
		const project = uniqueProject("yaml");

		// Single-file session saves "a: 1" as version 1 for this exact path.
		const seedServer = await startAnnotateServer({
			markdown: "a: 1\n",
			filePath: docPath,
			htmlContent: "<html></html>",
			mode: "annotate",
			project,
		});
		seedServer.stop();

		// The folder session reads different content off disk, so it mints version 2.
		writeFileSync(docPath, "a: 2\n", "utf-8");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			// `doc=1` mirrors the file browser: it forces annotatable plain-text
			// rendering for extensions that overlap CODE_FILE_REGEX (.yaml, .json…).
			const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}&doc=1`);
			const json = (await response.json()) as {
				previousPlan?: string | null;
				versionInfo?: { version: number; totalVersions: number; project: string };
			};
			expect(json.previousPlan).toBe("a: 1\n");
			expect(json.versionInfo).toEqual({ version: 2, totalVersions: 2, project });
		} finally {
			server.stop();
		}
	});

	test(".env stays ineligible: no snapshot is minted even though .env.example would be", async () => {
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-env-"));
		const docPath = join(folderPath, ".env");
		writeFileSync(docPath, "SECRET=1\n", "utf-8");
		const project = uniqueProject("env");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}&doc=1`);
			const json = (await response.json()) as Record<string, unknown>;
			// Whatever shape /api/doc answers with (.env is not annotatable, so it
			// is never served as a document), no history fields may appear and no
			// snapshot may be written.
			expect("previousPlan" in json).toBe(false);
			expect("versionInfo" in json).toBe(false);

			const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
			const versionsJson = (await versions.json()) as { slug: string | null; versions: unknown[] };
			expect(versionsJson).toEqual({ project, slug: null, versions: [] });
		} finally {
			server.stop();
		}
	});

	test("an unwritable history directory degrades to a plain render, no error propagates", async () => {
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-unwritable-"));
		const docPath = join(folderPath, "note.md");
		writeFileSync(docPath, "Content\n", "utf-8");
		const project = uniqueProject("unwritable");

		// Block the exact history directory the pipeline will try to mkdir by
		// pre-creating a plain FILE at that path — mkdirSync(recursive) throws
		// when a target segment exists and is not a directory, on every platform.
		const slug = deriveAnnotateHistorySlug(docPath);
		const historyProjectDir = join(getPlannotatorDataDir(), "history", project);
		mkdirSync(historyProjectDir, { recursive: true });
		writeFileSync(join(historyProjectDir, slug), "not a directory", "utf-8");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
			expect(response.status).toBe(200);
			const json = (await response.json()) as Record<string, unknown>;
			expect(json.markdown).toBe("Content\n");
			expect("previousPlan" in json).toBe(false);
			expect("versionInfo" in json).toBe(false);
			expect("diffCurrent" in json).toBe(false);
		} finally {
			server.stop();
		}
	});

	test("version endpoints: path param serves that file's versions; without path, single-session binding is unchanged; out-of-root path is rejected", async () => {
		const folderPath = mkdtempSync(join(tmpdir(), "plannotator-pi-folder-history-endpoints-"));
		const docPath = join(folderPath, "note.md");
		writeFileSync(docPath, "V1\n", "utf-8");
		const project = uniqueProject("endpoints");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: folderPath,
			folderPath,
			mode: "annotate-folder",
			htmlContent: "<html></html>",
			project,
		});

		try {
			// No history yet for this path: version endpoints report empty, not an error.
			const versionsBefore = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
			expect(await versionsBefore.json()).toEqual({ project, slug: null, versions: [] });
			const versionBefore = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
			expect(versionBefore.status).toBe(404);
			expect(await versionBefore.json()).toEqual({ error: "No version history" });

			// Open the file so history is initialized this session.
			await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);

			const versionsAfter = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
			const versionsAfterJson = (await versionsAfter.json()) as { slug: string | null; versions: { version: number }[] };
			expect(versionsAfterJson.slug).not.toBeNull();
			expect(versionsAfterJson.versions).toHaveLength(1);

			const versionAfter = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
			expect(versionAfter.status).toBe(200);
			expect(await versionAfter.json()).toEqual({ plan: "V1\n", version: 1 });

			// A path outside the folder root is rejected the same way /api/doc rejects it.
			const outsidePath = join(realpathSync(tmpdir()), "outside.md");
			const deniedVersions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(outsidePath)}`);
			expect(deniedVersions.status).toBe(403);
			const deniedVersion = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(outsidePath)}&v=1`);
			expect(deniedVersion.status).toBe(403);

			// Without a path param at all, behavior is exactly today's: this
			// session has no single-file annotateHistory binding (it's a folder
			// session), so both endpoints report "no history" as before.
			const noPathVersions = await fetch(`${server.url}/api/plan/versions`);
			expect(await noPathVersions.json()).toEqual({ project, slug: null, versions: [] });
			const noPathVersion = await fetch(`${server.url}/api/plan/version?v=1`);
			expect(noPathVersion.status).toBe(404);
		} finally {
			server.stop();
		}
	});
});
