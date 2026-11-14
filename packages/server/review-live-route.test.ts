import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewConversations } from "@plannotator/core/review-threads";
import { INBOX_BRIDGE_POLL_PATH, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { startInboxServer, type InboxServer } from "./inbox";
import { getVcsContext } from "./vcs";

const HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const dirs: string[] = [];
const inboxes: InboxServer[] = [];
const saved: Record<string, string | undefined> = {};

const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const setEnv = (key: string, value: string) => {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
};

afterEach(() => {
  for (const inbox of inboxes.splice(0)) inbox.stop();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

function repo() {
  const dir = temp("plannotator-live-route-repo-");
  const git = (...args: string[]) => expect(spawnSync("git", args, { cwd: dir }).status).toBe(0);
  git("init", "-q");
  git("checkout", "-qb", "fix/charge");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "a.ts"), "a\n");
  git("add", ".");
  git("commit", "-qm", "one");
  return dir;
}

for (const [runtime, start] of [["Bun", startBunReviewServer], ["Pi", startPiReviewServer]] as const) {
  describe(`a review reaches its agents through the Inbox (${runtime})`, () => {
    test("send a comment, the agent is woken, state shows it; resolve it", async () => {
      setEnv("PLANNOTATOR_AI", "disabled");
      setEnv("PLANNOTATOR_DATA_DIR", temp("plannotator-live-route-data-"));
      setEnv("PLANNOTATOR_PORT", String(await freePort()));
      const dataDir = temp("plannotator-live-route-inbox-");
      const project = repo();
      const inbox = await startInboxServer({ dataDir, binaryPath: null });
      inboxes.push(inbox);
      const poll = async () =>
        parseInboxBridgeCommands(
          await (
            await fetch(`http://127.0.0.1:${inbox.port}${INBOX_BRIDGE_POLL_PATH}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${inbox.token}` },
              body: JSON.stringify({ session: "ses-pi", host: "pi", waitMs: 0, project_path: project, started_at: Date.now(), busy: false, tags: true }),
            })
          ).text(),
        );
      await poll();
      const server = await start({
        rawPatch: PATCH,
        gitRef: "HEAD",
        htmlContent: HTML,
        gitContext: await getVcsContext(project, "git"),
        diffType: "uncommitted",
        gitRemoteCheck: false,
        liveReviewAgent: { host: "pi", session: "ses-pi" },
        liveReviewDataDir: dataDir,
      });
      try {
        const state = await (await fetch(`${server.url}/api/live/state`)).json();
        expect(state).toMatchObject({ inbox: true, review: { key: "branch:fix/charge", title: "fix/charge" }, launched_by: { host: "pi", session: "ses-pi" }, thread: null });
        const agents = await (await fetch(`${server.url}/api/live/agents`)).json();
        expect(agents.agents).toContainEqual(expect.objectContaining({ host: "pi", session: "ses-pi", here: true }));
        const sent = await fetch(`${server.url}/api/live/send`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ comments: [{ anchor: { file: "a.ts", side: "new", line_start: 1, line_end: 1, code: ["b"] }, words: "Why b?" }], idempotency_key: "k1" }),
        });
        expect(sent.status).toBe(200);
        const id = (await sent.json()).sent[0] as string;
        expect((await poll()).map((c) => c.id)).toEqual([id]);
        const resolved = await fetch(`${server.url}/api/live/resolve/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolved: true }) });
        expect(resolved.status).toBe(200);
        const after = await (await fetch(`${server.url}/api/live/state`)).json();
        const [conversation] = reviewConversations(after.messages);
        expect(conversation).toMatchObject({ id, anchor: { file: "a.ts" } });
        expect(conversation!.resolved).not.toBeNull();
      } finally {
        server.stop();
      }
    }, 30_000);

    test("with no Inbox running, the review says so and nothing is sent", async () => {
      setEnv("PLANNOTATOR_AI", "disabled");
      setEnv("PLANNOTATOR_DATA_DIR", temp("plannotator-live-route-data-"));
      setEnv("PLANNOTATOR_PORT", String(await freePort()));
      const server = await start({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: HTML, gitContext: await getVcsContext(repo(), "git"), diffType: "uncommitted", gitRemoteCheck: false, liveReviewDataDir: temp("plannotator-live-route-none-") });
      try {
        expect(await (await fetch(`${server.url}/api/live/state`)).json()).toMatchObject({ inbox: false, thread: null, launched_by: null });
        const sent = await fetch(`${server.url}/api/live/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comments: [], idempotency_key: "k" }) });
        expect(sent.status).toBe(503);
      } finally {
        server.stop();
      }
    }, 30_000);
  });
}
