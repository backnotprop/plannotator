/**
 * Is an `agent` on PATH Cursor's CLI? Fake programs in a scratch folder only:
 * the real Cursor, Grok or any other CLI is never run.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURSOR_CLI_SIGNATURE,
  forgetSameProgramAnswers,
  isSameProgram,
  readVersionLine,
  resolveProgram,
} from "./agent-program";

const posix = process.platform !== "win32";
const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-agent-program-")));
const bin = join(root, "bin");
mkdirSync(bin);
const log = join(root, "ran.log");

/** A fake program that logs each start, then runs `body`. */
function program(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> '${log}'\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function ran(): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const GROK = 'echo "grok 1.0.70 (f50904eaee6c) [stable]"';
const CURSOR = 'echo "2026.07.08-0c04a8a"';

beforeEach(() => {
  forgetSameProgramAnswers();
  rmSync(log, { force: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.if(posix)("isSameProgram: Cursor's `agent`", () => {
  test("refuses Grok Build's `agent` by its version line, asked once", async () => {
    const grok = program(join(bin, "grok-agent"), GROK);
    expect(await isSameProgram(grok, CURSOR_CLI_SIGNATURE)).toBe(false);
    expect(await isSameProgram(grok, CURSOR_CLI_SIGNATURE)).toBe(false);
    expect(ran()).toEqual([`${grok} --version`]);
  });

  test("callers asking at once share one probe", async () => {
    const grok = program(join(bin, "grok-agent-shared"), GROK);
    const answers = await Promise.all([1, 2, 3].map(() => isSameProgram(grok, CURSOR_CLI_SIGNATURE)));
    expect(answers).toEqual([false, false, false]);
    expect(ran()).toHaveLength(1);
  });

  test("takes an `agent` that prints Cursor's dated build", async () => {
    const cursor = program(join(bin, "cursor-like-agent"), CURSOR);
    expect(await isSameProgram(cursor, CURSOR_CLI_SIGNATURE)).toBe(true);
  });

  test("takes an `agent` linked into Cursor's install layout without running it", async () => {
    const real = program(join(root, "share", "cursor-agent", "versions", "2026.07.08-0c04a8a", "cursor-agent"), "exit 1");
    const link = join(bin, "agent-linked");
    symlinkSync(real, link);
    expect(await isSameProgram(link, CURSOR_CLI_SIGNATURE)).toBe(true);
    expect(ran()).toEqual([]);
  });

  test("a folder named cursor-agent outside the install layout is not enough", async () => {
    const stray = program(join(root, "code", "cursor-agent", "bin", "agent"), GROK);
    expect(await isSameProgram(stray, CURSOR_CLI_SIGNATURE)).toBe(false);
    const named = program(join(root, "elsewhere", "cursor-agent"), GROK);
    expect(await isSameProgram(named, CURSOR_CLI_SIGNATURE)).toBe(false);
    expect(ran()).toHaveLength(2);
  });

  test("refuses a version line that is only close, a failing exit and no output", async () => {
    for (const [name, body] of [
      ["agent-semver", 'echo "1.2.3"'],
      ["agent-prefixed-line", 'echo "agent 2026.07.08-0c04a8a"'],
      ["agent-fails", `${CURSOR}; exit 2`],
      ["agent-silent", "true"],
    ] as const) {
      expect(await isSameProgram(program(join(bin, name), body), CURSOR_CLI_SIGNATURE)).toBe(false);
    }
  });

  test("gives up on a program that never answers", async () => {
    const hang = program(join(bin, "agent-hang"), "exec sleep 30");
    const started = Date.now();
    expect(await readVersionLine(hang, 300)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("kills a wrapper's child with it when it runs out of time", async () => {
    const pidFile = join(root, "grandchild.pid");
    const wrapper = program(join(bin, "agent-wrapper"), `sleep 30 &\necho $! > '${pidFile}'\nwait`);
    expect(await readVersionLine(wrapper, 500)).toBeNull();
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    const until = Date.now() + 2_000;
    while (alive(pid) && Date.now() < until) await Bun.sleep(20);
    expect(alive(pid)).toBe(false);
  });

  test("answers as soon as a program exits, even if its child keeps the output open", async () => {
    const pidFile = join(root, "holder.pid");
    const holder = program(join(bin, "agent-holder"), `${CURSOR}\nsleep 30 &\necho $! > '${pidFile}'`);
    const started = Date.now();
    expect(await readVersionLine(holder)).toBe("2026.07.08-0c04a8a");
    expect(Date.now() - started).toBeLessThan(1_500);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const until = Date.now() + 2_000;
    while (alive(pid) && Date.now() < until) await Bun.sleep(20);
    expect(alive(pid)).toBe(false);
  });
});

describe("resolveProgram", () => {
  const names = { command: "cursor-agent", alt: ["agent"], signature: CURSOR_CLI_SIGNATURE };
  const at = (paths: Record<string, string>) => (name: string) => paths[name] ?? null;

  test("uses the program's own name without any check", async () => {
    let asked = 0;
    const check = async () => (asked++, false);
    expect(await resolveProgram(names, at({ "cursor-agent": "/x/cursor-agent", agent: "/y/agent" }), check)).toEqual({ name: "cursor-agent", path: "/x/cursor-agent" });
    expect(asked).toBe(0);
  });

  test("uses the other name only when it is the same program", async () => {
    expect(await resolveProgram(names, at({ agent: "/y/agent" }), async () => true)).toEqual({ name: "agent", path: "/y/agent" });
    expect(await resolveProgram(names, at({ agent: "/y/agent" }), async () => false)).toBeNull();
    expect(await resolveProgram(names, at({}), async () => true)).toBeNull();
  });

  test.if(posix)("with fake programs on a lookup: Grok's `agent` leaves Cursor not installed", async () => {
    const grok = program(join(bin, "agent-grok-lookup"), GROK);
    const cursor = program(join(bin, "agent-cursor-lookup"), CURSOR);
    expect(await resolveProgram(names, at({ agent: grok }))).toBeNull();
    expect(await resolveProgram(names, at({ agent: cursor }))).toEqual({ name: "agent", path: cursor });
  });
});
