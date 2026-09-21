/**
 * Durable feedback archive — Pi (Node) runtime parity.
 *
 * Node mirror of packages/server/feedback-archive.test.ts. Plannotator has two
 * server implementations with the same API surface; a feature wired into only
 * one of them silently drops every Pi user's feedback on the floor. These
 * tests pin that the three Pi handlers (plan deny/approve, review
 * /api/feedback and /api/exit, annotate submit) write the SAME record shape
 * under the same gates.
 *
 * The archive is sandboxed under a temp PLANNOTATOR_DATA_DIR set inside the
 * tests — the vendored module resolves its data dir per call. Plan version
 * history goes through generated/storage.ts, which caches its data directory
 * at import time, so the plan test uses a unique heading (unique slug) and
 * removes only that slug directory afterwards.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startReviewServer } from "./serverReview.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { getPlanVersionPath } from "../generated/storage.ts";
import { detectProjectName } from "./project.ts";
import { parseFeedbackIndex, type FeedbackRecord } from "../generated/feedback-archive.ts";
import { getPlannotatorDataDir } from "../generated/data-dir.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/parse.ts b/src/parse.ts\n@@ -1 +1 @@\n-a\n+b\n";

// Annotate version history goes through generated/storage.ts, whose data dir is
// fixed at import time, so these sessions snapshot into the REAL data dir no
// matter what PLANNOTATOR_DATA_DIR says here. Distinctive, test-owned project
// names keep that out of any real project's bucket and let afterAll remove it.
const PI_FILE_ANNOTATE_PROJECT = "_pi_feedback_archive_test_file";
const PI_STATELESS_ANNOTATE_PROJECT = "_pi_feedback_archive_test_stateless";

const ENV_KEYS = [
	"PLANNOTATOR_DATA_DIR",
	"PLANNOTATOR_FEEDBACK_HISTORY",
	"PLANNOTATOR_ANNOTATE_HISTORY",
	"PLANNOTATOR_AI",
	"PLANNOTATOR_PORT",
	"PLANNOTATOR_REMOTE",
] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function useTempDataDir(): string {
	const dir = makeTempDir("plannotator-pi-feedback-");
	process.env.PLANNOTATOR_DATA_DIR = dir;
	return dir;
}

function feedbackDir(dataDir: string): string {
	return join(dataDir, "feedback");
}

function readOnlyIndex(dataDir: string): FeedbackRecord[] {
	const projects = readdirSync(feedbackDir(dataDir));
	expect(projects.length).toBe(1);
	return parseFeedbackIndex(
		readFileSync(join(feedbackDir(dataDir), projects[0], "index.jsonl"), "utf-8"),
	);
}

function sidecarBody(dataDir: string, record: FeedbackRecord): string {
	const projects = readdirSync(feedbackDir(dataDir));
	return readFileSync(join(feedbackDir(dataDir), projects[0], record.recordFile!), "utf-8");
}

beforeEach(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	delete process.env.PLANNOTATOR_PORT;
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_AI = "disabled";
	process.env.PLANNOTATOR_FEEDBACK_HISTORY = "1";
	process.env.PLANNOTATOR_ANNOTATE_HISTORY = "1";
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key]!;
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
	// Remove the annotate history these tests deposited in the real data dir.
	// Runs with the env already restored, so this resolves the same directory
	// generated/storage.ts wrote to.
	const historyDir = join(getPlannotatorDataDir(), "history");
	for (const project of [PI_FILE_ANNOTATE_PROJECT, PI_STATELESS_ANNOTATE_PROJECT]) {
		rmSync(join(historyDir, project), { recursive: true, force: true });
	}
});

describe("pi feedback archive: code review", () => {
	test("feedback submit appends one record with a sidecar, then deletes the draft", async () => {
		const dataDir = useTempDataDir();
		const server = await startReviewServer({
			rawPatch: PATCH,
			gitRef: "HEAD",
			htmlContent: MINIMAL_HTML,
		});
		try {
			await fetch(`${server.url}/api/draft`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ annotations: [{ id: "a1" }] }),
			});

			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					approved: false,
					feedback: "parse() still drops the null case.",
					annotations: [
						{ id: "a1", type: "comment", text: "null case", filePath: "src/parse.ts", lineStart: 1, lineEnd: 1, side: "new" },
					],
				}),
			});
			expect(response.status).toBe(200);

			const records = readOnlyIndex(dataDir);
			expect(records.length).toBe(1);
			expect(records[0].v).toBe(1);
			expect(records[0].client).toBe("plannotator");
			expect(records[0].surface).toBe("review");
			expect(records[0].decision).toBe("feedback");
			expect(records[0].annotations?.[0].file).toBe("src/parse.ts");
			expect(records[0].target?.review?.gitRef).toBe("HEAD");
			expect(records[0].target?.review?.changedFiles).toBe(1);
			// Identity only, never the patch bytes.
			expect(JSON.stringify(records[0])).not.toContain("diff --git");
			expect(sidecarBody(dataDir, records[0])).toContain("parse() still drops the null case.");

			expect((await fetch(`${server.url}/api/draft`)).status).toBe(404);
		} finally {
			server.stop();
		}
	});

	test("closing without feedback records a dismissal as a decision-only line", async () => {
		const dataDir = useTempDataDir();
		const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
		try {
			expect((await fetch(`${server.url}/api/exit`, { method: "POST" })).status).toBe(200);
			const records = readOnlyIndex(dataDir);
			expect(records[0].decision).toBe("dismissed");
			expect(records[0].recordFile).toBeUndefined();
		} finally {
			server.stop();
		}
	});

	test("a failed archive write keeps the draft and still answers the reviewer with 200", async () => {
		// The one invariant the Pi handler copies by hand rather than inheriting
		// from the shared module: archive first, and only delete the draft when
		// the record actually landed.
		const dataDir = useTempDataDir();
		// The review project is derived from the review cwd; block exactly that
		// archive directory by planting a FILE where the directory must go.
		const repoDir = join(makeTempDir("plannotator-pi-feedback-repo-"), "widgets");
		mkdirSync(repoDir, { recursive: true });
		mkdirSync(feedbackDir(dataDir), { recursive: true });
		writeFileSync(join(feedbackDir(dataDir), "widgets"), "blocked", "utf-8");

		const server = await startReviewServer({
			rawPatch: PATCH,
			gitRef: "HEAD",
			htmlContent: MINIMAL_HTML,
			agentCwd: repoDir,
		});
		try {
			await fetch(`${server.url}/api/draft`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ annotations: [{ id: "a1" }] }),
			});

			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "Do not lose this.", annotations: [{ id: "a1" }] }),
			});
			// The submit succeeds for the user...
			expect(response.status).toBe(200);
			// ...and the draft survives as the recovery copy.
			const draft = await fetch(`${server.url}/api/draft`);
			expect(draft.status).toBe(200);
			expect(JSON.stringify(await draft.json())).toContain("a1");
		} finally {
			server.stop();
		}
	});

	test("a PR-mode session buckets under the project, not the pool checkout", async () => {
		// PR mode never sets gitContext and `--local` points agentCwd at
		// <sessionDir>/pool/pr-<n>; the caller's detected project must win, or
		// every PR review files under `pr-123`.
		const dataDir = useTempDataDir();
		const poolCwd = join(makeTempDir("plannotator-pi-feedback-pool-"), "pool", "pr-123");
		mkdirSync(poolCwd, { recursive: true });
		const server = await startReviewServer({
			rawPatch: PATCH,
			gitRef: "HEAD",
			htmlContent: MINIMAL_HTML,
			project: "plannotator",
			agentCwd: poolCwd,
		});
		try {
			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "Rebase before merging.", annotations: [] }),
			});
			expect(response.status).toBe(200);
			const projects = readdirSync(feedbackDir(dataDir));
			expect(projects).toEqual(["plannotator"]);
		} finally {
			server.stop();
		}
	});

	test("PLANNOTATOR_FEEDBACK_HISTORY=0 writes nothing and keeps the legacy draft behavior", async () => {
		const dataDir = useTempDataDir();
		process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
		const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
		try {
			await fetch(`${server.url}/api/draft`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ annotations: [{ id: "a1" }] }),
			});
			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "secret", annotations: [{ id: "a1" }] }),
			});
			expect(response.status).toBe(200);
			expect(existsSync(feedbackDir(dataDir))).toBe(false);
			expect((await fetch(`${server.url}/api/draft`)).status).toBe(404);
		} finally {
			server.stop();
		}
	});
});

describe("pi feedback archive: annotate", () => {
	test("a single local file submission is recorded with its file path", async () => {
		const dataDir = useTempDataDir();
		const dir = makeTempDir("plannotator-pi-feedback-doc-");
		const docPath = join(dir, "notes.md");
		writeFileSync(docPath, "# Notes\n\nBody\n", "utf-8");
		const server = await startAnnotateServer({
			markdown: "# Notes\n\nBody\n",
			filePath: docPath,
			htmlContent: MINIMAL_HTML,
			project: PI_FILE_ANNOTATE_PROJECT,
		});
		try {
			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "Rename the helper.", annotations: [] }),
			});
			expect(response.status).toBe(200);
			const records = readOnlyIndex(dataDir);
			expect(records[0].surface).toBe("annotate");
			expect(records[0].decision).toBe("feedback");
			expect(records[0].target?.filePath).toBe(resolve(docPath));
		} finally {
			server.stop();
		}
	});

	test("PLANNOTATOR_ANNOTATE_HISTORY=0 keeps annotate sessions fully stateless", async () => {
		const dataDir = useTempDataDir();
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
		const dir = makeTempDir("plannotator-pi-feedback-stateless-");
		const docPath = join(dir, "doc.md");
		writeFileSync(docPath, "# Doc\n\nBody\n", "utf-8");
		const server = await startAnnotateServer({
			markdown: "# Doc\n\nBody\n",
			filePath: docPath,
			htmlContent: MINIMAL_HTML,
			project: PI_STATELESS_ANNOTATE_PROJECT,
		});
		try {
			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "Secret excerpt", annotations: [{ id: "a1" }] }),
			});
			expect(response.status).toBe(200);
			expect(existsSync(feedbackDir(dataDir))).toBe(false);
		} finally {
			server.stop();
		}
	});
});

describe("pi feedback archive: plan", () => {
	const createdSlugs: Array<{ project: string; slug: string }> = [];

	afterAll(() => {
		for (const { project, slug } of createdSlugs) {
			const versionPath = getPlanVersionPath(project, slug, 1);
			if (versionPath) rmSync(join(versionPath, ".."), { recursive: true, force: true });
		}
	});

	test("a denial names the history version file the decision was made on", async () => {
		const dataDir = useTempDataDir();
		const heading = `Pi feedback archive plan ${Math.random().toString(36).slice(2, 10)}`;
		const server = await startPlanReviewServer({
			plan: `# ${heading}\n\nStep one.\n`,
			htmlContent: MINIMAL_HTML,
			origin: "pi",
		});
		try {
			const response = await fetch(`${server.url}/api/deny`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "Split step one in two.", planSave: { enabled: false } }),
			});
			expect(response.status).toBe(200);

			const records = readOnlyIndex(dataDir);
			expect(records.length).toBe(1);
			expect(records[0].surface).toBe("plan");
			expect(records[0].decision).toBe("denied");
			expect(records[0].origin).toBe("pi");

			const slug = records[0].target!.slug!;
			const project = detectProjectName();
			createdSlugs.push({ project, slug });

			const versionFile = records[0].target!.planVersionFile!;
			expect(versionFile).toBe(getPlanVersionPath(project, slug, 1));
			expect(readFileSync(versionFile, "utf-8")).toContain(heading);
		} finally {
			server.stop();
		}
	});
});
