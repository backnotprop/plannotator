/**
 * A code review whose agent quit, as the real process tree. The agent reads
 * the review's stdout through a named pipe (`cat`), as an agent's shell does,
 * and the review is started in the background by a shell that then exits, so
 * it is reparented at once (`plannotator review &`, nohup, an agent's
 * background shell).
 *
 * What regresses if this fails:
 * - a backgrounded review whose agent still reads it is ended under the
 *   agent (reparenting taken for "gone");
 * - the local review ends while its tab is still open (a reload finds
 *   nothing), the tab is never told nobody can take a Send, or the review
 *   keeps its server forever after its reader quit and its tab was closed
 *   (the pile of leftover programs), or deletes the reviewer's comments as it ends;
 * - opening the same review again no longer brings the comments back;
 * - Send to the gone agent answers ok (the silent loss), or Send to a live
 *   agent stops deleting the draft;
 * - a PR review stops staying open, though it can still post to the platform
 *   with no agent.
 *
 * Every process started here is killed in `finally` (and again in afterAll)
 * by its exact pid, and a watchdog shell kills the review if this test
 * runner itself is killed first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
/** Every pid started here, killed again after the file (a test that timed out skips its own finally). */
const started = new Set<number>();
afterAll(() => {
  for (const pid of started) kill(pid);
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

/**
 * The agent: `cat` reads the review's stdout from a named pipe; a shell starts
 * the review in the background with its stdout on that pipe, prints its pid
 * and exits two seconds later (after the review read its parent), so the
 * review is reparented while `cat` still reads it. A watchdog shell kills the
 * review once this test runner is gone.
 */
let launches = 0;
async function backgrounded(root: string, env: Record<string, string | undefined>, reviewArgs: string[]) {
  launches += 1;
  const fifo = join(root, `stdout-${launches}`);
  if (spawnSync("mkfifo", [fifo]).status !== 0) throw new Error("mkfifo failed");
  const reader = Bun.spawn(["cat", fifo], { stdout: "pipe", stderr: "ignore" });
  started.add(reader.pid);
  const script = [
    'runner=$1; out=$2; shift 2',
    '"$@" > "$out" &',
    'cli=$!',
    '( while kill -0 "$runner" 2>/dev/null && kill -0 "$cli" 2>/dev/null; do sleep 1; done; kill -9 "$cli" 2>/dev/null ) </dev/null >/dev/null 2>&1 &',
    'echo "$cli $!"',
    'sleep 2',
  ].join("\n");
  const launcher = Bun.spawn(["/bin/sh", "-c", script, "agent", String(process.pid), fifo, process.execPath, "run", entry, "review", ...reviewArgs], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  started.add(launcher.pid);
  const [cliPid, watchdogPid] = (await new Response(launcher.stdout).text()).trim().split(/\s+/).map(Number);
  if (!Number.isInteger(cliPid) || cliPid <= 1) throw new Error("no review pid");
  started.add(cliPid);
  if (Number.isInteger(watchdogPid) && watchdogPid > 1) started.add(watchdogPid);
  await launcher.exited;
  return { reader, cliPid, watchdogPid, readerOutput: () => new Response(reader.stdout).text() };
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

describe("a local review started in the background", () => {
  test("lives while its agent still reads it, and its Send is delivered there", async () => {
    const { root, dataDir } = workspace();
    const ready = join(root, "ready-live");
    let run: Awaited<ReturnType<typeof backgrounded>> | undefined;
    try {
      run = await backgrounded(root, cliEnv(root, dataDir, ready), ["--patch-file", "change.patch"]);
      const base = await baseOf(ready);
      expect((await saveDraft(base)).status).toBe(200);
      // Reparented (its shell exited) for longer than a look: still here.
      await Bun.sleep(PARENT_CHECK_MS + 3_000);
      expect(alive(run.cliPid)).toBe(true);
      expect((await fetch(`${base}/api/diff`)).status).toBe(200);

      expect((await send(base)).status).toBe(200);
      expect(await run.readerOutput()).toContain("Why 2?");
      const reviewPid = run.cliPid;
      await waitFor(() => !alive(reviewPid), 10_000, "the review to exit after its decision");
    } finally {
      kill(run?.cliPid);
      kill(run?.reader.pid);
      kill(run?.watchdogPid);
    }
  }, 40_000);
});

/** A tab's event stream on the review: the `agent-gone` events it hears, in order. */
async function tabStream(base: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/external-annotations/stream`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const heard: boolean[] = [];
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue;
          const event = JSON.parse(chunk.slice(6)) as { type?: string; gone?: boolean };
          if (event.type === "agent-gone") heard.push(event.gone === true);
        }
      }
    } catch {
      // Closed.
    }
  })();
  return {
    heard,
    close: () => controller.abort(),
  };
}

describe("a local review whose agent quit", () => {
  test("stays open for its tab, which hears it and keeps its draft (a reload too); Send is refused; once the tab is closed it ends, and the comments come back when the same review is opened again", async () => {
    const { root, dataDir } = workspace();
    const firstReady = join(root, "ready-1");
    const secondReady = join(root, "ready-2");
    let run: Awaited<ReturnType<typeof backgrounded>> | undefined;
    let reopened: ReturnType<typeof Bun.spawn> | undefined;
    let tab: Awaited<ReturnType<typeof tabStream>> | undefined;
    try {
      // The grace with no tab open, shortened for this run (sandbox only).
      run = await backgrounded(root, cliEnv(root, dataDir, firstReady, { PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_TEST_REVIEW_NO_TAB_MS: "3000" }), ["--patch-file", "change.patch"]);
      const base = await baseOf(firstReady);
      expect((await saveDraft(base)).status).toBe(200);
      tab = await tabStream(base);

      // The agent quits: nobody reads the review's stdout any more.
      kill(run.reader.pid);
      await run.reader.exited;

      // Send now: the truth, and nothing lost.
      const refused = await send(base);
      expect(refused.status).toBe(410);
      expect(await refused.json()).toMatchObject({ code: "agent_gone" });

      // The tab hears it at the next look, and the review stays open for it.
      const firstTab = tab;
      await waitFor(() => firstTab.heard.includes(true), PARENT_CHECK_MS + 8_000, "the tab to hear the agent is gone");
      await Bun.sleep(5_000);
      expect(alive(run.cliPid)).toBe(true);

      // A reload: the new tab hears it at once, and the draft is all there.
      firstTab.close();
      tab = await tabStream(base);
      const reloaded = tab;
      await waitFor(() => reloaded.heard.includes(true), 3_000, "the reloaded tab to hear the agent is gone");
      const kept = await (await fetch(`${base}/api/draft`)).json();
      expect(kept.codeAnnotations[0].text).toBe("Why 2?");
      expect(alive(run.cliPid)).toBe(true);

      // The tab is closed: the program quits by itself once the grace passed.
      reloaded.close();
      const reviewPid = run.cliPid;
      await waitFor(() => !alive(reviewPid), PARENT_CHECK_MS * 2 + 8_000, "the review to exit");

      // Opened again (by an agent that is here): the comments are offered back.
      reopened = Bun.spawn([process.execPath, "run", entry, "review", "--patch-file", "change.patch"], {
        cwd: root,
        env: cliEnv(root, dataDir, secondReady),
        stdout: "pipe",
        stderr: "pipe",
      });
      started.add(reopened.pid);
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
      tab?.close();
      kill(run?.cliPid);
      kill(run?.reader.pid);
      kill(run?.watchdogPid);
      kill(reopened?.pid);
    }
  }, 80_000);
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
    let run: Awaited<ReturnType<typeof backgrounded>> | undefined;
    try {
      run = await backgrounded(
        root,
        cliEnv(root, dataDir, readyFile, {
          PLANNOTATOR_TEST_SANDBOX: "1",
          PLANNOTATOR_TEST_REVIEW_NO_TAB_MS: "1000",
          PLANNOTATOR_BITBUCKET_API_URL: fake.apiUrl,
          PLANNOTATOR_BITBUCKET_EMAIL: EMAIL,
          PLANNOTATOR_BITBUCKET_TOKEN: TOKEN,
        }),
        ["https://bitbucket.org/ws/repo/pull-requests/1", "--no-local"],
      );
      const base = await baseOf(readyFile);

      kill(run.reader.pid);
      await run.reader.exited;
      // No tab has it open, for longer than a local review waits before it ends.
      await Bun.sleep(PARENT_CHECK_MS + 5_000);
      expect(alive(run.cliPid)).toBe(true);
      // A tab opened now hears that nobody can take a Send.
      const tab = await tabStream(base);
      await waitFor(() => tab.heard.includes(true), 3_000, "the tab to hear the agent is gone");
      tab.close();
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
      kill(run?.cliPid);
      kill(run?.reader.pid);
      kill(run?.watchdogPid);
    }
  }, 50_000);
});
