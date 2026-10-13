/**
 * Pi mirror of packages/server/host-control.test.ts: host-only session
 * control on the node:http servers (`/api/host/status`, `/api/host/close`,
 * and the in-process `hostControl` Pi itself calls).
 *
 * What regresses if this fails: closing a Pi-hosted review deletes the
 * reviewer's unsent comments or reports it as the reviewer's own close, the
 * endpoints answer without the launch token, or a plan review can be closed.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostControlToken } from "./host-control.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startReviewServer } from "./serverReview.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const TOKEN = "p".repeat(40);
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY", "PLANNOTATOR_ANNOTATE_HISTORY"] as const;

async function sandboxed(run: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	const dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-host-control-"));
	try {
		process.env.PLANNOTATOR_DATA_DIR = dataDir;
		process.env.PLANNOTATOR_AI = "disabled";
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
		delete process.env.PLANNOTATOR_PORT;
		await run();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key]!;
		}
		rmSync(dataDir, { recursive: true, force: true });
	}
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const saveDraft = (url: string, draft: Record<string, unknown>) =>
	fetch(`${url}/api/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });

describe("Pi host control", () => {
	test("annotate: guarded endpoints; close keeps the draft and settles as an agent dismissal", () =>
		sandboxed(async () => {
			const server = await startAnnotateServer({
				markdown: `# Pi host control ${Math.random()}`,
				filePath: join(tmpdir(), "notes.md"),
				htmlContent: MINIMAL_HTML,
				hostControlToken: TOKEN,
			});
			try {
				expect((await fetch(`${server.url}/api/host/status`)).status).toBe(401);
				expect((await fetch(`${server.url}/api/host/status`, { headers: { ...auth, Origin: server.url } })).status).toBe(403);
				await saveDraft(server.url, { annotations: [{ id: "a1" }], codeAnnotations: [], globalAttachments: [] });
				const status = await (await fetch(`${server.url}/api/host/status`, { headers: auth })).json();
				expect(status).toMatchObject({ kind: "annotate", unsentAnnotations: 1, decided: false });

				const closed = await fetch(`${server.url}/api/host/close`, { method: "POST", headers: auth });
				expect(await closed.json()).toEqual({ unsentAnnotations: 1 });
				expect(await server.waitForDecision()).toMatchObject({ exit: true, closedBy: "agent", unsentAnnotations: 1 });
				const draft = await (await fetch(`${server.url}/api/draft`)).json();
				expect(draft.annotations).toHaveLength(1);
				expect(server.hostControl.close?.()).toEqual({ closed: false, reason: "decided" });
			} finally {
				server.stop();
			}
		}));

	test("without a token the endpoints are off, and Pi still closes in-process", () =>
		sandboxed(async () => {
			const server = await startReviewServer({ rawPatch: "diff --git a/a b/a\n@@ -1 +1 @@\n-a\n+b\n", gitRef: "HEAD", htmlContent: MINIMAL_HTML });
			try {
				const off = await fetch(`${server.url}/api/host/close`, { method: "POST", headers: auth });
				expect(off.status).toBe(404);
				// Coded, so a host does not mistake it for an older CLI and TERM it.
				expect((await off.json()).code).toBe("host_control_disabled");
				await saveDraft(server.url, { annotations: [], codeAnnotations: [{ id: "c1" }], globalAttachments: [] });
				expect(server.hostControl.close?.()).toEqual({ closed: true, unsentAnnotations: 1 });
				expect(await server.waitForDecision()).toMatchObject({ exit: true, closedBy: "agent" });

				// The tab still open after the close: its late decision is refused
				// rather than answered ok, and must not delete the kept draft.
				const feedback = await fetch(`${server.url}/api/feedback`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ approved: false, feedback: "late", annotations: [{ id: "c1" }] }),
				});
				expect(feedback.status).toBe(409);
				expect((await fetch(`${server.url}/api/exit`, { method: "POST" })).status).toBe(409);
				expect((await (await fetch(`${server.url}/api/draft`)).json()).codeAnnotations).toHaveLength(1);
			} finally {
				server.stop();
			}
		}));

	// The failure: a remote session (reachable beyond loopback) answers host
	// control with the caller's token.
	test("remote mode turns the endpoints off even with a token", () =>
		sandboxed(async () => {
			process.env.PLANNOTATOR_REMOTE = "1";
			expect(resolveHostControlToken(TOKEN)).toBeUndefined();
			process.env.PLANNOTATOR_REMOTE = "0";
			expect(resolveHostControlToken(TOKEN)).toBe(TOKEN);
		}));

	test("plan: status only, never closable", () =>
		sandboxed(async () => {
			const server = await startPlanReviewServer({ plan: `# Pi plan ${Math.random()}\n`, htmlContent: MINIMAL_HTML, hostControlToken: TOKEN });
			try {
				expect(await (await fetch(`${server.url}/api/host/status`, { headers: auth })).json()).toMatchObject({ kind: "plan", decided: false });
				expect((await fetch(`${server.url}/api/host/close`, { method: "POST", headers: auth })).status).toBe(409);
				expect(server.hostControl.close).toBeUndefined();
			} finally {
				server.stop();
			}
		}));
});
