import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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

	const mintedProjects: string[] = [];
	function uniqueProject(label: string): string {
		const project = `_pi_annotate_history_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		mintedProjects.push(project);
		return project;
	}

	test("/api/plan identifies the annotated file's repository, not the launch repository", async () => {
		const targetRoot = mkdtempSync(join(tmpdir(), "plannotator-pi-annotate-target-repo-"));
		const filePath = join(targetRoot, "specs", "refunds.md");
		mkdirSync(join(targetRoot, "specs"), { recursive: true });
		writeFileSync(filePath, "# Refunds\n", "utf-8");
		execFileSync("git", ["init", "-q"], { cwd: targetRoot });
		execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/payments-docs.git"], { cwd: targetRoot });
		const server = await startAnnotateServer({
			markdown: "# Refunds\n",
			filePath,
			htmlContent: "<html><body>Plannotator</body></html>",
			project: uniqueProject("repo-info"),
		});
		try {
			const payload = (await (await fetch(`${server.url}/api/plan`)).json()) as {
				repoInfo?: { display: string };
			};
			expect(payload.repoInfo?.display).toBe("acme/payments-docs");
		} finally {
			server.stop();
			rmSync(targetRoot, { recursive: true, force: true });
		}
	});

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
			expect("diffCurrent" in firstJson).toBe(false);

			writeFileSync(docPath, "V2\n", "utf-8");

			const second = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
			const secondJson = (await second.json()) as {
				markdown?: string;
				previousPlan?: string | null;
				versionInfo?: { version: number; totalVersions: number; project: string };
			};
			expect(secondJson.markdown).toBe("V2\n");
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

		const seedServer = await startAnnotateServer({
			markdown: "V1\n",
			filePath: docPath,
			htmlContent: "<html></html>",
			mode: "annotate",
			project,
		});
		seedServer.stop();

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

		const seedServer = await startAnnotateServer({
			markdown: "a: 1\n",
			filePath: docPath,
			htmlContent: "<html></html>",
			mode: "annotate",
			project,
		});
		seedServer.stop();

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

	test("version endpoints: path param serves that file's versions; without path, single-session binding is unchanged; out-of-root path is rejected for a forwarded reader", async () => {
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
			const versionsBefore = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
			expect(await versionsBefore.json()).toEqual({ project, slug: null, versions: [] });
			const versionBefore = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
			expect(versionBefore.status).toBe(404);
			expect(await versionBefore.json()).toEqual({ error: "No version history" });

			await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);

			const versionsAfter = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
			const versionsAfterJson = (await versionsAfter.json()) as { slug: string | null; versions: { version: number }[] };
			expect(versionsAfterJson.slug).not.toBeNull();
			expect(versionsAfterJson.versions).toHaveLength(1);

			const versionAfter = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
			expect(versionAfter.status).toBe(200);
			expect(await versionAfter.json()).toEqual({ plan: "V1\n", version: 1 });

			const outsidePath = join(realpathSync(tmpdir()), "outside.md");
			const outsideVersions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(outsidePath)}`);
			expect(outsideVersions.status).toBe(200);
			expect((await outsideVersions.json()).versions).toEqual([]);
			const forwarded = { headers: { "x-forwarded-for": "100.101.102.103" } };
			const deniedVersions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(outsidePath)}`, forwarded);
			expect(deniedVersions.status).toBe(403);
			const deniedVersion = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(outsidePath)}&v=1`, forwarded);
			expect(deniedVersion.status).toBe(403);

			const noPathVersions = await fetch(`${server.url}/api/plan/versions`);
			expect(await noPathVersions.json()).toEqual({ project, slug: null, versions: [] });
			const noPathVersion = await fetch(`${server.url}/api/plan/version?v=1`);
			expect(noPathVersion.status).toBe(404);
		} finally {
			server.stop();
		}
	});
});
