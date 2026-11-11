/**
 * The failure guarded: a `glab api graphql` that never finished held one of two slots for over an hour, because the runner sent one TERM and waited for the child's pipes to close; it never settled when the CLI caught TERM or a child kept the pipes.
 * Scripted CLIs are the only thing on PATH.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullDiffCliRunner } from "./inbox-pulls";
import { createBunRefCliRunner, createRefSlots, REF_KILL_GRACE_MS, REF_SLOT_BUSY } from "./ref-cards";

const posix = process.platform !== "win32";
const LIMIT_MS = 1_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const state = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
  return state !== "" && !state.startsWith("Z");
}

async function goneWithin(pids: number[], ms: number): Promise<number[]> {
  const until = Date.now() + ms;
  let left = pids.filter(alive);
  while (left.length > 0 && Date.now() < until) {
    await Bun.sleep(50);
    left = left.filter(alive);
  }
  return left;
}

describe.if(posix)("the Inbox's gh / glab runner: a hard deadline", () => {
  const savedPath = process.env.PATH;
  let root = "";
  afterEach(() => {
    process.env.PATH = savedPath;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function scripted(body: string): { pids: () => number[] } {
    root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-ref-runner-")));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const pids = join(root, "pids");
    writeFileSync(join(bin, "glab"), `#!/bin/sh\nPIDS='${pids}'\n${body}\n`);
    chmodSync(join(bin, "glab"), 0o755);
    // sh and sleep by absolute path in the script; PATH only finds the fake glab.
    process.env.PATH = bin;
    return { pids: () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split(/\s+/).filter(Boolean).map(Number) : []) };
  }

  const cases: [string, string, "timeout" | "answer"][] = [
    ["never exits", `echo $$ >> "$PIDS"\nexec /bin/sleep 600`, "timeout"],
    ["catches TERM (as current glab does) and goes on", `echo $$ >> "$PIDS"\ntrap '' TERM\nexec /bin/sleep 600`, "timeout"],
    ["is a wrapper whose real program is a grandchild", `echo $$ >> "$PIDS"\n/bin/sh -c 'echo $$ >> "$0"; exec /bin/sleep 600' "$PIDS"`, "timeout"],
    ["answers and exits, but leaves a helper holding its output", `/bin/sleep 600 &\necho $! >> "$PIDS"\necho '{"data":{}}'\nexit 0`, "answer"],
  ];

  for (const [name, body, ends] of cases) {
    test(`a CLI that ${name}: answered by the deadline, every process it started ended, the slot given back`, async () => {
      const fake = scripted(body);
      const run = createBunRefCliRunner(LIMIT_MS);
      const slots = createRefSlots(1);
      const started = Date.now();
      const first = slots.run(() => run("glab", ["api", "graphql"]));
      const second = slots.run(async () => Date.now());
      const result = await first;
      const took = Date.now() - started;
      if (ends === "timeout") {
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toBe("glab: timed out");
        expect(took).toBeLessThan(LIMIT_MS + 500);
      } else {
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe('{"data":{}}');
        expect(took).toBeLessThan(LIMIT_MS);
      }
      expect((await second) - started).toBeLessThan(LIMIT_MS + 600);
      expect(fake.pids().length).toBeGreaterThan(0);
      expect(await goneWithin(fake.pids(), REF_KILL_GRACE_MS + 2_000)).toEqual([]);
    });
  }

  test("the Pull requests diff read has the same hard deadline: a CLI that catches TERM is ended, and so is its child", async () => {
    const fake = scripted(`echo $$ >> "$PIDS"\ntrap '' TERM\n/bin/sh -c 'echo $$ >> "$0"; exec /bin/sleep 600' "$PIDS"`);
    const started = Date.now();
    const result = await pullDiffCliRunner("glab", ["api", "projects/1/merge_requests/2/diffs"], 1_000_000, { timeoutMs: 300 });
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(300 + REF_KILL_GRACE_MS + 1_000);
    expect(await goneWithin(fake.pids(), REF_KILL_GRACE_MS + 2_000)).toEqual([]);
  });

  test("a CLI that is not installed answers 127; one that answers in time is read whole", async () => {
    scripted(`printf 'out'; printf 'err' >&2; exit 3`);
    const run = createBunRefCliRunner(LIMIT_MS);
    expect(await run("glab", ["auth", "status"])).toEqual({ stdout: "out", stderr: "err", exitCode: 3 });
    process.env.PATH = join(root, "nothing-here");
    expect((await run("gh", ["api"])).exitCode).toBe(127);
  });
});

describe("the forge slots: never stuck", () => {
  test("a job that never settles gives its slot back after the hold", async () => {
    const slots = createRefSlots(1, { holdMs: 100, stallMs: 10_000 });
    void slots.run(() => new Promise(() => {}));
    const started = Date.now();
    expect(await slots.run(async () => "ran")).toBe("ran");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("with no slot given back for the stall window, the waiting jobs are refused, and a later one runs once a slot frees", async () => {
    const slots = createRefSlots(1, { holdMs: 300, stallMs: 100 });
    void slots.run(() => new Promise(() => {}));
    const waited = slots.run(async () => "ran").catch((e) => e);
    expect(await waited).toBe(REF_SLOT_BUSY);
    expect(slots.waiting()).toBe(0);
    await Bun.sleep(350);
    expect(await slots.run(async () => "later")).toBe("later");
  });

  test("one past the waiting cap is refused at once", async () => {
    const slots = createRefSlots(1, { maxWaiting: 1, holdMs: 10_000, stallMs: 10_000 });
    let release = () => {};
    void slots.run(() => new Promise<void>((resolve) => (release = resolve)));
    const queued = slots.run(async () => "queued");
    expect(await slots.run(async () => "x").catch((e) => e)).toBe(REF_SLOT_BUSY);
    release();
    expect(await queued).toBe("queued");
    expect(slots.running()).toBe(0);
  });
});
