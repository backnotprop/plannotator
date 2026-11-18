/**
 * A `:::run` command as the Inbox runs it: real `/bin/sh` processes in a temp folder (no agent, no keychain).
 * What regresses: the result not reaching the agent (exit code, tail), a secret missing from the env or shown in
 * output (also split across chunks, or half written), Stop or a deleted thread leaving the command's children
 * running, a Stop during the env read not stopping it, an Inbox stop leaving orphans or no word to the agent, a lost
 * run not reported after a restart, a run that waits for typing hanging silently, and output with no line end
 * growing without bound. Every test ends its runs; none leaves a process or a timer. The quiet window and the sweep
 * are shortened (no real 2 s waits).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRunLine, createInboxRuns, INBOX_RUN_LINE_MAX, RunLineBuffer, type InboxRunEnded, type InboxRunPrepared, type InboxRuns } from "./inbox-run";
import { memoryRunJournal, type InboxRunJournal } from "./inbox-run-journal";

const SENTINEL = "TEST_ONLY_NOT_A_KEY_123";
const posix = process.platform !== "win32";

const made: { runs: InboxRuns; dir: string }[] = [];
afterEach(() => {
  for (const { runs, dir } of made.splice(0)) {
    runs.stopAll();
    rmSync(dir, { recursive: true, force: true });
  }
});

function world(alive: () => boolean = () => true, journal?: InboxRunJournal) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-run-"));
  const runs = createInboxRuns({ messageAlive: () => alive(), quietMs: 150, sweepMs: 30, journal });
  made.push({ runs, dir });
  const ended: InboxRunEnded[] = [];
  const start = (command: string, env: Record<string, string> = {}, secrets: string[] = [], key = "r-0000000a", prepare?: () => Promise<InboxRunPrepared>) =>
    runs.start({
      message_id: "msg_1",
      key,
      title: "Run it",
      folder: "~/p",
      cwd: dir,
      prepare: prepare ?? (async () => ({ argv: ["/bin/sh", "-c", command], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, redact: secrets })),
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

  test("the Inbox stopping ends every run at once, and the agent hears the Inbox closed", async () => {
    const w = world();
    w.start("echo $$; sleep 30", {}, [], "r-0000000b");
    w.start("echo $$; sleep 30", {}, [], "r-0000000c");
    await until(() => !!w.runs.views("msg_1")["r-0000000b"]?.lines.length && !!w.runs.views("msg_1")["r-0000000c"]?.lines.length);
    const pids = ["r-0000000b", "r-0000000c"].map((key) => Number(w.runs.views("msg_1")[key]!.lines[0]));
    w.runs.stopAll();
    await until(() => pids.every(gone), 4_000);
    expect(w.ended.map((e) => e.outcome)).toEqual(["inbox_closed", "inbox_closed"]);
    expect(w.view("r-0000000b")).toMatchObject({ state: "stopped", interrupted: "closed" });
  });

  test("a Stop while it still reads its env and secrets: it never starts, and the agent hears it stopped", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let prepared = false;
    w.start("", {}, [], "r-0000000a", async () => {
      await gate;
      prepared = true;
      return { argv: ["/bin/sh", "-c", "echo started"], env: { PATH: process.env.PATH ?? "" }, redact: [] };
    });
    expect(w.runs.stop("msg_1", "r-0000000a")).toBe(true);
    release();
    await until(() => w.ended.length === 1);
    expect(prepared).toBe(true);
    expect(w.ended[0]!.outcome).toBe("stopped");
    expect(w.ended[0]!.view.lines).toEqual([]);
  });

  test("a run that cannot read what it needs does not start, and says why", async () => {
    const w = world();
    w.start("", {}, [], "r-0000000a", async () => {
      throw new Error("Couldn't read API_TOKEN from your Keychain. Unlock it if it asks, then run again");
    });
    await until(() => w.ended.length === 1);
    expect(w.ended[0]).toMatchObject({ outcome: "failed_to_start", view: { state: "failed", error: "Couldn't read API_TOKEN from your Keychain. Unlock it if it asks, then run again" } });
  });

  test("a run the Inbox lost (it died mid-run) is reported once at the next start, and its card is not idle", async () => {
    const journal = memoryRunJournal();
    const first = world(() => true, journal);
    first.start("echo $$; sleep 30");
    await until(() => first.view().lines.length === 1);
    const pid = Number(first.view().lines[0]);
    // A kill -9 of the Inbox: nothing ends the run's record. (The test still ends the process it left.)
    process.kill(-pid, "SIGKILL");
    const again = createInboxRuns({ messageAlive: () => true, journal });
    const lost: string[] = [];
    again.recover((record) => lost.push(`${record.message_id}/${record.key}/${record.title}`));
    again.recover((record) => lost.push(record.key));
    expect(lost).toEqual(["msg_1/r-0000000a/Run it"]);
    expect(again.views("msg_1")["r-0000000a"]).toMatchObject({ state: "stopped", interrupted: "lost" });
    again.stopAll();
  });

  test("a prompt that waits for typing says so; a second Run while one runs is refused", async () => {
    const w = world();
    w.start("printf 'Password: '; read answer; echo got");
    expect(() => w.start("echo again")).toThrow("already running");
    await until(() => w.view().waiting_for_input, 3_000);
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

describe.if(posix)("output", () => {
  test("a secret split across two writes, and one half written, is never shown", async () => {
    const w = world();
    const half = SENTINEL.slice(0, 10);
    const rest = SENTINEL.slice(10);
    w.start(`printf 'k=${half}'; sleep 0.3; printf '${rest}\\n'; printf 'p=${half}'; sleep 5`, {}, [SENTINEL]);
    await until(() => w.view().lines.length === 1 && w.view().partial.startsWith("p="));
    expect(w.view().lines).toEqual(["k=••••"]);
    expect(w.view().partial).toBe("p=••••");
    expect(JSON.stringify(w.view())).not.toContain(half);
    w.runs.stop("msg_1", "r-0000000a");
    await until(() => w.ended.length === 1);
  });

  test("megabytes with no line end, and a long \\r progress bar, stay bounded and quick", async () => {
    const w = world();
    const began = Date.now();
    w.start("head -c 5000000 /dev/zero | tr '\\0' 'a'; echo; i=0; while [ $i -lt 20000 ]; do printf '\\r%d%%' $i; i=$((i+1)); done; echo", {}, [], "r-0000000a");
    await until(() => w.ended.length === 1, 20_000);
    expect(Date.now() - began).toBeLessThan(15_000);
    const lines = w.ended[0]!.view.lines;
    expect(lines).toHaveLength(2);
    expect(lines[0]!.length).toBe(INBOX_RUN_LINE_MAX + 1);
    expect(lines[0]!.endsWith("…")).toBe(true);
    expect(lines[1]).toBe("19999%");
  });
});

describe("a line as the card shows it", () => {
  test("colour codes stripped, a progress line at its last state, secrets hidden", () => {
    expect(cleanRunLine("\u001b[32mok\u001b[0m", [])).toBe("ok");
    expect(cleanRunLine("10%\r50%\r100%\r", [])).toBe("100%");
    expect(cleanRunLine(`key=${SENTINEL}`, [SENTINEL])).toBe("key=••••");
  });

  test("the line buffer looks at each piece once: 5 MB in 64 KB pieces holds a bounded head, in little time", () => {
    const buffer = new RunLineBuffer();
    const piece = "x".repeat(65_536);
    const began = performance.now();
    for (let i = 0; i < 80; i++) expect(buffer.push(piece)).toEqual([]);
    expect(buffer.partial.length).toBeLessThanOrEqual(INBOX_RUN_LINE_MAX * 2);
    expect(buffer.push("tail\nnext")).toEqual(["x".repeat(INBOX_RUN_LINE_MAX + 1)]);
    expect(buffer.partial).toBe("next");
    expect(performance.now() - began).toBeLessThan(1_000);
  });

  test("a progress line keeps only its last states, however many arrive", () => {
    const buffer = new RunLineBuffer();
    for (let i = 0; i < 100_000; i++) buffer.push(`\r${i}%`);
    expect(buffer.partial.length).toBeLessThan(20);
    expect(cleanRunLine(buffer.partial, [])).toBe("99999%");
    expect(buffer.push("\r\u001b[K\n")).toEqual(["99999%\r\u001b[K"]);
  });
});
