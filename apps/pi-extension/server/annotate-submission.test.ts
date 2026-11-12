import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { deriveAnnotateHistorySlug } from "../generated/annotate-history.ts";
import { getPlannotatorDataDir } from "../generated/data-dir.ts";

describe("pi annotate server: durable submit records (#678)", () => {
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
		const project = `_pi_annotate_submission_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		mintedProjects.push(project);
		return project;
	}

	afterAll(() => {
		const historyDir = join(getPlannotatorDataDir(), "history");
		for (const project of mintedProjects) {
			rmSync(join(historyDir, project), { recursive: true, force: true });
		}
	});

	function submissionsDir(project: string, docPath: string): string {
		return join(
			getPlannotatorDataDir(),
			"history",
			project,
			deriveAnnotateHistorySlug(resolve(docPath)),
			"submissions",
		);
	}

	async function startServer(project: string, docPath: string) {
		const markdown = `# Doc ${project}\n\nBody\n`;
		writeFileSync(docPath, markdown, "utf-8");
		return startAnnotateServer({
			markdown,
			filePath: docPath,
			htmlContent: "<html></html>",
			project,
		});
	}

	test("feedback submit writes a durable record and only then deletes the draft", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-submit-durable-"));
		const docPath = join(dir, "doc.md");
		const project = uniqueProject("feedback");
		const server = await startServer(project, docPath);

		try {
			const saved = await fetch(`${server.url}/api/draft`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ annotations: [{ id: "a1" }] }),
			});
			expect(saved.status).toBe(200);

			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					feedback: "## Feedback\n\nPlease fix X in the second paragraph.",
					annotations: [{ id: "a1" }],
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ ok: true });

			const recordDir = submissionsDir(project, docPath);
			const records = readdirSync(recordDir).filter((f) => f.endsWith(".md"));
			expect(records.length).toBe(1);
			const content = readFileSync(join(recordDir, records[0]), "utf-8");
			expect(content).toContain("Please fix X in the second paragraph.");
			expect(content).toContain("- Decision: feedback");
			expect(content).toContain(`- Source: ${resolve(docPath)}`);

			const draft = await fetch(`${server.url}/api/draft`);
			expect(draft.status).toBe(404);
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("approve with notes persists a record", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-submit-approve-"));
		const docPath = join(dir, "notes.md");
		const project = uniqueProject("approve-notes");
		const server = await startServer(project, docPath);

		try {
			const response = await fetch(`${server.url}/api/approve`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "LGTM, but rename the helper.", annotations: [] }),
			});
			expect(response.status).toBe(200);
			const recordDir = submissionsDir(project, docPath);
			const records = readdirSync(recordDir).filter((f) => f.endsWith(".md"));
			expect(records.length).toBe(1);
			const content = readFileSync(join(recordDir, records[0]), "utf-8");
			expect(content).toContain("LGTM, but rename the helper.");
			expect(content).toContain("- Decision: approved (with notes)");
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("previously-stateless modes stay stateless: annotate-last and URL sessions write no record", async () => {
		const lastProject = uniqueProject("last-message");
		const lastServer = await startAnnotateServer({
			markdown: `# Agent message ${lastProject}\n\nQuoted agent output.\n`,
			filePath: "last-message",
			htmlContent: "<html></html>",
			project: lastProject,
			mode: "annotate-last",
		});
		try {
			const response = await fetch(`${lastServer.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "Quoting the agent: do Y instead.", annotations: [] }),
			});
			expect(response.status).toBe(200);
			expect(existsSync(join(getPlannotatorDataDir(), "history", lastProject))).toBe(false);
		} finally {
			lastServer.stop();
		}

		const urlProject = uniqueProject("url");
		const urlServer = await startAnnotateServer({
			markdown: `# Fetched page ${urlProject}\n\nPage content.\n`,
			filePath: "https://example.com/some/page",
			htmlContent: "<html></html>",
			project: urlProject,
		});
		try {
			const response = await fetch(`${urlServer.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "The fetched page says Z.", annotations: [] }),
			});
			expect(response.status).toBe(200);
			expect(existsSync(join(getPlannotatorDataDir(), "history", urlProject))).toBe(false);
		} finally {
			urlServer.stop();
		}
	});

	test("a malformed feedback body degrades to legacy behavior, never a 500", async () => {
		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-submit-malformed-"));
		const docPath = join(dir, "doc.md");
		const project = uniqueProject("malformed");
		const server = await startServer(project, docPath);

		try {
			await fetch(`${server.url}/api/draft`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ annotations: [{ id: "a1" }] }),
			});

			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: 42, annotations: [] }),
			});
			expect(response.status).toBe(200);
			const draft = await fetch(`${server.url}/api/draft`);
			expect(draft.status).toBe(404);
			expect(existsSync(submissionsDir(project, docPath))).toBe(false);
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("annotateHistory disabled: no content is written and the draft is deleted (legacy behavior)", async () => {
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
		const dir = mkdtempSync(join(tmpdir(), "plannotator-pi-submit-optout-"));
		const docPath = join(dir, "doc.md");
		const project = uniqueProject("opt-out");
		const server = await startServer(project, docPath);

		try {
			await fetch(`${server.url}/api/draft`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ annotations: [{ id: "a1" }] }),
			});

			const response = await fetch(`${server.url}/api/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: "Secret excerpt", annotations: [{ id: "a1" }] }),
			});
			expect(response.status).toBe(200);

			expect(existsSync(join(getPlannotatorDataDir(), "history", project))).toBe(false);
			const draft = await fetch(`${server.url}/api/draft`);
			expect(draft.status).toBe(404);
		} finally {
			server.stop();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
