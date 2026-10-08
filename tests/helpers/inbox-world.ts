/**
 * A temp world for proving an agent connection against a REAL Plannotator
 * Inbox: its own HOME and PLANNOTATOR_DATA_DIR, a project folder, and a
 * `plannotator` on PATH that runs the compiled binary when
 * PLANNOTATOR_INBOX_TEST_BINARY names one (the CI jobs build it with the
 * release flags) and the CLI from source otherwise. The person's Send goes
 * through the route the window posts to. Never touches the real ~/.plannotator.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..");
const cliEntry = join(repoRoot, "apps", "hook", "server", "index.ts");
const distDir = join(repoRoot, "apps", "hook", "dist");

export interface InboxWorld {
  root: string;
  home: string;
  dataDir: string;
  project: string;
  /** A folder holding only the `plannotator` wrapper. */
  bin: string;
  /** PATH with the wrapper first. */
  path: string;
  /** Where the transcript goes, when INBOX_PROOF_DIR is set. */
  proof: (line: string) => void;
}

export function inboxBinary(): string | undefined {
  return process.env.PLANNOTATOR_INBOX_TEST_BINARY || undefined;
}

/** The CLI from source imports the built HTML; the Inbox never serves it. Returns what to remove after. */
export function stubBuiltHtml(): string[] {
  if (inboxBinary()) return [];
  mkdirSync(distDir, { recursive: true });
  const made = ["index.html", "review.html", "inbox.html"].map((name) => join(distDir, name)).filter((path) => !existsSync(path));
  for (const path of made) writeFileSync(path, "<!doctype html><title>test</title>");
  return made;
}

export function createInboxWorld(prefix: string, name: string, proofSubdir: string): InboxWorld {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = join(root, "home");
  const dataDir = join(home, ".plannotator");
  const project = join(root, "refund-service");
  const bin = join(root, "bin");
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const binary = inboxBinary();
  const wrapper = join(bin, "plannotator");
  writeFileSync(wrapper, binary ? `#!/bin/sh\nexec '${binary}' "$@"\n` : `#!/bin/sh\nexec '${process.execPath}' '${cliEntry}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  const proofDir = process.env.INBOX_PROOF_DIR ? join(process.env.INBOX_PROOF_DIR, proofSubdir) : null;
  const proofFile = proofDir ? join(proofDir, `${name}.txt`) : null;
  if (proofFile) {
    mkdirSync(dirname(proofFile), { recursive: true });
    writeFileSync(proofFile, `# ${name}\n# Inbox: ${binary ? `compiled binary ${binary}` : "CLI from source"}\n\n`);
  }
  return {
    root,
    home,
    dataDir,
    project,
    bin,
    path: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    proof: (line) => {
      if (proofFile) appendFileSync(proofFile, `${line}\n`);
    },
  };
}

/** The environment every process of the world runs with (never a browser tab). */
export function worldEnv(w: InboxWorld): Record<string, string> {
  return {
    HOME: w.home,
    PATH: w.path,
    PLANNOTATOR_DATA_DIR: w.dataDir,
    PLANNOTATOR_BROWSER: "none",
    PLANNOTATOR_BIN: "",
    // Never the hosted relay (tests/setup/feedback-archive-off.ts says why).
    PLANNOTATOR_RELAY_URL: process.env.PLANNOTATOR_RELAY_URL || "http://127.0.0.1:9",
    TMPDIR: tmpdir(),
  };
}

/** The person runs the Inbox once: `plannotator inbox --background`. */
export function startInbox(w: InboxWorld): InboxRegistry {
  const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background"], { env: { ...process.env, ...worldEnv(w) }, cwd: w.root });
  if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`);
  return registry(w);
}

export interface InboxRegistry {
  pid: number;
  port: number;
  url: string;
  token: string;
}

export function registry(w: InboxWorld): InboxRegistry {
  return JSON.parse(readFileSync(join(w.dataDir, "inbox", "inbox.json"), "utf8"));
}

/** Stop the world's Inbox (SIGKILL) and remove the world. */
export function destroyInboxWorld(w: InboxWorld): void {
  stopInbox(w);
  rmSync(w.root, { recursive: true, force: true });
}

export function stopInbox(w: InboxWorld): void {
  const file = join(w.dataDir, "inbox", "inbox.json");
  if (!existsSync(file)) return;
  try {
    process.kill(JSON.parse(readFileSync(file, "utf8")).pid, "SIGKILL");
  } catch {
    // gone
  }
}

export interface ThreadMessage {
  id: string;
  body: string;
  author: { kind: string; session?: string | null; host?: string | null; name?: string | null };
  delivery?: { state: string; host: string; session: string; at: string } | null;
}

export async function thread(w: InboxWorld, threadId: string): Promise<{ subject: string; project: { root: string }; messages: ThreadMessage[] }> {
  const response = await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${threadId}`);
  return ((await response.json()) as { thread: never }).thread;
}

/** The threads the window lists, flattened. */
export async function listedThreads(w: InboxWorld): Promise<{ thread_id: string; sent: { checked_at: string | null } | null }[]> {
  const list = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads`)).json()) as {
    sections: { threads: { thread_id: string; sent: { checked_at: string | null } | null }[] }[];
  };
  return list.sections.flatMap((section) => section.threads);
}

/** The person's Send, through the route the window posts to. Returns the reply id. */
export async function personSends(w: InboxWorld, messageId: string, words: string): Promise<string> {
  const { port } = registry(w);
  const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string };
  const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `window-${messageId}-${words.length}`, words }),
  });
  if (response.status !== 200) throw new Error(`Send answered ${response.status}: ${await response.text()}`);
  const reply = ((await response.json()) as { reply: { id: string; body: string } }).reply;
  w.proof(`> the person presses Send in the Inbox window on ${messageId}\n${reply.body}\n`);
  return reply.id;
}

export async function waitFor<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

export const QUESTION = [
  "The refund webhook retries forever on a 409.",
  "",
  ":::question",
  "What should the worker do on a Stripe 409?",
  "",
  "- [ ] Retry with the same idempotency key",
  "- [ ] Fail the job and alert",
  ":::",
].join("\n");

export const SUBJECT = "What should the worker do on a Stripe 409?";

/** A promise and the function that settles it: a scripted model turn held open until the test releases it. */
export function gate(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
