/**
 * Pi mirror of packages/server/review-agent-gone.test.ts: Send never
 * pretends on the node:http review server.
 *
 * What regresses if this fails: a Pi review whose session can no longer
 * receive feedback answers ok, deletes the draft and archives it; or Send to a
 * live session stops deleting the draft; or a PR review's platform post is
 * refused.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer } from "./serverReview.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;

async function sandboxed(run: (dataDir: string) => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-agent-gone-"));
	try {
		process.env.PLANNOTATOR_DATA_DIR = dataDir;
		process.env.PLANNOTATOR_AI = "disabled";
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_FEEDBACK_HISTORY = "1";
		delete process.env.PLANNOTATOR_PORT;
		await run(dataDir);
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key]!;
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
}

const patch = () => `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a${Math.random()}\n+b\n`;
const json = { "Content-Type": "application/json" };
// The reviewer's words as the page saves them: a line comment, and a general
// (global) comment with an attached image.
const DRAFT_COMMENTS = [
	{ id: "c1", type: "comment", scope: "line", filePath: "a.ts", lineStart: 1, lineEnd: 1, side: "new", text: "Why b?" },
	{ id: "g1", type: "comment", scope: "general", filePath: "", lineStart: 0, lineEnd: 0, side: "new", text: "Keep the old name.", images: [{ path: "/tmp/screenshot-ada.png", name: "screenshot" }] },
];
const saveDraft = (url: string) =>
	fetch(`${url}/api/draft`, { method: "POST", headers: json, body: JSON.stringify({ annotations: [], codeAnnotations: DRAFT_COMMENTS, globalAttachments: [] }) });
const send = (url: string, body: Record<string, unknown> = { approved: false, feedback: "Fix a.ts", annotations: [{ id: "c1" }] }) =>
	fetch(`${url}/api/feedback`, { method: "POST", headers: json, body: JSON.stringify(body) });

describe("Send when the agent is gone (Pi)", () => {
	test("a recoverable host resumes before Send, otherwise its draft stays", () =>
		sandboxed(async () => {
			let presence: "gone" | "here" = "gone";
			let recover = false;
			const server = await startReviewServer({
				rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML,
				agentPresence: () => presence,
				reviveAgent: async () => { if (recover) presence = "here"; },
			});
			try {
				await saveDraft(server.url);
				expect((await send(server.url)).status).toBe(410);
				expect((await (await fetch(`${server.url}/api/draft`)).json()).codeAnnotations).toEqual(DRAFT_COMMENTS);
				recover = true;
				expect((await send(server.url)).status).toBe(200);
			} finally {
				server.stop();
			}
		}));

	test("is refused with agent_gone; the draft stays and nothing is archived", () =>
		sandboxed(async (dataDir) => {
			const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, project: "demo", agentPresence: () => "gone" });
			try {
				await saveDraft(server.url);
				const refused = await send(server.url);
				expect(refused.status).toBe(410);
				expect(await refused.json()).toMatchObject({ code: "agent_gone" });
				expect((await send(server.url, { approved: true, feedback: "", annotations: [] })).status).toBe(410);
				// Every comment, the global one and its attachment, exactly as written.
				expect((await (await fetch(`${server.url}/api/draft`)).json()).codeAnnotations).toEqual(DRAFT_COMMENTS);
				expect(existsSync(join(dataDir, "feedback"))).toBe(false);
			} finally {
				server.stop();
			}
		}));

	test("a live session still gets it: ok, and the draft is gone", () =>
		sandboxed(async () => {
			const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, project: "demo", agentPresence: () => "here" });
			try {
				await saveDraft(server.url);
				expect((await send(server.url)).status).toBe(200);
				expect(await server.waitForDecision()).toMatchObject({ feedback: "Fix a.ts" });
				expect((await fetch(`${server.url}/api/draft`)).status).toBe(204);
			} finally {
				server.stop();
			}
		}));

	// Between two Pi sessions: refused as "away" (409, Retry stays), delivered once a session is there.
	test("between sessions: refused as away, and the same Send goes through once a session is back", () =>
		sandboxed(async () => {
			let presence: "here" | "away" = "away";
			const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, project: "demo", agentPresence: () => presence });
			try {
				await saveDraft(server.url);
				const refused = await send(server.url);
				expect(refused.status).toBe(409);
				expect(await refused.json()).toMatchObject({ code: "agent_away" });
				expect((await (await fetch(`${server.url}/api/draft`)).json()).codeAnnotations).toEqual(DRAFT_COMMENTS);
				presence = "here";
				expect((await send(server.url)).status).toBe(200);
				expect(await server.waitForDecision()).toMatchObject({ feedback: "Fix a.ts" });
			} finally {
				server.stop();
			}
		}));

	test("the platform path's status post is never refused", () =>
		sandboxed(async () => {
			const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, agentPresence: () => "gone" });
			try {
				expect((await send(server.url, { approved: false, feedback: "Posted on GitHub.", annotations: [], platform: true })).status).toBe(200);
				expect(await server.waitForDecision()).toMatchObject({ platform: true });
			} finally {
				server.stop();
			}
		}));
});
