/**
 * Annotate server (Pi/Node): local rendered-HTML root freshness
 *
 * Node mirror of the Bun describe of the same name in
 * packages/server/annotate.test.ts: a local rendered-HTML root is served from
 * its current bytes by both /api/plan (tab reload) and /api/share-html (share
 * after Refresh), with the startup snapshot only as the deleted-file fallback,
 * and the startup version diff is dropped once the served bytes differ.
 *
 * History lives in the real data dir (storage resolves it at import time), so
 * every test uses its own project namespace, removed in afterAll.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { getPlannotatorDataDir } from "../generated/data-dir.ts";

const MINIMAL_HTML = "<html><body>editor</body></html>";

describe("pi annotate server: local rendered-HTML root freshness", () => {
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
		const project = `_pi_annotate_root_html_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		mintedProjects.push(project);
		return project;
	}

	afterAll(() => {
		const historyDir = join(getPlannotatorDataDir(), "history");
		for (const project of mintedProjects) {
			rmSync(join(historyDir, project), { recursive: true, force: true });
		}
	});

	const page = (marker: string) => `<html><body>${marker}</body></html>`;
	// realpath so the deleted-file fallback is reachable: containment realpaths
	// the root but keeps a missing target's lexical path, which on a symlinked
	// tmpdir (macOS) would never match.
	const freshDocDir = (label: string) =>
		realpathSync(mkdtempSync(join(tmpdir(), `plannotator-pi-root-html-${label}-`)));

	test("/api/share-html shares the root document's current bytes after the file changes on disk", async () => {
		const pagePath = join(freshDocDir("share"), "page.html");
		writeFileSync(pagePath, page("STARTUP_VERSION"), "utf-8");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: pagePath,
			htmlContent: MINIMAL_HTML,
			rawHtml: page("STARTUP_VERSION"),
			renderHtml: true,
			project: uniqueProject("share"),
		});

		try {
			writeFileSync(pagePath, page("REFRESHED_VERSION"), "utf-8");
			const refreshed = (await (
				await fetch(`${server.url}/api/share-html?path=${encodeURIComponent(pagePath)}`)
			).json()) as { shareHtml: string };
			expect(refreshed.shareHtml).toContain("REFRESHED_VERSION");
			expect(refreshed.shareHtml).not.toContain("STARTUP_VERSION");

			unlinkSync(pagePath);
			const fallback = (await (await fetch(`${server.url}/api/share-html`)).json()) as { shareHtml: string };
			expect(fallback.shareHtml).toContain("STARTUP_VERSION");
		} finally {
			server.stop();
		}
	});

	test("/api/plan serves the root document's current bytes and drops the startup version diff once they differ", async () => {
		const pagePath = join(freshDocDir("plan"), "page.html");
		const project = uniqueProject("plan");
		type PlanPayload = {
			rawHtml?: string;
			previousPlan?: string | null;
			versionInfo?: { version: number };
			diffCurrent?: string;
			diffHtml?: string;
		};

		writeFileSync(pagePath, page("V1"), "utf-8");
		const seed = await startAnnotateServer({
			markdown: "",
			filePath: pagePath,
			htmlContent: MINIMAL_HTML,
			rawHtml: page("V1"),
			renderHtml: true,
			project,
		});
		seed.stop();

		writeFileSync(pagePath, page("V2"), "utf-8");
		const server = await startAnnotateServer({
			markdown: "",
			filePath: pagePath,
			htmlContent: MINIMAL_HTML,
			rawHtml: page("V2"),
			renderHtml: true,
			project,
		});
		const plan = async () => (await (await fetch(`${server.url}/api/plan`)).json()) as PlanPayload;

		try {
			const startup = await plan();
			expect(startup.rawHtml).toContain("V2");
			expect(startup.previousPlan).toBe(page("V1"));
			expect(startup.versionInfo?.version).toBe(2);
			expect(startup.diffHtml).toBeDefined();

			writeFileSync(pagePath, page("V3"), "utf-8");
			const reloaded = await plan();
			expect(reloaded.rawHtml).toContain("V3");
			expect(reloaded.rawHtml).not.toContain("V2");
			expect(reloaded.previousPlan).toBeUndefined();
			expect(reloaded.versionInfo).toBeUndefined();
			expect(reloaded.diffCurrent).toBeUndefined();
			expect(reloaded.diffHtml).toBeUndefined();

			const versions = (await (await fetch(`${server.url}/api/plan/versions`)).json()) as { versions: unknown[] };
			expect(versions.versions).toHaveLength(2);

			unlinkSync(pagePath);
			const fallback = await plan();
			expect(fallback.rawHtml).toContain("V2");
			expect(fallback.previousPlan).toBe(page("V1"));
			expect(fallback.diffHtml).toBeDefined();
		} finally {
			server.stop();
		}
	});
});
