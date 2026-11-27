/**
 * A `:::run` command as the Inbox runs it: real `/bin/sh` processes in a temp folder (no agent, no keychain).
 * What regresses: the result not reaching the agent (exit code, tail), a secret missing from the env or shown in
 * output (also split across chunks, or half written), Stop or a deleted thread leaving the command's children
 * running, a Stop during the env read not stopping it, an Inbox stop leaving orphans or no word to the agent, a lost
 * run not reported after a restart, a run that waits for typing hanging silently, and output with no line end
 * growing without bound, part of a secret shown where a long line is cut, a lost run's command left running with no
 * way to stop it, and finished runs piling up in memory. Every test ends its runs; none leaves a process or a timer.
 * These run in real time against real processes (no injected clock): the quiet window and the sweep are shortened,
 * so no test waits the real 2 s.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanRunLine, createInboxRuns, INBOX_RUN_LINE_MAX, INBOX_RUN_TOO_LONG_WORDS, RunLineBuffer, type InboxRunEnded, type InboxRunPrepared, type InboxRuns } from "./inbox-run";
import { lostRunStillRunning } from "./inbox-run-setup";
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
    // stdout and stderr are two pipes: "err" can be read before the folder's line, so no order between them is held.
    const folder = end.view.lines.filter((line) => line.endsWith(w.dir.split("/").pop()!));
    expect(folder).toHaveLength(1);
    expect(end.view.lines.filter((line) => line !== folder[0]).sort()).toEqual(["err", "no newline", "out"]);
    // Within stdout the order holds: the folder first.
    expect(end.view.lines.filter((line) => line !== "err")[0]).toBe(folder[0]);
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
    // The journal as the dead Inbox left it (this test's first Inbox lives on, and would write the run's end).
    const left = memoryRunJournal(journal.records);
    process.kill(-pid, "SIGKILL");
    // Until its processes are reaped the group is still there (its killed leader a zombie): wait for it to go.
    await until(() => gone(pid), 4_000);
    const again = createInboxRuns({ messageAlive: () => true, journal: left, stillRunning: (p, at, seen) => lostRunStillRunning(p, at, process.platform, undefined, seen) });
    const lost: string[] = [];
    await again.recover((record) => lost.push(`${record.message_id}/${record.key}/${record.title}`));
    await again.recover((record) => lost.push(record.key));
    expect(lost).toEqual(["msg_1/r-0000000a/Run it"]);
    expect(again.views("msg_1")["r-0000000a"]).toMatchObject({ state: "stopped", interrupted: "lost", left_running: false });
    again.stopAll();
  });

  test("a lost run whose command still runs: found by its group and start time, its output kept, and Stop ends it", async () => {
    const journal = memoryRunJournal();
    const first = world(() => true, journal);
    first.start("echo $$; echo started; sleep 30");
    await until(() => first.view().lines.length === 2);
    const pid = Number(first.view().lines[0]);
    // The sweep writes what it printed to the journal within a few seconds (an Inbox that dies keeps it).
    await until(() => journal.records.some((r) => r.view.lines.includes("started")), 5_000);
    // A kill -9 of the Inbox: the first Inbox's runs are never told; its command goes on.
    const again = createInboxRuns({ messageAlive: () => true, journal, stillRunning: (p, at, seen) => lostRunStillRunning(p, at, process.platform, undefined, seen) });
    const told: (boolean | null | undefined)[] = [];
    await again.recover((record) => told.push(record.view.left_running));
    expect(told).toEqual([true]);
    expect(again.views("msg_1")["r-0000000a"]).toMatchObject({ interrupted: "lost", left_running: true, lines: [String(pid), "started"] });
    expect(gone(pid)).toBe(false);
    expect(again.stop("msg_1", "r-0000000a")).toBe(false);
    expect(await again.stopLost("msg_1", "r-0000000a")).toMatchObject({ title: "Run it" });
    await until(() => gone(pid), 4_000);
    expect(again.views("msg_1")["r-0000000a"]).toMatchObject({ left_running: false, signal: "SIGTERM" });
    again.stopAll();
  });

  test("Stop on a lost run whose pid is now another program's (another start time) signals nothing; the card says it ended", async () => {
    const journal = memoryRunJournal();
    const first = world(() => true, journal);
    first.start("echo $$; sleep 30");
    await until(() => first.view().lines.length === 1);
    const pid = Number(first.view().lines[0]);
    await until(() => journal.records.some((r) => r.pid === pid), 5_000);
    // At the restart it is ours; by the time Stop is pressed its pid reads as a process started at another time
    // (the run ended and the pid went to another program). The real group stands in for that other program here.
    let same = true;
    const asked: number[] = [];
    const changed: string[] = [];
    const again = createInboxRuns({ messageAlive: () => true, journal, stillRunning: async (p) => (asked.push(p), same), onChange: (id) => changed.push(id) });
    try {
      await again.recover(() => {});
      expect(again.views("msg_1")["r-0000000a"]).toMatchObject({ left_running: true });
      same = false;
      expect(await again.stopLost("msg_1", "r-0000000a")).toBeNull();
      expect(asked).toEqual([pid, pid]);
      // No signal reached it: the group still runs.
      await Bun.sleep(300);
      expect(gone(pid)).toBe(false);
      expect(again.views("msg_1")["r-0000000a"]).toMatchObject({ left_running: false });
      expect(changed).toEqual(["msg_1"]);
    } finally {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      again.stopAll();
    }
  });

  test("a lost run said to be running is looked at again when its card is read (at most every few seconds); one ps that cannot tell keeps it, only an end drops Stop", async () => {
    let clock = 1_000_000;
    let left: boolean | null = true;
    let asked = 0;
    const journal = memoryRunJournal([{ message_id: "msg_1", key: "r-0000000a", title: "Run it", folder: "~/p", live: true, pid: 4242, spawned_at: 999_000, view: { key: "r-0000000a", run_id: "run_1", state: "running", exit_code: null, signal: null, started_at: "", ended_at: null, duration_ms: 0, lines: [], total_lines: 0, partial: "", waiting_for_input: false, needs_terminal: false, error: null, interrupted: null, left_running: null } }]);
    const runs = createInboxRuns({ messageAlive: () => true, journal, now: () => clock, stillRunning: async () => (asked++, left) });
    await runs.recover(() => {});
    expect(asked).toBe(1);
    runs.recheck("msg_1");
    expect(asked).toBe(1);
    clock += 5_000;
    left = null;
    runs.recheck("msg_1");
    await Bun.sleep(10);
    expect(asked).toBe(2);
    // One ps that cannot tell: still running stays (Stop stays), and Stop pressed now signals nothing.
    expect(runs.views("msg_1")["r-0000000a"]).toMatchObject({ left_running: true });
    expect(await runs.stopLost("msg_1", "r-0000000a")).toBeNull();
    expect(runs.views("msg_1")["r-0000000a"]).toMatchObject({ left_running: true });
    // A definite end is what drops it.
    clock += 5_000;
    left = false;
    runs.recheck("msg_1");
    await Bun.sleep(10);
    expect(runs.views("msg_1")["r-0000000a"]).toMatchObject({ left_running: false });
  });

  test("a lost run last said to be running that ends by itself: the agent is told once that it ended", async () => {
    let clock = 1_000_000;
    let left: boolean | null = true;
    const record = { message_id: "msg_1", key: "r-0000000a", title: "Run it", folder: "~/p", live: true, pid: 4242, spawned_at: 999_000, view: { key: "r-0000000a", run_id: "run_1", state: "running", exit_code: null, signal: null, started_at: "", ended_at: null, duration_ms: 0, lines: ["QA started"], total_lines: 1, partial: "", waiting_for_input: false, needs_terminal: false, error: null, interrupted: null, left_running: null } } as const;
    const runs = createInboxRuns({ messageAlive: () => true, journal: memoryRunJournal([structuredClone(record) as never]), now: () => clock, stillRunning: async () => left });
    const told: (boolean | null | undefined)[] = [];
    await runs.recover((r) => told.push(r.view.left_running));
    expect(told).toEqual([true]);
    left = false;
    for (let i = 0; i < 3; i++) {
      clock += 5_000;
      runs.recheck("msg_1");
      await Bun.sleep(5);
    }
    expect(told).toEqual([true, false]);
    // An Inbox started later, with the journal saying it still ran: it finds it ended, and says so once.
    const journal = memoryRunJournal([{ ...structuredClone(record), live: false, view: { ...structuredClone(record.view), state: "stopped", interrupted: "lost", left_running: true } } as never]);
    const later = createInboxRuns({ messageAlive: () => true, journal, stillRunning: async () => false });
    const heard: (boolean | null | undefined)[] = [];
    await later.recover((r) => heard.push(r.view.left_running));
    expect(heard).toEqual([false]);
  });

  test("PowerShell's run has its stdin closed at once (it would wait for it to close), and is not watched for a prompt", async () => {
    const w = world();
    // `cat` reads stdin to its end: with stdin closed it ends at once; held open it would wait forever.
    w.start("", {}, [], "r-0000000a", async () => ({ argv: ["/bin/sh", "-c", 'printf "Password: "; cat'], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, redact: [], closeStdin: true }));
    await until(() => w.ended.length === 1, 3_000);
    expect(w.ended[0]).toMatchObject({ outcome: "exited", waited_for_input: false, view: { state: "done", exit_code: 0 } });
  });

  test("a command too long for Windows' command line fails in plain words, not ENAMETOOLONG", async () => {
    const w = world();
    w.start("", {}, [], "r-0000000a", async () => ({ argv: [`/nonexistent/${"x".repeat(5_000)}`], env: {}, redact: [] }));
    await until(() => w.ended.length === 1, 3_000);
    expect(w.ended[0]!.view.error).toBe(INBOX_RUN_TOO_LONG_WORDS);
  });

  test("finished runs past the first twenty keep only their record's last lines in memory", async () => {
    const w = world();
    const keys = Array.from({ length: 23 }, (_, i) => `r-${String(i).padStart(8, "0")}`);
    for (const key of keys) {
      w.start("i=0; while [ $i -lt 100 ]; do echo line $i; i=$((i+1)); done", {}, [], key);
      await until(() => w.ended.length === keys.indexOf(key) + 1);
    }
    const views = w.runs.views("msg_1");
    expect(Object.keys(views)).toHaveLength(23);
    expect(views[keys[0]!]!.lines).toHaveLength(60);
    expect(views[keys[0]!]!.total_lines).toBe(100);
    expect(views[keys[22]!]!.lines).toHaveLength(100);
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

  test("a secret straddling the cut of a long line: not in the card, the journal or the agent's report", async () => {
    const journal = memoryRunJournal();
    const w = world(() => true, journal);
    w.start(`printf '%3990s' '' | tr ' ' x; printf '${SENTINEL}'; printf '%2000s\\n' '' | tr ' ' x; echo done`, {}, [SENTINEL]);
    await until(() => w.ended.length === 1);
    const where = [JSON.stringify(w.view()), JSON.stringify(journal.records), JSON.stringify(w.ended[0])];
    for (const text of where) for (let n = SENTINEL.length; n >= 4; n--) expect(text.includes(SENTINEL.slice(0, n))).toBe(false);
    expect(w.ended[0]!.view.lines.at(-1)).toBe("done");
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
    expect(buffer.push("tail\nnext")).toEqual([{ text: "x".repeat(INBOX_RUN_LINE_MAX + 1), cut: true }]);
    expect(buffer.partial).toBe("next");
    expect(performance.now() - began).toBeLessThan(1_000);
  });

  test("a progress line keeps only its last states, however many arrive", () => {
    const buffer = new RunLineBuffer();
    for (let i = 0; i < 100_000; i++) buffer.push(`\r${i}%`);
    expect(buffer.partial.length).toBeLessThan(20);
    expect(cleanRunLine(buffer.partial, [])).toBe("99999%");
    expect(buffer.push("\r\u001b[K\n")).toEqual([{ text: "99999%\r\u001b[K", cut: false }]);
  });

  /** No 3-character or longer start of the value anywhere in the text (nor the whole). */
  const noPartOf = (text: string, value: string) => {
    for (let n = value.length; n >= 3; n--) expect([n, text.includes(value.slice(0, n))]).toEqual([n, false]);
  };

  test("a secret where a long line is cut: never shown, whole or its first characters, at any offset", () => {
    for (const at of [1_950, 1_985, 1_990, 1_995, 1_998, 2_000, 2_001, 3_990]) {
      const raw = `${"x".repeat(at)}${SENTINEL}${"x".repeat(2_000)}`;
      const buffer = new RunLineBuffer();
      const lines = [...buffer.push(raw.slice(0, 4_500)), ...buffer.push(raw.slice(4_500)), ...buffer.push("\n")];
      expect(lines).toHaveLength(1);
      const shown = cleanRunLine(lines[0]!.text, [SENTINEL], { cut: lines[0]!.cut });
      expect(shown.endsWith("…")).toBe(true);
      noPartOf(shown, SENTINEL);
    }
    // A cut line that is short once its colour codes go still says it was cut.
    expect(cleanRunLine("\u001b[31mred", [], { cut: true })).toBe("red…");
  });

  test("the line still being written, long and cut in a secret: no part of it shows", () => {
    for (const at of [1_960, 1_990, 1_999, 2_000]) {
      const buffer = new RunLineBuffer();
      buffer.push(`${"y".repeat(at)}${SENTINEL}${"y".repeat(2_500)}`);
      expect(buffer.partialCut).toBe(true);
      noPartOf(cleanRunLine(buffer.partial, [SENTINEL], { open: true, cut: buffer.partialCut }), SENTINEL);
    }
    noPartOf(cleanRunLine(`${"z".repeat(2_100)}${SENTINEL.slice(0, 9)}`, [SENTINEL], { open: true }), SENTINEL);
  });
});
