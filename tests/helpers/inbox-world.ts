/**
 * A temp world for proving an agent connection against a REAL Plannotator
 * Inbox: its own HOME and PLANNOTATOR_DATA_DIR, a project folder, and a
 * `plannotator` on PATH that runs the compiled binary when
 * PLANNOTATOR_INBOX_TEST_BINARY names one (the CI jobs build it with the
 * release flags) and the CLI from source otherwise. The person's Send goes
 * through the route the window posts to. Never touches the real ~/.plannotator:
 * importing this sandboxes the test process's own PLANNOTATOR_DATA_DIR when no
 * bunfig preload did (tests/setup/sandbox-data-dir.ts), every helper refuses
 * the real data directory, and an Inbox is only ever signalled once it is
 * proven to be the one the world started (tests/helpers/inbox-process.ts).
 */
import "../setup/sandbox-data-dir";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stubHookDistHtml } from "./hook-dist-stub";
import { type InboxEntry, inboxEntryOf, mustSignalInbox, stopProvenInboxes } from "./inbox-process";
import { NO_BROWSER } from "./no-browser";
import { assertSandboxedDataDir, refuseRealDataDir } from "./real-data-dir";

export { removeStubbedHtml } from "./hook-dist-stub";

const repoRoot = resolve(import.meta.dir, "..", "..");
const cliEntry = join(repoRoot, "apps", "hook", "server", "index.ts");

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
  /** The Inbox serves phones (PLANNOTATOR_INBOX_PHONES=1); off otherwise, as released. */
  phones: boolean;
}

export function inboxBinary(): string | undefined {
  return process.env.PLANNOTATOR_INBOX_TEST_BINARY || undefined;
}

/**
 * The CLI from source imports the built HTML; the Inbox never serves it.
 * Nothing to stub when the world runs the compiled binary. Returns what to
 * remove after, with `removeStubbedHtml`.
 */
export function stubBuiltHtml(): string[] {
  if (inboxBinary()) return [];
  return stubHookDistHtml();
}

/** Every Inbox entry each world's registry has named, so a teardown can stop an earlier start too. */
const seen = new WeakMap<InboxWorld, Map<string, InboxEntry>>();

function remember(w: InboxWorld): void {
  const entry = inboxEntryOf(w.dataDir);
  if (!entry) return;
  if (!seen.has(w)) seen.set(w, new Map());
  seen.get(w)!.set(`${entry.pid}:${entry.port}:${entry.serverSession}`, entry);
}

export function createInboxWorld(prefix: string, name: string, proofSubdir: string, options: { phones?: boolean } = {}): InboxWorld {
  assertSandboxedDataDir("createInboxWorld");
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
    phones: options.phones === true,
  };
}

/** The environment every process of the world runs with (never a browser tab). */
export function worldEnv(w: InboxWorld): Record<string, string> {
  refuseRealDataDir(w.dataDir, "worldEnv");
  return {
    HOME: w.home,
    PATH: w.path,
    PLANNOTATOR_DATA_DIR: w.dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_BIN: "",
    // Never the hosted relay (tests/setup/feedback-archive-off.ts says why).
    PLANNOTATOR_RELAY_URL: process.env.PLANNOTATOR_RELAY_URL || "http://127.0.0.1:9",
    // Never GitHub: a release build's daily update check refuses at once.
    PLANNOTATOR_UPDATE_API_URL: process.env.PLANNOTATOR_UPDATE_API_URL || "http://127.0.0.1:9/releases/latest",
    // Never the real install script: Update now in a world fails fast unless a test serves one.
    PLANNOTATOR_INSTALL_SCRIPT_URL: process.env.PLANNOTATOR_INSTALL_SCRIPT_URL || "http://127.0.0.1:9/install.sh",
    PLANNOTATOR_RELEASE_DOWNLOAD_URL: process.env.PLANNOTATOR_RELEASE_DOWNLOAD_URL || "http://127.0.0.1:9/download",
    // Never the live feedback Worker (append-only): a Send in a world fails fast unless a test serves a fake.
    PLANNOTATOR_FEEDBACK_URL: process.env.PLANNOTATOR_FEEDBACK_URL || "http://127.0.0.1:9/feedback",
    // Phones are hidden until the iPhone app ships; only the phone proofs turn them on.
    PLANNOTATOR_INBOX_PHONES: w.phones ? "1" : "0",
    // Never run a real agent's CLI: a world's PATH holds the person's own (packages/server/inbox-agents.ts).
    PLANNOTATOR_INBOX_CONNECT: "0",
    TMPDIR: tmpdir(),
  };
}

/** The person runs the Inbox once: `plannotator inbox --background`. */
export function startInbox(w: InboxWorld): InboxRegistry {
  assertSandboxedDataDir("startInbox");
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
  refuseRealDataDir(w.dataDir, "registry");
  const value = JSON.parse(readFileSync(join(w.dataDir, "inbox", "inbox.json"), "utf8")) as InboxRegistry;
  remember(w);
  return value;
}

/**
 * Stop every Inbox the world provably started (SIGKILL; see
 * tests/helpers/inbox-process.ts) and remove the world.
 */
export async function destroyInboxWorld(w: InboxWorld): Promise<void> {
  assertSandboxedDataDir("destroyInboxWorld");
  remember(w);
  const targets = [...(seen.get(w)?.values() ?? [])].map((entry) => ({ entry, root: w.root }));
  await stopProvenInboxes(targets, { signal: "SIGKILL" });
  rmSync(w.root, { recursive: true, force: true });
}

/**
 * Kill the world's Inbox (SIGKILL) once it is proven to be the one the world
 * started, and wait for it to exit. Nothing to do when none runs.
 */
export async function stopInbox(w: InboxWorld): Promise<void> {
  assertSandboxedDataDir("stopInbox");
  remember(w);
  const entry = inboxEntryOf(w.dataDir);
  if (entry) await stopProvenInboxes([{ entry, root: w.root }], { signal: "SIGKILL" });
}

/**
 * Send `signal` to the world's Inbox, only once it is proven to be the one the
 * world started; throws otherwise (a test that means to signal its own Inbox
 * must never signal anything else). Does not wait. Returns the pid signalled.
 */
export async function signalInbox(w: InboxWorld, signal: NodeJS.Signals): Promise<number> {
  assertSandboxedDataDir("signalInbox");
  remember(w);
  return (await mustSignalInbox(inboxEntryOf(w.dataDir), w.root, signal)).pid;
}

export interface ThreadMessage {
  id: string;
  body: string;
  author: { kind: string; session?: string | null; host?: string | null; name?: string | null };
  delivery?: { state: string; host: string; session: string; at: string } | null;
}

export async function thread(w: InboxWorld, threadId: string): Promise<{ subject: string; thread_name?: string | null; project: { root: string }; messages: ThreadMessage[] }> {
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

/** The person presses Send now on their reply, through the route the window posts to. */
export async function pressSendNow(w: InboxWorld, replyId: string): Promise<void> {
  const { port } = registry(w);
  const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string };
  const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages/${replyId}/send-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ serverSession: health.serverSession }),
  });
  if (response.status !== 200) throw new Error(`Send now answered ${response.status}: ${await response.text()}`);
  w.proof(`> the person presses Send now on ${replyId}\n`);
}

/** Waits until the session's connection polled busy and able to take a reply mid-turn (Send now offered). */
export async function sendNowOffered(w: InboxWorld, threadId: string, session: string): Promise<void> {
  await waitFor("Send now offered", async () => {
    const model = (await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${threadId}/sessions?asker=${session}`)).json()) as {
      asker: { connection: { busy: boolean | null; send_now: boolean } | null };
    };
    return model.asker.connection?.busy === true && model.asker.connection.send_now === true;
  });
}

/** The person starts a thread from compose (POST /api/inbox/messages) with a live session; returns the root message id. */
export async function personComposes(w: InboxWorld, to: { host: string; session: string }, body: string, extra: { thread_name?: string } = {}): Promise<string> {
  const { port } = registry(w);
  const health = (await (await fetch(`http://127.0.0.1:${port}/api/inbox/health`)).json()) as { serverSession: string };
  const response = await fetch(`http://127.0.0.1:${port}/api/inbox/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ serverSession: health.serverSession, to, body, idempotency_key: `compose-${to.session}-${body.length}`, ...extra }),
  });
  if (response.status !== 200) throw new Error(`compose answered ${response.status}: ${await response.text()}`);
  const message = ((await response.json()) as { message: { id: string } }).message;
  w.proof(`> the person starts a thread from compose, to ${to.host} ${to.session}: ${message.id}\n${body}\n`);
  return message.id;
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
