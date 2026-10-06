/**
 * Stale-tab guard (packages/core/server-session.ts), both runtimes.
 *
 * Regression guarded: a tab left open on a port that a NEW Plannotator server
 * now owns (fixed PLANNOTATOR_PORT, remote mode's 19432, a rare random-port
 * reuse) posted its decision to the new server, which accepted it: the
 * reviewer "approved" a document they never saw. Every decision body now
 * echoes the nonce its tab loaded; a different one must be refused with
 * 409 session_mismatch BEFORE anything settles (the session stays open for
 * its own tab), the matching one must still settle, and a body without one
 * (an older client, an empty exit) must keep working.
 *
 * Temp PLANNOTATOR_DATA_DIR per test; nothing touches the real data dir.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer as startBunAnnotateServer } from "./annotate";
import { startReviewServer as startBunReviewServer } from "./review";
import {
  startAnnotateServer as startPiAnnotateServer,
  startPlanReviewServer as startPiPlanServer,
  startReviewServer as startPiReviewServer,
} from "../../apps/pi-extension/server";
import { SERVER_SESSION_MISMATCH_CODE } from "@plannotator/shared/server-session";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/parse.ts b/src/parse.ts\n@@ -1 +1 @@\n-a\n+b\n";
const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_AI", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE"] as const;

let saved: Record<string, string | undefined> | null = null;
const tempDirs: string[] = [];

function sandbox(): string {
  if (!saved) {
    saved = {};
    for (const key of ENV_KEYS) saved[key] = process.env[key];
  }
  const dir = mkdtempSync(join(tmpdir(), "plannotator-server-session-"));
  tempDirs.push(dir);
  process.env.PLANNOTATOR_DATA_DIR = dir;
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_REMOTE = "0";
  delete process.env.PLANNOTATOR_PORT;
  return dir;
}

afterEach(() => {
  if (saved) {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
    saved = null;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Running {
  url: string;
  stop(): void | Promise<void>;
  waitForDecision(): Promise<unknown>;
}

type Surface = "plan" | "annotate" | "review";

interface Case {
  name: string;
  surface: Surface;
  start: (dir: string) => Promise<Running>;
  /** The payload that advertises the nonce. */
  payloadPath: "/api/plan" | "/api/diff";
  /** Decision posts with a JSON body. */
  decisions: Array<{ path: string; body: Record<string, unknown> }>;
}

const planDecisions = [
  { path: "/api/approve", body: { planSave: { enabled: false } } },
  { path: "/api/deny", body: { feedback: "no", planSave: { enabled: false } } },
];
const annotateDecisions = [
  { path: "/api/approve", body: {} },
  { path: "/api/feedback", body: { feedback: "note", annotations: [] } },
];
const reviewDecisions = [{ path: "/api/feedback", body: { approved: false, feedback: "fix", annotations: [] } }];

function planText(): string {
  return `# Server session guard ${Math.random().toString(36).slice(2, 10)}\n\nStep.\n`;
}

function docFile(dir: string): string {
  const file = join(dir, "doc.md");
  writeFileSync(file, "# Doc\n");
  return file;
}

const cases: Case[] = [
  {
    name: "Bun plan",
    surface: "plan",
    start: async () => (await startPlannotatorServer({ plan: planText(), htmlContent: MINIMAL_HTML, origin: "claude-code" })) as unknown as Running,
    payloadPath: "/api/plan",
    decisions: planDecisions,
  },
  {
    name: "Pi plan",
    surface: "plan",
    start: async () => (await startPiPlanServer({ plan: planText(), htmlContent: MINIMAL_HTML, origin: "pi" })) as unknown as Running,
    payloadPath: "/api/plan",
    decisions: planDecisions,
  },
  {
    name: "Bun annotate",
    surface: "annotate",
    start: async (dir) =>
      (await startBunAnnotateServer({ markdown: "# Doc\n", filePath: docFile(dir), htmlContent: MINIMAL_HTML, gate: true })) as unknown as Running,
    payloadPath: "/api/plan",
    decisions: annotateDecisions,
  },
  {
    name: "Pi annotate",
    surface: "annotate",
    start: async (dir) =>
      (await startPiAnnotateServer({ markdown: "# Doc\n", filePath: docFile(dir), htmlContent: MINIMAL_HTML, gate: true })) as unknown as Running,
    payloadPath: "/api/plan",
    decisions: annotateDecisions,
  },
  {
    name: "Bun review",
    surface: "review",
    start: async () =>
      (await startBunReviewServer({ rawPatch: PATCH, gitRef: "HEAD", origin: "claude-code", htmlContent: MINIMAL_HTML })) as unknown as Running,
    payloadPath: "/api/diff",
    decisions: reviewDecisions,
  },
  {
    name: "Pi review",
    surface: "review",
    start: async () =>
      (await startPiReviewServer({ rawPatch: PATCH, gitRef: "HEAD", origin: "pi", htmlContent: MINIMAL_HTML })) as unknown as Running,
    payloadPath: "/api/diff",
    decisions: reviewDecisions,
  },
];

async function post(url: string, body?: Record<string, unknown>) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function nonceOf(server: Running, path: string): Promise<string> {
  const payload = (await (await fetch(`${server.url}${path}`)).json()) as { serverSession?: unknown };
  expect(typeof payload.serverSession).toBe("string");
  return payload.serverSession as string;
}

/** Whether the decision promise settled within a short wait. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 150))]);
}

for (const c of cases) {
  describe(`${c.name}: decisions carry the server session`, () => {
    test("each server start advertises its own nonce", async () => {
      const dir = sandbox();
      const a = await c.start(dir);
      const b = await c.start(dir);
      try {
        expect(await nonceOf(a, c.payloadPath)).not.toBe(await nonceOf(b, c.payloadPath));
      } finally {
        await a.stop();
        await b.stop();
      }
    });

    for (const decision of c.decisions) {
      test(`${decision.path}: a foreign nonce is refused with 409 and nothing settles`, async () => {
        const server = await c.start(sandbox());
        try {
          const pending = server.waitForDecision();
          const refused = await post(`${server.url}${decision.path}`, { ...decision.body, serverSession: "0".repeat(32) });
          expect(refused.status).toBe(409);
          expect(((await refused.json()) as { code?: string }).code).toBe(SERVER_SESSION_MISMATCH_CODE);
          expect(await settled(pending)).toBe(false);
          // The session is still open for its own tab.
          const nonce = await nonceOf(server, c.payloadPath);
          const accepted = await post(`${server.url}${decision.path}`, { ...decision.body, serverSession: nonce });
          expect(accepted.status).toBe(200);
          expect(await settled(pending)).toBe(true);
        } finally {
          await server.stop();
        }
      });

      test(`${decision.path}: a body without a nonce (older client) is accepted`, async () => {
        const server = await c.start(sandbox());
        try {
          const pending = server.waitForDecision();
          const response = await post(`${server.url}${decision.path}`, decision.body);
          expect(response.status).toBe(200);
          expect(await settled(pending)).toBe(true);
        } finally {
          await server.stop();
        }
      });
    }

    if (c.surface !== "plan") {
      test("/api/exit: the nonce rides the query; foreign refused, missing accepted", async () => {
        const server = await c.start(sandbox());
        try {
          const pending = server.waitForDecision();
          const refused = await post(`${server.url}/api/exit?serverSession=${"f".repeat(32)}`);
          expect(refused.status).toBe(409);
          expect(await settled(pending)).toBe(false);
          const accepted = await post(`${server.url}/api/exit`);
          expect(accepted.status).toBe(200);
          expect(await settled(pending)).toBe(true);
        } finally {
          await server.stop();
        }
      });
    }
  });
}

// /api/pr-action posts a review to GitHub/GitLab/Bitbucket: a stale tab of an
// earlier session on this port must not post through this one's PR.
const PR_METADATA = {
  platform: "github",
  host: "github.invalid",
  owner: "acme",
  repo: "widgets",
  number: 42,
  title: "Guard",
  author: "someone",
  baseBranch: "main",
  headBranch: "feature",
  baseSha: "base",
  headSha: "head",
  url: "https://github.invalid/acme/widgets/pull/42",
} as const;

for (const runtime of ["bun", "pi"] as const) {
  describe(`${runtime} review /api/pr-action`, () => {
    test("a foreign nonce is refused before anything is posted; the matching one posts", async () => {
      sandbox();
      const posted: unknown[] = [];
      const submitter = (async (...args: unknown[]) => {
        posted.push(args);
        return { ok: true };
      }) as never;
      const options = {
        rawPatch: PATCH,
        gitRef: "PR #42",
        htmlContent: MINIMAL_HTML,
        prMetadata: PR_METADATA as never,
        prReviewSubmitter: submitter,
      };
      const server = runtime === "bun" ? await startBunReviewServer(options) : await startPiReviewServer(options as never);
      try {
        const nonce = await nonceOf(server as never, "/api/diff");
        const body = { action: "comment", body: "Looks off.", fileComments: [] };
        const refused = await post(`${server.url}/api/pr-action`, { ...body, serverSession: "0".repeat(32) });
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as { code?: string }).code).toBe(SERVER_SESSION_MISMATCH_CODE);
        expect(posted).toHaveLength(0);
        const accepted = await post(`${server.url}/api/pr-action`, { ...body, serverSession: nonce });
        expect(accepted.status).not.toBe(409);
        expect(posted).toHaveLength(1);
      } finally {
        await server.stop();
      }
    });
  });
}
