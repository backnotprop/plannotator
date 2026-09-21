/**
 * Annotate server (Pi/Node): local rendered-HTML root freshness
 *
 * Node mirror of the Bun describe of the same name in
 * packages/server/annotate.test.ts: a local rendered-HTML root is served from
 * its current bytes by both /api/plan (tab reload) and /api/share-html (share
 * after Refresh), with the startup snapshot only as the deleted-file fallback,
 * and the version diff is recomputed against the served bytes once they differ.
 *
 * History lives in the real data dir (storage resolves it at import time), so
 * every test uses its own project namespace, removed in afterAll.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

	// A tab reload after an agent edit keeps the version diff: the saved
	// baseline is still the previous version, so the diff is recomputed
	// against the served bytes rather than dropped. Reads never write history.
	test("/api/plan serves the root document's current bytes and recomputes the version diff against them", async () => {
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
			// The baseline still names the saved previous version...
			expect(reloaded.previousPlan).toBe(page("V1"));
			expect(reloaded.versionInfo?.version).toBe(2);
			// ...and the diff describes V1 -> V3, the page actually on screen.
			expect(reloaded.diffCurrent).toBe(page("V3"));
			expect(reloaded.diffHtml).toContain("<ins");
			expect(reloaded.diffHtml).toContain("V3");
			expect(reloaded.diffHtml).not.toContain("V2");

			// The in-app Refresh reads the root through /api/doc: the same
			// recomputed diff rides along for the ROOT document only.
			const refreshed = (await (
				await fetch(`${server.url}/api/doc?path=${encodeURIComponent(pagePath)}`)
			).json()) as PlanPayload & { renderAs?: string };
			expect(refreshed.renderAs).toBe("html");
			expect(refreshed.rawHtml).toContain("V3");
			expect(refreshed.previousPlan).toBe(page("V1"));
			expect(refreshed.versionInfo?.version).toBe(2);
			expect(refreshed.diffHtml).toBe(reloaded.diffHtml);

			// A sibling document served through /api/doc carries no version fields.
			const siblingPath = join(dirname(pagePath), "sibling.html");
			writeFileSync(siblingPath, page("SIBLING"), "utf-8");
			const sibling = (await (
				await fetch(`${server.url}/api/doc?path=${encodeURIComponent(siblingPath)}`)
			).json()) as PlanPayload;
			expect(sibling.rawHtml).toContain("SIBLING");
			expect(sibling.previousPlan).toBeUndefined();
			expect(sibling.diffHtml).toBeUndefined();

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

	// A root that exists but cannot be read (the path replaced by a directory,
	// or permissions revoked) used to throw out of the request handler as an
	// unhandled rejection: /api/plan never answered and the tab hung. It is
	// the missing-file fallback: the startup snapshot, with its version diff.
	async function seedTwoVersions(label: string): Promise<{ pagePath: string; project: string }> {
		const pagePath = join(freshDocDir(label), "page.html");
		const project = uniqueProject(label);
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
		return { pagePath, project };
	}

	type FallbackPayload = { rawHtml?: string; previousPlan?: string | null; versionInfo?: { version: number }; diffHtml?: string };

	// The old behavior hung forever, so the request is raced against a timeout.
	const withTimeout = <T,>(p: Promise<T>, ms = 5000): Promise<T> =>
		Promise.race([
			p,
			new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`request did not answer within ${ms}ms`)), ms)),
		]);

	test("/api/plan falls back to the startup snapshot (with its version diff) when the root path becomes a directory", async () => {
		const { pagePath, project } = await seedTwoVersions("dir");
		const server = await startAnnotateServer({
			markdown: "",
			filePath: pagePath,
			htmlContent: MINIMAL_HTML,
			rawHtml: page("V2"),
			renderHtml: true,
			project,
		});
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
		try {
			unlinkSync(pagePath);
			mkdirSync(pagePath);
			const res = await withTimeout(fetch(`${server.url}/api/plan`));
			expect(res.status).toBe(200);
			const fallback = (await res.json()) as FallbackPayload;
			expect(fallback.rawHtml).toContain("V2");
			expect(fallback.previousPlan).toBe(page("V1"));
			expect(fallback.versionInfo?.version).toBe(2);
			expect(fallback.diffHtml).toBeDefined();

			const share = await withTimeout(fetch(`${server.url}/api/share-html`));
			expect(share.status).toBe(200);
			expect(((await share.json()) as { shareHtml: string }).shareHtml).toContain("V2");
			// The fallback is silent to the reviewer, so the reason is logged once
			// per process (path and error), not once per read.
			const rootWarnings = warnings.filter((w) => w.includes("could not read the HTML root"));
			expect(rootWarnings).toHaveLength(1);
			expect(rootWarnings[0]).toContain(pagePath);
		} finally {
			console.warn = originalWarn;
			server.stop();
		}
	});

	// chmod 000 is not a restriction for root, so the check is skipped there.
	const canRevokeRead = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
	test.skipIf(!canRevokeRead)("/api/plan falls back to the startup snapshot when the root file is unreadable", async () => {
		const { pagePath, project } = await seedTwoVersions("perm");
		const server = await startAnnotateServer({
			markdown: "",
			filePath: pagePath,
			htmlContent: MINIMAL_HTML,
			rawHtml: page("V2"),
			renderHtml: true,
			project,
		});
		try {
			writeFileSync(pagePath, page("V3"), "utf-8");
			chmodSync(pagePath, 0o000);
			const res = await withTimeout(fetch(`${server.url}/api/plan`));
			expect(res.status).toBe(200);
			const fallback = (await res.json()) as FallbackPayload;
			expect(fallback.rawHtml).toContain("V2");
			expect(fallback.rawHtml).not.toContain("V3");
			expect(fallback.previousPlan).toBe(page("V1"));
			expect(fallback.diffHtml).toBeDefined();
		} finally {
			chmodSync(pagePath, 0o644);
			server.stop();
		}
	});
});
