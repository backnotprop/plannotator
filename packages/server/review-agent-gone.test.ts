/**
 * Send never pretends (packages/shared/review-agent-gone.ts), on the Bun
 * review server. The Pi mirror is apps/pi-extension/server/review-agent-gone.test.ts.
 *
 * What regresses if this fails: Send to an agent that is gone answers ok,
 * deletes the reviewer's draft and archives feedback nobody receives (the
 * silent loss); or Send to a live agent stops deleting the draft; or a PR
 * review's post to the platform is refused for want of an agent; or the open
 * tab never hears that the review ended.
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

  test("the open tab hears that the review ended because its agent is gone, with its unsent count", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, agentPresence: () => "gone" });
    const response = await fetch(`${server.url}/api/external-annotations/stream`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      await saveDraft(server.url);
      let buffer = "";
      let announced = false;
      const deadline = Date.now() + 3000;
      let found: Record<string, unknown> | null = null;
      while (!found && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const chunk of buffer.split("\n\n").slice(0, -1)) {
          if (!chunk.startsWith("data: ")) continue;
          const event = JSON.parse(chunk.slice(6)) as Record<string, unknown>;
          if (event.type === "session-closed") found = event;
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
        if (!announced) {
          announced = true;
          server.announceAgentGone();
        }
      }
      expect(found).toEqual({ type: "session-closed", by: "gone", unsentAnnotations: DRAFT_COMMENTS.length });
      // Announcing settles nothing: the draft is still there for a reopen.
      expect((await (await fetch(`${server.url}/api/draft`)).json()).codeAnnotations).toEqual(DRAFT_COMMENTS);
    } finally {
      await reader.cancel().catch(() => undefined);
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
  test("announcing after a decision does nothing and says so", async () => {
    const server = await startReviewServer({ rawPatch: patch(), gitRef: "HEAD", htmlContent: MINIMAL_HTML, agentPresence: () => "here" });
    try {
      expect(server.announceAgentGone()).toBe(true);
      expect((await send(server.url)).status).toBe(200);
      expect(server.announceAgentGone()).toBe(false);
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
