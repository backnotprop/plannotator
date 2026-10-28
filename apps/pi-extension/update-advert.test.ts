/**
 * The Pi mirror of packages/server/update-advert.test.ts: Pi's review windows
 * get `updateAvailable` from the shared cache, compared with this package's
 * version, with Pi's own command (`pi update --extensions`), never the install
 * script; nothing while update checks are off or for another origin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "./generated/config.ts";
import { writeUpdateState } from "./generated/update-check.ts";
import { startAnnotateServer, startPlanReviewServer, startReviewServer } from "./server.ts";
import { piExtensionVersion } from "./server/update-advert.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_UPDATE_CHECK"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-update-advert-"));
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_REMOTE = "0";
	delete process.env.PLANNOTATOR_PORT;
	delete process.env.PLANNOTATOR_UPDATE_CHECK;
	// A fresh cache: the scheduled release check answers from it, so no request is made.
	writeUpdateState({ latestRelease: { tag: "99.0.0", fetchedAt: Date.now() } }, dataDir);
});

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(dataDir, { recursive: true, force: true });
});

const payload = async (url: string, path = "/api/plan") => (await (await fetch(`${url}${path}`)).json()) as Record<string, unknown>;

describe("updateAvailable on the Pi servers", () => {
	test("plan, annotate and review: the Pi command, this package's version", async () => {
		const plan = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
		const annotate = await startAnnotateServer({ markdown: "# T", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML });
		const review = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
		try {
			const expected = { version: "99.0.0", current: piExtensionVersion(), action: "pi", command: "pi update --extensions" };
			expect((await payload(plan.url)).updateAvailable).toMatchObject(expected);
			expect((await payload(annotate.url)).updateAvailable).toMatchObject(expected);
			expect((await payload(review.url, "/api/diff")).updateAvailable).toMatchObject(expected);
		} finally {
			plan.stop();
			annotate.stop();
			review.stop();
		}
	});

	test("nothing while update checks are off, or for another origin", async () => {
		const omp = await startPlanReviewServer({ plan: "# Plan", origin: "oh-my-pi", htmlContent: MINIMAL_HTML });
		const plan = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
		try {
			expect((await payload(omp.url)).updateAvailable).toBeUndefined();
			saveConfig({ updateCheck: false });
			expect((await payload(plan.url)).updateAvailable).toBeUndefined();
			saveConfig({ updateCheck: true });
			process.env.PLANNOTATOR_UPDATE_CHECK = "off";
			expect((await payload(plan.url)).updateAvailable).toBeUndefined();
		} finally {
			omp.stop();
			plan.stop();
		}
	});
});

describe("updateCheckFailing on the Pi servers (checking has failed for hours)", () => {
	test("says so with Pi's own command, which needs no GitHub", async () => {
		const since = Date.now() - 4 * 60 * 60_000;
		writeUpdateState(
			{ latestRelease: { tag: "0.0.1", fetchedAt: since - 60_000 }, releaseCheck: { attemptedAt: Date.now(), failedAt: Date.now(), failingSince: since, error: "offline" } },
			dataDir,
		);
		const plan = await startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML });
		try {
			const body = await payload(plan.url);
			expect(body.updateCheckFailing).toEqual({ since: new Date(since).toISOString(), error: "couldn't reach GitHub", command: "pi update --extensions" });
			expect(body.updateAvailable).toBeUndefined();
		} finally {
			plan.stop();
		}
	});
});
