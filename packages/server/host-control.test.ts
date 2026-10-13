/**
 * Host-only session control on the real Bun servers (`/api/host/status`,
 * `/api/host/close`; packages/shared/host-control.ts).
 *
 * What regresses if this fails: an agent closing a review deletes the
 * reviewer's unsent comments, delivers a decision it should not, reaches a
 * server without its launch token or from a browser page, or closes a plan
 * review; or the tab never learns the review was closed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";
import { resolveHostControlToken } from "./host-control";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const TOKEN = "t".repeat(40);
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_FEEDBACK_HISTORY", "PLANNOTATOR_ANNOTATE_HISTORY"] as const;
const saved: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  const dir = mkdtempSync(join(tmpdir(), "plannotator-host-control-"));
  tempDirs.push(dir);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_FEEDBACK_HISTORY = "0";
  process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
  delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const auth = { Authorization: `Bearer ${TOKEN}` };
const status = (url: string, headers: Record<string, string> = auth) => fetch(`${url}/api/host/status`, { headers });
const close = (url: string, headers: Record<string, string> = auth) => fetch(`${url}/api/host/close`, { method: "POST", headers });
const saveDraft = (url: string, draft: Record<string, unknown>) =>
  fetch(`${url}/api/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
const loadDraft = (url: string) => fetch(`${url}/api/draft`);

/** Read SSE `data:` events from the external-annotation stream until `want` matches one. */
async function waitForEvent(url: string, want: (event: Record<string, unknown>) => boolean, act: () => Promise<void>) {
  const response = await fetch(`${url}/api/external-annotations/stream`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // The first event (snapshot) proves the stream is subscribed before we act.
  let acted = false;
  const deadline = Date.now() + 3000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (!chunk.startsWith("data: ")) continue;
        const event = JSON.parse(chunk.slice(6)) as Record<string, unknown>;
        if (want(event)) return event;
      }
      if (!acted) {
        acted = true;
        await act();
      }
    }
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

describe("host control: annotate", () => {
  const start = (options: Partial<Parameters<typeof startAnnotateServer>[0]> = {}) =>
    startAnnotateServer({
      markdown: `# Host control ${Math.random()}`,
      filePath: join(tmpdir(), "notes.md"),
      htmlContent: MINIMAL_HTML,
      hostControlToken: TOKEN,
      ...options,
    });

  test("guards: off without a token, refused from a browser page or with the wrong token", async () => {
    const off = await start({ hostControlToken: undefined });
    try {
      const answer = await close(off.url);
      expect(answer.status).toBe(404);
      // Coded, so the mod does not mistake it for an older CLI and TERM it.
      expect((await answer.json()).code).toBe("host_control_disabled");
    } finally {
      off.stop();
    }
    const server = await start();
    try {
      expect((await status(server.url, { ...auth, Origin: server.url })).status).toBe(403);
      expect((await status(server.url, { Authorization: "Bearer wrong" })).status).toBe(401);
      expect((await status(server.url, {})).status).toBe(401);
      expect((await close(server.url, {})).status).toBe(401);
      expect((await fetch(`${server.url}/api/host/close`, { headers: auth })).status).toBe(405);
    } finally {
      server.stop();
    }
  });

  test("status counts the draft; close keeps it, settles as an agent dismissal, and tells the tab", async () => {
    const server = await start();
    try {
      await saveDraft(server.url, { annotations: [{ id: "a1" }, { id: "a2" }], codeAnnotations: [], globalAttachments: [] });
      const before = await (await status(server.url)).json();
      expect(before).toMatchObject({ kind: "annotate", unsentAnnotations: 2, decided: false });
      expect(before.documents).toEqual([join(tmpdir(), "notes.md")]);

      let closeBody: unknown;
      const event = await waitForEvent(server.url, (e) => e.type === "session-closed", async () => {
        const response = await close(server.url);
        expect(response.status).toBe(200);
        closeBody = await response.json();
      });
      expect(closeBody).toEqual({ unsentAnnotations: 2 });
      expect(event).toEqual({ type: "session-closed", by: "agent", unsentAnnotations: 2 });

      const decision = await server.waitForDecision();
      expect(decision).toMatchObject({ exit: true, closedBy: "agent", unsentAnnotations: 2 });
      // The reviewer's comments survive the close.
      const draft = await (await loadDraft(server.url)).json();
      expect(draft.annotations).toHaveLength(2);

      // A second close (or a late reviewer decision) loses.
      expect((await close(server.url)).status).toBe(409);
      expect((await status(server.url).then((r) => r.json())).decided).toBe(true);
      expect((await fetch(`${server.url}/api/exit`, { method: "POST" })).status).toBe(409);
    } finally {
      server.stop();
    }
  });

  test("in-process control matches the endpoints", async () => {
    const server = await start({ hostControlToken: undefined });
    try {
      expect(server.hostControl.close?.()).toEqual({ closed: true, unsentAnnotations: 0 });
      expect(server.hostControl.close?.()).toEqual({ closed: false, reason: "decided" });
    } finally {
      server.stop();
    }
  });
});

describe("host control: remote mode", () => {
  // The failure: a remote session (reachable beyond loopback) answers host
  // control with the launch token.
  test("remote mode turns the endpoints off even with a token", () => {
    process.env.PLANNOTATOR_REMOTE = "1";
    expect(resolveHostControlToken(TOKEN)).toBeUndefined();
    process.env.PLANNOTATOR_REMOTE = "0";
    expect(resolveHostControlToken(TOKEN)).toBe(TOKEN);
  });
});

describe("host control: review", () => {
  test("close keeps the draft and settles as an agent dismissal", async () => {
    const server = await startReviewServer({
      rawPatch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
      gitRef: "HEAD",
      htmlContent: MINIMAL_HTML,
      origin: "claude-code",
      hostControlToken: TOKEN,
    } as Parameters<typeof startReviewServer>[0]);
    try {
      await saveDraft(server.url, { annotations: [], codeAnnotations: [{ id: "c1" }], globalAttachments: [] });
      expect(await (await status(server.url)).json()).toMatchObject({ kind: "review", unsentAnnotations: 1, decided: false });
      const response = await close(server.url);
      expect(await response.json()).toEqual({ unsentAnnotations: 1 });
      expect(await server.waitForDecision()).toMatchObject({ approved: false, exit: true, closedBy: "agent" });
      const draft = await (await loadDraft(server.url)).json();
      expect(draft.codeAnnotations).toHaveLength(1);
      expect((await close(server.url)).status).toBe(409);

      // The tab still open after the close: its late decision is refused
      // rather than answered ok, and must not delete the kept draft.
      const feedback = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false, feedback: "late", annotations: [{ id: "c1" }] }),
      });
      expect(feedback.status).toBe(409);
      expect((await fetch(`${server.url}/api/exit`, { method: "POST" })).status).toBe(409);
      expect((await (await loadDraft(server.url)).json()).codeAnnotations).toHaveLength(1);
    } finally {
      server.stop();
    }
  });
});

describe("host control: plan", () => {
  test("status answers; a plan review cannot be closed by the host", async () => {
    const server = await startPlannotatorServer({
      plan: `# Plan ${Math.random()}\n\n- step\n`,
      htmlContent: MINIMAL_HTML,
      origin: "claude-code",
      hostControlToken: TOKEN,
    });
    try {
      expect(await (await status(server.url)).json()).toMatchObject({ kind: "plan", decided: false });
      const response = await close(server.url);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("not_closable");
    } finally {
      await server.stop();
    }
  });
});
