/**
 * The one `codex app-server` process Ask AI and voice dictation share: its stdout reader and its stop. A scratch
 * `codex` script stands in each time and CODEX_HOME points at scratch, so no test runs the real one or reads its config.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_LINE_MAX, CodexAppServerProcess } from "./codex-app-server";

const roots: string[] = [];
const started: CodexAppServerProcess[] = [];

afterEach(() => {
  for (const codex of started.splice(0)) codex.kill(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rig(body: string, lineMax?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-codex-process-")));
  roots.push(root);
  const path = join(root, "codex");
  writeFileSync(path, `#!/bin/sh\n${body.replaceAll("<root>", root)}\n`);
  chmodSync(path, 0o755);
  const codex = new CodexAppServerProcess(lineMax);
  started.push(codex);
  const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: root };
  return { codex, root, start: (ms: number) => codex.start(path, root, ms, env) };
}

/** A `codex` in Bun: `write` runs on each call, with `answer(result)` to hand. */
const answering = (write: string) =>
  `exec ${JSON.stringify(process.execPath)} -e 'require("readline").createInterface({input:process.stdin}).on("line",(l)=>{const m=JSON.parse(l);if(m.id===undefined)return;const answer=(result)=>process.stdout.write(JSON.stringify({id:m.id,result})+"\\n");${write}})'`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(20);
  }
  return check();
}

describe("stdout", () => {
  test("a `codex` that never ends a line is failed at the limit, and promptly", async () => {
    const { codex, start } = rig(`exec tr -d '\\n' < /dev/zero`, 1024 * 1024);
    const began = Date.now();
    const failure = await start(30_000).catch((error: Error) => error);
    expect((failure as Error).message).toContain("past the limit");
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(codex.alive).toBe(false);
  }, 10_000);

  test("at Ask AI's limit too: a long unfinished line neither freezes the loop nor outlives the cap", async () => {
    const { start } = rig(`exec tr -d '\\n' < /dev/zero`);
    const began = Date.now();
    const failure = await start(30_000).catch((error: Error) => error);
    expect((failure as Error).message).toContain("past the limit");
    expect(Date.now() - began).toBeLessThan(15_000);
  }, 20_000);

  test("the default takes a line far past voice's limit: one resumed thread can answer in one long line", async () => {
    const size = 5 * 1024 * 1024;
    expect(CODEX_LINE_MAX).toBeGreaterThan(size);
    const { codex, start } = rig(answering(`answer({userAgent:"x".repeat(${size})})`));
    await start(15_000);
    expect(codex.userAgent).toHaveLength(size);
    expect(codex.alive).toBe(true);
  }, 20_000);

  test("a line cut across chunks, two in one chunk, CRLF, and a character split at a chunk's edge arrive whole", async () => {
    const bytes = Buffer.from(`${JSON.stringify({ id: 1, result: { userAgent: "éééé" } })}\r\n{"method":"note/one","params":{}}\n`);
    const cuts = [bytes.indexOf(0xc3) + 1, bytes.length - 5];
    const parts = [bytes.subarray(0, cuts[0]), bytes.subarray(cuts[0], cuts[1]), bytes.subarray(cuts[1])].map((part) => part.toString("base64"));
    const { codex, start } = rig(
      `exec ${JSON.stringify(process.execPath)} -e 'const parts=${JSON.stringify(parts)};let at=0;const next=()=>{if(at<parts.length){process.stdout.write(Buffer.from(parts[at++],"base64"));setTimeout(next,40)}};process.stdin.once("data",next);setTimeout(()=>{},5000)'`,
    );
    const notes: string[] = [];
    codex.onEvent((note) => notes.push(note.method));
    await start(5_000);
    expect(codex.userAgent).toBe("éééé");
    expect(await until(() => notes.includes("note/one"), 2_000)).toBe(true);
  }, 10_000);

  test("a bad line is skipped and the next one is read", async () => {
    const { codex, start } = rig(answering(`process.stdout.write("%%% not json\\n");answer({userAgent:"good"})`));
    await start(5_000);
    expect(codex.userAgent).toBe("good");
  }, 10_000);
});

describe("stopping", () => {
  /** Answers `initialize`, then ignores SIGTERM for longer than any test here. Its children inherit the ignore. */
  const STUBBORN = `trap '' TERM
read -r line
id=$(printf '%s' "$line" | sed 's/.*"id":\\([0-9]*\\).*/\\1/')
printf '{"id":%s,"result":{}}\\n' "$id"
echo $$ > <root>/pid
while true; do sleep 0.05; done`;

  async function running() {
    const world = rig(STUBBORN);
    await world.start(5_000);
    const file = join(world.root, "pid");
    expect(await until(() => existsSync(file) && readFileSync(file, "utf8").endsWith("\n"), 2_000)).toBe(true);
    return { ...world, pid: Number(readFileSync(file, "utf8").trim()) };
  }

  test("a Codex that ignores SIGTERM is still there at first, then gets SIGKILL", async () => {
    const { codex, pid } = await running();
    expect(alive(pid)).toBe(true);
    codex.kill();
    await Bun.sleep(300);
    expect(alive(pid)).toBe(true);
    expect(await until(() => !alive(pid), 3_000)).toBe(true);
  }, 12_000);

  test("kill(true) does not wait: the Inbox is exiting and no timer would run", async () => {
    const { codex, pid } = await running();
    codex.kill(true);
    expect(await until(() => !alive(pid), 500)).toBe(true);
  }, 10_000);
});
