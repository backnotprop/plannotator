/**
 * A `:::run` command as the Inbox runs it: real `/bin/sh` processes in a temp folder (no agent, no keychain).
 * What regresses: the result not reaching the agent (exit code, tail), a saved secret missing from the env or shown
 * in output, Stop or a deleted thread leaving the command's children running, an Inbox stop leaving orphans, and a
 * run that waits for typing hanging silently. Every test ends its runs; none leaves a process or a timer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRunLine, createInboxRuns, type InboxRunEnded, type InboxRuns } from "./inbox-run";

const SENTINEL = "TEST_ONLY_NOT_A_KEY_123";
const posix = process.platform !== "win32";

const made: { runs: InboxRuns; dir: string }[] = [];
afterEach(() => {
  for (const { runs, dir } of made.splice(0)) {
    runs.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

function world(alive: () => boolean = () => true) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-run-"));
  const runs = createInboxRuns({ messageAlive: () => alive() });
  made.push({ runs, dir });
  const ended: InboxRunEnded[] = [];
  const start = (command: string, env: Record<string, string> = {}, secrets: string[] = [], key = "r-0000000a") =>
    runs.start({
      message_id: "msg_1",
      key,
      cwd: dir,
      argv: () => ["/bin/sh", "-c", command],
      env: async () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }),
      secrets,
      onEnd: (end) => ended.push(end),
    });
  return { runs, dir, ended, start, view: (key = "r-0000000a") => runs.views("msg_1")[key]! };
}

async function until(check: () => boolean, ms = 8_000) {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe.if(posix)("a run", () => {
  test("its output, exit code and duration reach the agent once, from the folder it was given", async () => {
    const w = world();
    w.start("pwd; echo out; echo err >&2; printf 'no newline'; exit 3");
    await until(() => w.ended.length === 1);
    await Bun.sleep(100);
    expect(w.ended).toHaveLength(1);
    const end = w.ended[0]!;
    expect(end.outcome).toBe("exited");
    expect(end.view).toMatchObject({ state: "failed", exit_code: 3 });
    expect(end.view.lines.slice(1).sort()).toEqual(["err", "no newline", "out"]);
    expect(end.view.lines[0]!.endsWith(w.dir.split("/").pop()!)).toBe(true);
  });

  test("a saved secret is in the env as $NAME, and never in the output or what the agent gets", async () => {
    const w = world();
    w.start('[ "$API_TOKEN" = "TEST_ONLY_NOT_A_KEY_123" ] && echo injected; echo "token=$API_TOKEN"', { API_TOKEN: SENTINEL }, [SENTINEL]);
    await until(() => w.ended.length === 1);
    expect(w.ended[0]!.view.lines).toEqual(["injected", "token=••••"]);
    expect(JSON.stringify(w.ended[0])).not.toContain(SENTINEL);
    expect(JSON.stringify(w.runs.views("msg_1"))).not.toContain(SENTINEL);
  });

  test("Stop ends the whole process tree, not only the shell", async () => {
    const w = world();
    w.start("sleep 30 & echo $!; sh -c 'sleep 30' & echo $!; echo $$; wait");
    await until(() => w.view().lines.length >= 3);
    const pids = w.view().lines.slice(0, 3).map(Number);
    expect(pids.every((pid) => !gone(pid))).toBe(true);
    expect(w.runs.stop("msg_1", "r-0000000a")).toBe(true);
    await until(() => w.ended.length === 1);
    expect(w.ended[0]!.outcome).toBe("stopped");
    await until(() => pids.every(gone), 4_000);
  });

  test("what a finished command left running in its group is stopped with it", async () => {
    const w = world();
    w.start("sleep 30 & echo $!; exit 0");
    await until(() => w.ended.length === 1);
    const pid = Number(w.ended[0]!.view.lines[0]);
    expect(w.ended[0]!.view.state).toBe("done");
    await until(() => gone(pid), 4_000);
  });

  test("a deleted thread's run is stopped and nothing is sent", async () => {
    let alive = true;
    const w = world(() => alive);
    w.start("echo $$; sleep 30");
    await until(() => w.view().lines.length === 1);
    const pid = Number(w.view().lines[0]);
    alive = false;
    await until(() => gone(pid), 4_000);
    await Bun.sleep(100);
    expect(w.ended).toEqual([]);
    expect(w.runs.running()).toBe(0);
  });

  test("the Inbox stopping ends every run at once", async () => {
    const w = world();
    w.start("echo $$; sleep 30", {}, [], "r-0000000b");
    w.start("echo $$; sleep 30", {}, [], "r-0000000c");
    await until(() => !!w.runs.views("msg_1")["r-0000000b"]?.lines.length && !!w.runs.views("msg_1")["r-0000000c"]?.lines.length);
    const pids = ["r-0000000b", "r-0000000c"].map((key) => Number(w.runs.views("msg_1")[key]!.lines[0]));
    w.runs.stopAll();
    await until(() => pids.every(gone), 4_000);
  });

  test("a prompt that waits for typing says so; a second Run while one runs is refused", async () => {
    const w = world();
    w.start("printf 'Password: '; read answer; echo got");
    expect(() => w.start("echo again")).toThrow("already running");
    await until(() => w.view().waiting_for_input, 6_000);
    expect(w.view().partial).toBe("Password: ");
    w.runs.stop("msg_1", "r-0000000a");
    await until(() => w.ended.length === 1);
    // The agent hears that it stopped on a prompt; the card no longer says it waits.
    expect(w.ended[0]!.waited_for_input).toBe(true);
    expect(w.view().waiting_for_input).toBe(false);
  });

  test("a command that fails asking for a terminal says it needs one", async () => {
    const w = world();
    w.start("echo 'sudo: a terminal is required to read the password' >&2; exit 1");
    await until(() => w.ended.length === 1);
    expect(w.ended[0]!.view.needs_terminal).toBe(true);
  });
});

describe("a line as the card shows it", () => {
  test("colour codes stripped, a progress line at its last state, secrets hidden", () => {
    expect(cleanRunLine("\u001b[32mok\u001b[0m", [])).toBe("ok");
    expect(cleanRunLine("10%\r50%\r100%\r", [])).toBe("100%");
    expect(cleanRunLine(`key=${SENTINEL}`, [SENTINEL])).toBe("key=••••");
  });
});
