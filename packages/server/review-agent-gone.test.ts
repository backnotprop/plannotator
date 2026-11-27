/**
 * Send never pretends (packages/shared/review-agent-gone.ts), on the Bun
 * review server. The Pi mirror is apps/pi-extension/server/review-agent-gone.test.ts.
 *
 * What regresses if this fails: Send to an agent that is gone answers ok,
 * deletes the reviewer's draft and archives feedback nobody receives (the
 * silent loss); or Send to a live agent stops deleting the draft; or a PR
 * review's post to the platform is refused for want of an agent; or a tab,
 * open or opened later, never hears that the agent is gone or back.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir = "";

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-review-agent-gone-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = "1";
  delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

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

/** The review's event stream as a tab holds it: each `data:` event in order. */
async function openStream(url: string) {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/external-annotations/stream`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const queued: Array<Record<string, unknown>> = [];
  let buffer = "";
  return {
    async next(match: (event: Record<string, unknown>) => boolean): Promise<Record<string, unknown> | null> {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const index = queued.findIndex(match);
        if (index >= 0) return queued.splice(0, index + 1).pop()!;
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          if (chunk.startsWith("data: ")) queued.push(JSON.parse(chunk.slice(6)) as Record<string, unknown>);
        }
      }
      return null;
    },
    async close() {
      await reader.cancel().catch(() => undefined);
      controller.abort();
    },
  };
}

describe("Send when the agent is gone (Bun)", () => {
  test("is refused with agent_gone; the draft stays, nothing is archived, nothing is decided", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, project: "demo", agentPresence: () => "gone" });
    let decided = false;
    void server.waitForDecision().then(() => { decided = true; });
    try {
      await saveDraft(server.url);
      const refused = await send(server.url);
      expect(refused.status).toBe(410);
      expect(await refused.json()).toMatchObject({ code: "agent_gone" });
      // Approve too: it is a decision for the agent.
      expect((await send(server.url, { approved: true, feedback: "", annotations: [] })).status).toBe(410);
      // Every comment, the global one and its attachment, exactly as written.
      expect((await (await fetch(`${server.url}/api/draft`)).json()).codeAnnotations).toEqual(DRAFT_COMMENTS);
      expect(existsSync(join(dataDir, "feedback"))).toBe(false);
      await Bun.sleep(10);
      expect(decided).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a live agent still gets it: ok, and the draft is gone", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, project: "demo", agentPresence: () => "here" });
    try {
      await saveDraft(server.url);
      expect((await send(server.url)).status).toBe(200);
      expect(await server.waitForDecision()).toMatchObject({ approved: false, feedback: "Fix a.ts" });
      // No draft left: 204 (missingDraftResponse).
      expect((await fetch(`${server.url}/api/draft`)).status).toBe(204);
    } finally {
      server.stop();
    }
  });

  test("the platform path's status post (a review posted to GitHub/GitLab) is never refused", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, agentPresence: () => "gone" });
    try {
      expect((await send(server.url, { approved: false, feedback: "Posted on GitHub.", annotations: [], platform: true })).status).toBe(200);
      expect(await server.waitForDecision()).toMatchObject({ platform: true });
    } finally {
      server.stop();
    }
  });

  test("every open tab hears the agent is gone, a tab opened later (a reload) hears it too, and both hear it is back; the draft stays", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, agentPresence: () => "gone" });
    const first = await openStream(server.url);
    let later: Awaited<ReturnType<typeof openStream>> | null = null;
    try {
      await saveDraft(server.url);
      await first.next((event) => event.type === "snapshot");
      expect(server.openTabs()).toBe(1);
      expect(server.setAgentGone(true)).toBe(true);
      expect(await first.next((event) => event.type === "agent-gone")).toEqual({ type: "agent-gone", gone: true });

      later = await openStream(server.url);
      expect(await later.next((event) => event.type === "agent-gone")).toEqual({ type: "agent-gone", gone: true });
      expect(server.openTabs()).toBe(2);

      server.setAgentGone(false);
      expect(await first.next((event) => event.type === "agent-gone")).toEqual({ type: "agent-gone", gone: false });
      expect(await later.next((event) => event.type === "agent-gone")).toEqual({ type: "agent-gone", gone: false });
      // A tab that reconnects after missing it (asleep, offline) hears it is back.
      const reconnected = await openStream(server.url);
      try {
        expect(await reconnected.next((event) => event.type === "agent-gone")).toEqual({ type: "agent-gone", gone: false });
      } finally {
        await reconnected.close();
      }
      // Saying it settles nothing: the draft is still there.
      expect((await (await fetch(`${server.url}/api/draft`)).json()).codeAnnotations).toEqual(DRAFT_COMMENTS);
    } finally {
      await first.close();
      await later?.close();
      server.stop();
    }
  });

  test("a review whose agent was never said to be gone tells a new tab nothing about it", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML });
    const tab = await openStream(server.url);
    try {
      await tab.next((event) => event.type === "snapshot");
      server.setAgentGone(true);
      // The first agent-gone this tab hears is the change, not a "here" on connect.
      expect(await tab.next((event) => event.type === "agent-gone")).toEqual({ type: "agent-gone", gone: true });
    } finally {
      await tab.close();
      server.stop();
    }
  });

  // H3: the server asks on every Send; a gone answer is never remembered.
  test("asks on every Send: refused while gone, delivered once the agent is back", async () => {
    let presence: "here" | "gone" = "gone";
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, project: "demo", agentPresence: () => presence });
    try {
      await saveDraft(server.url);
      expect((await send(server.url)).status).toBe(410);
      presence = "here";
      expect((await send(server.url)).status).toBe(200);
      expect(await server.waitForDecision()).toMatchObject({ feedback: "Fix a.ts" });
    } finally {
      server.stop();
    }
  });

  test("a review with no agent session to send to says so, not that an agent is gone", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, agentPresence: () => "no-session" });
    try {
      const refused = await send(server.url);
      expect(refused.status).toBe(410);
      expect(await refused.json()).toMatchObject({ code: "no_session" });
    } finally {
      server.stop();
    }
  });

  // M1: the CLI must not end a review that was decided.
  test("saying the agent is gone after a decision does nothing and says so", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, agentPresence: () => "here" });
    try {
      expect(server.setAgentGone(false)).toBe(true);
      expect((await send(server.url)).status).toBe(200);
      expect(server.setAgentGone(true)).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("a server without the probe takes every decision as before", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML });
    try {
      expect((await send(server.url)).status).toBe(200);
    } finally {
      server.stop();
    }
  });
});
