/**
 * A code review whose agent quit, as the real process tree: the agent is a
 * shell that runs `plannotator review` with its stdout on a pipe (as an
 * agent's shell command does) and is then killed.
 *
 * What regresses if this fails:
 * - the local review keeps its server forever after its agent quit (the pile
 *   of leftover programs), or deletes the reviewer's comments as it ends;
 * - opening the same review again no longer brings the comments back;
 * - Send to the gone agent answers ok (the silent loss), or Send to a live
 *   agent stops deleting the draft;
 * - a PR review stops staying open, though it can still post to the platform
 *   with no agent.
 *
 * Every process started here is killed in `finally` by its exact pid.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { startFakeBitbucket, type FakeBitbucket } from "../../../tests/test-fixtures/bitbucket/fake-bitbucket";
import { PARENT_CHECK_MS } from "./orphan-plan-review";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];

const PATCH = [
  "diff --git a/app.ts b/app.ts",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1 +1 @@",
  "-export const a = 1;",
  "+export const a = 2;",
  "",
].join("\n");

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kill(pid: number | undefined): void {
  if (!pid || !alive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

async function waitFor<T>(read: () => T | null | undefined, ms: number, what: string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-agent-gone-cli-")));
  roots.push(root);
  writeFileSync(join(root, "change.patch"), PATCH);
  return { root, dataDir: join(root, "data") };
}

function cliEnv(root: string, dataDir: string, readyFile: string, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PLANNOTATOR_CWD: root,
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_READY_FILE: readyFile,
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_SHARE: "disabled",
    PLANNOTATOR_FEEDBACK_HISTORY: "0",
    PLANNOTATOR_REVIEW_PROGRESS: "0",
    ...extra,
  };
  delete env.PLANNOTATOR_HOST_RESULT_FILE;
  delete env.PLANNOTATOR_REVIEW_LIVE_THREAD;
  return env;
}

async function baseOf(readyFile: string): Promise<string> {
  const line = await waitFor(() => (existsSync(readyFile) ? readFileSync(readyFile, "utf8").split("\n")[0] : null), 20_000, "the review server");
  return `http://localhost:${(JSON.parse(line) as { port: number }).port}`;
}

/** The agent: a shell that starts the review in the background, prints its pid, and waits. */
async function underAgentShell(root: string, env: Record<string, string | undefined>, reviewArgs: string[]) {
  const agent = Bun.spawn(["/bin/sh", "-c", '"$@" & echo "$!"; wait', "agent", process.execPath, "run", entry, "review", ...reviewArgs], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = agent.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const cliPid = Number(text.trim().split("\n")[0]);
  if (!Number.isInteger(cliPid) || cliPid <= 1) throw new Error(`no review pid: ${JSON.stringify(text)}`);
  return { agent, cliPid };
}

const json = { "Content-Type": "application/json" };
const saveDraft = (base: string) =>
  fetch(`${base}/api/draft`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ annotations: [], codeAnnotations: [{ id: "c1", filePath: "app.ts", lineStart: 1, lineEnd: 1, side: "new", type: "comment", text: "Why 2?" }], globalAttachments: [] }),
  });
const send = (base: string) =>
  fetch(`${base}/api/feedback`, { method: "POST", headers: json, body: JSON.stringify({ approved: false, feedback: "Why 2?", annotations: [{ id: "c1" }] }) });

describe("a local review whose agent quit", () => {
  test("refuses Send, ends by itself keeping the draft, and the comments come back when the same review is opened again", async () => {
    const { root, dataDir } = workspace();
    const firstReady = join(root, "ready-1");
    const secondReady = join(root, "ready-2");
    let agentPid: number | undefined;
    let cliPid: number | undefined;
    let reopened: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const run = await underAgentShell(root, cliEnv(root, dataDir, firstReady), ["--patch-file", "change.patch"]);
      agentPid = run.agent.pid;
      cliPid = run.cliPid;
      const base = await baseOf(firstReady);
      expect((await saveDraft(base)).status).toBe(200);

      // The agent quits.
      kill(agentPid);
      await run.agent.exited;

      // Send now: the truth, and nothing lost.
      const refused = await send(base);
      expect(refused.status).toBe(410);
      expect(await refused.json()).toMatchObject({ code: "agent_gone" });

      // The program quits by itself at its next look.
      const reviewPid = cliPid;
      await waitFor(() => !alive(reviewPid), PARENT_CHECK_MS + 8_000, "the review to exit");

      // Opened again (by an agent that is here): the comments are offered back.
      reopened = Bun.spawn([process.execPath, "run", entry, "review", "--patch-file", "change.patch"], {
        cwd: root,
        env: cliEnv(root, dataDir, secondReady),
        stdout: "pipe",
        stderr: "pipe",
      });
      const again = await baseOf(secondReady);
      const draft = await (await fetch(`${again}/api/draft`)).json();
      expect(draft.codeAnnotations).toHaveLength(1);
      expect(draft.codeAnnotations[0].text).toBe("Why 2?");

      // Send to this live agent: delivered on stdout, and the draft is settled.
      expect((await send(again)).status).toBe(200);
      expect((await fetch(`${again}/api/draft`)).status).toBe(204);
      expect(await reopened.exited).toBe(0);
      expect(await new Response(reopened.stdout).text()).toContain("Why 2?");
    } finally {
      kill(agentPid);
      kill(cliPid);
      kill(reopened?.pid);
    }
  }, 40_000);
});

describe("a PR review whose agent quit", () => {
  let fake: FakeBitbucket | undefined;
  afterAll(() => fake?.stop());

  test("stays open: it can still post to the platform, while Send to the agent says it is gone", async () => {
    const { root, dataDir } = workspace();
    const readyFile = join(root, "ready-pr");
    const TOKEN = "fake-token-for-agent-gone-test-1234";
    const EMAIL = "ada@example.invalid";
    fake = startFakeBitbucket({ email: EMAIL, token: TOKEN });
    let agentPid: number | undefined;
    let cliPid: number | undefined;
    try {
      const run = await underAgentShell(
        root,
        cliEnv(root, dataDir, readyFile, {
          PLANNOTATOR_BITBUCKET_API_URL: fake.apiUrl,
          PLANNOTATOR_BITBUCKET_EMAIL: EMAIL,
          PLANNOTATOR_BITBUCKET_TOKEN: TOKEN,
        }),
        ["https://bitbucket.org/ws/repo/pull-requests/1", "--no-local"],
      );
      agentPid = run.agent.pid;
      cliPid = run.cliPid;
      const base = await baseOf(readyFile);

      kill(agentPid);
      await run.agent.exited;
      // Longer than a local review takes to end.
      await Bun.sleep(PARENT_CHECK_MS + 3_000);
      expect(alive(cliPid)).toBe(true);
      expect((await fetch(`${base}/api/diff`)).status).toBe(200);

      const posted = await fetch(`${base}/api/pr-action`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ action: "comment", body: "Posted with no agent.", fileComments: [] }),
      });
      expect(posted.status).toBe(200);
      expect(fake.requests.some((r) => r.method === "POST" && JSON.stringify(r.body).includes("Posted with no agent."))).toBe(true);
      expect((await send(base)).status).toBe(410);
    } finally {
      kill(agentPid);
      kill(cliPid);
    }
  }, 40_000);
});
