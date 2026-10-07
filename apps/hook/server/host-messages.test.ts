/**
 * `annotate-last --stdin` with the Claude Code mod's recent-messages file
 * (PLANNOTATOR_HOST_MESSAGES_FILE), run as the real process: the file yields
 * the message picker with the newest message open; a malformed file is a
 * clean startup error; plain `--stdin` is unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  HOST_MESSAGES_FILE_ENV,
  isAllowedHostMessagesPath,
  MAX_HOST_MESSAGE_BYTES,
  MAX_HOST_MESSAGES,
  MAX_HOST_MESSAGES_FILE_BYTES,
  parseHostMessages,
} from "./host-messages";
// The mod's own writer: this file pins the contract between the two halves.
import { MAX_PICKER_FILE_BYTES, MAX_PICKER_MESSAGE_BYTES, pickerFile, RECENT_MESSAGES_LIMIT } from "../hooks/mod/launch";

const entry = resolve(import.meta.dir, "index.ts");
const distDir = resolve(import.meta.dir, "../dist");
const roots: string[] = [];
let stubs: string[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; API-only tests need just a stub.
  stubs = ["index.html", "review.html", "inbox.html"].map((name) => join(distDir, name)).filter((path) => !existsSync(path));
  mkdirSync(distDir, { recursive: true });
  for (const path of stubs) writeFileSync(path, "<!doctype html><title>test</title>");
});
afterAll(() => {
  for (const path of stubs) rmSync(path, { force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

/** Start `annotate-last --stdin` in the mod's launch layout; `messages` is the file's text, if any. */
function start(stdin: string, messages?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-host-messages-")));
  roots.push(root);
  const launch = join(root, "data", "claude-code-mod", "session-1", "launch-1");
  mkdirSync(launch, { recursive: true });
  const ready = join(launch, "ready");
  const messagesPath = join(launch, "messages.json");
  if (messages !== undefined) writeFileSync(messagesPath, messages);
  const proc = Bun.spawn([process.execPath, "run", entry, "annotate-last", "--stdin"], {
    cwd: root,
    env: {
      ...process.env,
      PLANNOTATOR_DATA_DIR: join(root, "data"),
      PLANNOTATOR_PORT: "0",
      PLANNOTATOR_REMOTE: "0",
      PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
      PLANNOTATOR_READY_FILE: ready,
      PLANNOTATOR_AI: "disabled",
      PLANNOTATOR_SHARE: "disabled",
      ...(messages !== undefined ? { [HOST_MESSAGES_FILE_ENV]: messagesPath } : {}),
    },
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const base = async () => {
    const line = await waitFor(() => (existsSync(ready) ? readFileSync(ready, "utf8").split("\n")[0] : null));
    return `http://localhost:${(JSON.parse(line) as { port: number }).port}`;
  };
  return { proc, base };
}

async function close(proc: ReturnType<typeof Bun.spawn>, base: string) {
  await fetch(`${base}/api/exit`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await proc.exited;
}

type PlanPayload = { plan: string; mode: string; recentMessages?: { messageId: string; text: string; timestamp?: string }[] };

describe("annotate-last --stdin with the host messages file", () => {
  test("the picker lists the host's messages newest first, with the newest open", async () => {
    const messages = [
      { messageId: "cc-new", text: "Newest answer." },
      { messageId: "cc-old", text: "Older answer.", timestamp: "2026-10-04T10:00:00Z" },
    ];
    const { proc, base } = start("Newest answer.", JSON.stringify({ v: 1, messages }));
    const url = await base();

    const shown = (await (await fetch(`${url}/api/plan`)).json()) as PlanPayload;
    expect(shown.mode).toBe("annotate-last");
    expect(shown.plan).toBe("Newest answer.");
    expect(shown.recentMessages).toEqual(messages);
    await close(proc, url);
  }, 30_000);

  test("plain --stdin is unchanged: one message, no picker", async () => {
    const { proc, base } = start("  Just this one.\n");
    const url = await base();

    const shown = (await (await fetch(`${url}/api/plan`)).json()) as PlanPayload;
    expect(shown.plan).toBe("Just this one.");
    expect(shown.recentMessages).toBeUndefined();
    await close(proc, url);
  }, 30_000);

  test("a malformed file is a startup error that names the problem, not a crash", async () => {
    const { proc } = start("Newest answer.", JSON.stringify({ v: 1, messages: [{ messageId: "a", text: 42 }] }));
    expect(await proc.exited).toBe(1);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("invalid host messages: message 0 has no text");
  }, 30_000);
});

describe("the mod's messages.json against the CLI's limits", () => {
  const sha256 = async (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  // Quote, backslash and ESC: 3 raw bytes that serialize to 10 (\" \\ \u001b).
  const escapeHeavy = (tag: number, units: number) => `${tag}:${'"\\\x1b'.repeat(units)}`;

  test("escape-heavy messages: the written file stays under the CLI cap and the CLI accepts it", async () => {
    // ~1 MiB raw each, ~3.3 MiB serialized: a raw-text budget would take
    // seven of these and write ~23 MiB, which the CLI refuses.
    const texts = Array.from({ length: MAX_HOST_MESSAGES }, (_, index) => escapeHeavy(index, 330_000));
    const file = await pickerFile(texts, sha256);

    expect(Buffer.byteLength(file.json, "utf8")).toBeLessThanOrEqual(MAX_HOST_MESSAGES_FILE_BYTES);
    expect(file.messages.length).toBeGreaterThan(1);
    expect(file.messages[0]?.text).toBe(texts[0]);
    const parsed = parseHostMessages(file.json);
    expect(parsed.ok && parsed.messages.map((message) => message.text)).toEqual(file.messages.map((message) => message.text));

    const { proc, base } = start(texts[0]!, file.json);
    const url = await base();
    const shown = (await (await fetch(`${url}/api/plan`)).json()) as PlanPayload;
    expect(shown.plan).toBe(texts[0]!);
    expect(shown.recentMessages?.length).toBe(file.messages.length);
    await close(proc, url);
  }, 60_000);

  test("the mod's copies of the CLI's limits agree (a hooks module cannot import them)", () => {
    expect(MAX_PICKER_FILE_BYTES).toBe(MAX_HOST_MESSAGES_FILE_BYTES);
    expect(MAX_PICKER_MESSAGE_BYTES).toBe(MAX_HOST_MESSAGE_BYTES);
    expect(RECENT_MESSAGES_LIMIT).toBe(MAX_HOST_MESSAGES);
  });

  test("a newest message too large to serialize within the cap means no file (stdin only)", async () => {
    // 1.5 MiB of ESC is under the per-message raw limit but ~9 MiB as JSON.
    const file = await pickerFile(["\x1b".repeat(1_500_000), "older"], sha256);
    expect(file.messages).toEqual([]);
  });
});

describe("parseHostMessages", () => {
  const ok = (messages: unknown) => parseHostMessages(JSON.stringify({ v: 1, messages }));

  test("refuses every shape the CLI should not guess at", () => {
    expect(parseHostMessages("Newest answer.").ok).toBe(false); // plain text, e.g. a mix-up with stdin
    expect(parseHostMessages(JSON.stringify({ v: 2, messages: [{ messageId: "a", text: "x" }] })).ok).toBe(false);
    expect(ok([]).ok).toBe(false);
    expect(ok("x").ok).toBe(false);
    expect(ok([{ messageId: "a", text: "   " }]).ok).toBe(false);
    expect(ok([{ messageId: 1, text: "x" }]).ok).toBe(false);
    expect(ok([{ messageId: "a", text: "x" }, { messageId: "a", text: "y" }]).ok).toBe(false);
    expect(ok([{ messageId: "a", text: "x", timestamp: 5 }]).ok).toBe(false);
    expect(ok([{ messageId: "x".repeat(129), text: "x" }]).ok).toBe(false);
    expect(ok(Array.from({ length: MAX_HOST_MESSAGES + 1 }, (_, i) => ({ messageId: `m${i}`, text: "x" }))).ok).toBe(false);
    expect(ok([{ messageId: "a", text: "x".repeat(MAX_HOST_MESSAGE_BYTES + 1) }]).ok).toBe(false);
  });

  test("errors never quote the payload", () => {
    const parsed = parseHostMessages("SECRET-TOKEN-VALUE");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).not.toContain("SECRET");
  });

  test("keeps only the known fields", () => {
    expect(ok([{ messageId: "a", text: "x", extra: true }])).toEqual({ ok: true, messages: [{ messageId: "a", text: "x" }] });
  });
});

describe("isAllowedHostMessagesPath", () => {
  test("only a messages.json under the data dir's claude-code-mod folder", () => {
    expect(isAllowedHostMessagesPath("/d/claude-code-mod/s/l/messages.json", "/d")).toBe(true);
    expect(isAllowedHostMessagesPath("/d/claude-code-mod/s/l/other.json", "/d")).toBe(false);
    expect(isAllowedHostMessagesPath("/elsewhere/messages.json", "/d")).toBe(false);
    expect(isAllowedHostMessagesPath("/d/claude-code-mod/../messages.json", "/d")).toBe(false);
    expect(isAllowedHostMessagesPath("claude-code-mod/messages.json", "/d")).toBe(false);
  });
});
