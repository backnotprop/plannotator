/**
 * `bun run test:sandbox` (scripts/test-sandbox.ts) is what agents run instead of
 * building a sandbox env by hand, so a slip here sends every such run to the
 * real home. Stand-in runners record what they were started with; no real
 * test runner, browser or Inbox starts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../tests/helpers/no-browser";
import { accountHome, isScratchDataDir } from "../tests/helpers/real-data-dir";
import { detectOrigin } from "../apps/hook/server/detect-origin";
import { originMarkers, parseSandboxArgs, planRuns, REPO_ROOT, runSandbox, SandboxRefusal } from "./test-sandbox";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const plainFile = "tests/agents-md-size.test.ts";
const domFile = "packages/ui/markdownEditorFidelity.test.tsx";
const spec = "tests/e2e/annotate-added-folder.spec.ts";

/**
 * A runner that records its argv, its env and the seeded .gitconfig, sets its
 * `trap`s, writes `ready`, then runs `body` (sh). Its own output goes nowhere,
 * so nothing it leaves running holds the test run's pipes open.
 */
function fakeRunner({ trap = "", body = "" }: { trap?: string; body?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "test-sandbox-fake-"));
  dirs.push(dir);
  const bin = join(dir, "runner");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec </dev/null >/dev/null 2>&1\nn=$(ls "${dir}" | grep -c '^run-')\nout="${dir}/run-$n"\nmkdir -p "$out"\nprintf '%s\\n' "$@" > "$out/argv"\nenv > "$out/env"\ncat "$HOME/.gitconfig" > "$out/gitconfig"\n${trap}\n: > "$out/ready"\n${body}\n`,
  );
  chmodSync(bin, 0o755);
  const run = (n: number) => {
    const out = join(dir, `run-${n}`);
    const env = Object.fromEntries(
      readFileSync(join(out, "env"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { argv: readFileSync(join(out, "argv"), "utf8").trim().split("\n"), env, gitconfig: readFileSync(join(out, "gitconfig"), "utf8") };
  };
  /** Resolves once run `n` has set its traps. */
  const ready = async (n = 0) => {
    for (let i = 0; i < 200 && !existsSync(join(dir, `run-${n}`, "ready")); i++) await Bun.sleep(25);
    expect(existsSync(join(dir, `run-${n}`, "ready"))).toBe(true);
  };
  return { bin, run, dir, ready };
}

/** A body that keeps the runner alive for up to 10 s, answering traps within 0.1 s. */
const WAIT = "i=0; while [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done";

/**
 * Every variable detectOrigin reads, found by running it over a recording
 * Proxy: first with nothing set, then with each name found so far set, until no
 * new name turns up (a marker read only once another is set, as DSH_SHELL's
 * exceptions are). `enumerated` is true when it lists the env's keys, which a
 * name list cannot cover.
 */
function namesDetectOriginReads(): { names: Set<string>; enumerated: boolean } {
  const names = new Set<string>();
  let enumerated = false;
  const probe = (set: Record<string, string>) => {
    const record = (key: string | symbol) => typeof key === "string" && /^[A-Z][A-Z0-9_]*$/.test(key) && names.add(key);
    detectOrigin(
      new Proxy(set, {
        get: (target, key) => (record(key), Reflect.get(target, key)),
        has: (target, key) => (record(key), Reflect.has(target, key)),
        ownKeys: (target) => ((enumerated = true), Reflect.ownKeys(target)),
      }),
    );
  };
  probe({});
  for (let size = -1; size !== names.size; ) {
    size = names.size;
    for (const name of [...names]) for (const value of ["1", "claude-code:probe"]) probe({ [name]: value });
  }
  return { names, enumerated };
}

describe("the refusals", () => {
  const refused = (argv: string[], env: Record<string, string> = {}) => {
    try {
      parseSandboxArgs(argv, REPO_ROOT, env);
    } catch (error) {
      expect(error).toBeInstanceOf(SandboxRefusal);
      return (error as Error).message;
    }
    throw new Error(`not refused: ${argv.join(" ")}`);
  };

  test("an empty list, flags only, a missing file and the parity spec", () => {
    expect(refused([])).toContain("whole suite");
    expect(refused(["--", "--isolate"])).toContain("whole suite");
    expect(refused(["--isolate", plainFile])).toContain("after `--`");
    expect(refused(["nope.test.ts"])).toContain("not a file");
    expect(refused(["tests/e2e/inbox-thread-parity.spec.ts"])).toContain("own config");
    expect(refused(["tests/e2e"])).toContain("not a file");
    expect(refused(["apps/pi-extension/inbox.test.ts"])).toContain("on purpose");
    expect(refused(["tests/never-touch-the-real-inbox.test.ts"])).toContain("on purpose");
    const outside = mkdtempSync(join(tmpdir(), "test-sandbox-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "a.test.ts"), "");
    expect(refused([join(outside, "a.test.ts")])).toContain("outside this repository");
  });

  test("anything after -- that is not a flag: a path or a bare word would add files to the run", () => {
    for (const extra of ["./", ".", "./apps/pi-extension/inbox.test.ts", "tests/never-touch-the-real-inbox.test.ts", "store", ""]) {
      expect(refused([plainFile, "--", "--bail", extra])).toContain("only runner flags");
    }
  });

  test("a config after -- (it would swap the e2e config or the bunfig preload)", () => {
    for (const flag of ["--config=tests/e2e/inbox-thread-parity.config.ts", "-c=x", "--config", "-c"]) expect(refused([plainFile, "--", flag])).toContain("config");
  });

  test("a file that needs happy-dom but is in neither the DOM list nor a workflow DOM step", () => {
    const dir = join(REPO_ROOT, ".local");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `test-sandbox-unlisted-${process.pid}.test.tsx`);
    writeFileSync(file, "import { describe } from 'bun:test';\nconst hasDom = typeof document !== 'undefined';\ndescribe.if(hasDom)('x', () => {});\n");
    try {
      expect(refused([file])).toContain("tests/dom-test-list.txt");
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("anything naming the person's Inbox port", () => {
    expect(refused([plainFile, "--", "--port=59812"])).toContain("59812");
    expect(refused([plainFile], { PLANNOTATOR_PORT: "59812" })).toContain("59812");
  });

  test("files resolve from the cwd to repo paths; flags after -- pass through", () => {
    expect(parseSandboxArgs([`./${plainFile}`, "--", "--bail", "--test-name-pattern=x"], REPO_ROOT, {})).toEqual({ files: [plainFile], passthrough: ["--bail", "--test-name-pattern=x"] });
  });
});

describe("the routing", () => {
  test("plain tests in one bun test, listed DOM files with DOM_TESTS=1 and --isolate, e2e specs under Playwright", () => {
    const runs = planRuns({ files: [plainFile, domFile, spec], passthrough: ["--bail"] }, { HOME: "/h" }, { bun: "BUN", playwright: "PW" });
    expect(runs.map((r) => r.argv)).toEqual([
      ["BUN", "test", `./${plainFile}`, "--bail"],
      ["BUN", "test", "--isolate", `./${domFile}`, "--bail"],
      ["PW", "test", "-c", "tests/e2e/playwright.config.ts", spec, "--bail"],
    ]);
    expect(runs.map((r) => r.env.DOM_TESTS as string | undefined)).toEqual([undefined, "1", undefined]);
  });

  test("a DOM-gated file CI runs in its own process gets DOM_TESTS=1 without --isolate", () => {
    const [run] = planRuns({ files: ["packages/ui/hooks/useFileBrowser.test.tsx"], passthrough: [] }, {}, { bun: "BUN", playwright: "PW" });
    expect(run!.argv).toEqual(["BUN", "test", "./packages/ui/hooks/useFileBrowser.test.tsx"]);
    expect(run!.env.DOM_TESTS).toBe("1");
  });
});

describe("the agent markers", () => {
  test("originMarkers() names every variable detectOrigin reads", () => {
    const { names, enumerated } = namesDetectOriginReads();
    expect(enumerated).toBe(false);
    // A probe that stopped finding names would pass forever: today it finds 14.
    expect(names.size).toBeGreaterThan(10);
    const markers = new Set(originMarkers());
    expect([...names].filter((name) => !markers.has(name))).toEqual([]);
  });
});

describe("a run", () => {
  const runTimeout = { timeout: 20_000 };
  const parentEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: accountHome() ?? "/",
    PLANNOTATOR_DATA_DIR: "/real/data",
    XDG_DATA_HOME: "/real/share",
    CODEX_HOME: "/real/.codex",
    DOM_TESTS: "1",
    SSH_CONNECTION: "1 2 3 4",
    PLANNOTATOR_REMOTE: "1",
    GIT_DIR: "/outer/.git",
    GIT_WORK_TREE: "/outer",
    T3CODE_THREAD_ID: "t",
    // Every variable detectOrigin reads, found by running it (not from the list under test).
    ...Object.fromEntries([...namesDetectOriginReads().names].map((name) => [name, name === "PLANNOTATOR_SESSION_TAG" ? "claude-code:caller" : name === "PLANNOTATOR_ORIGIN" ? "codex" : "1"])),
  };
  /** One run with its own signal source, so a signal a test sends reaches only that run. */
  const start = (fake: ReturnType<typeof fakeRunner>, files = [plainFile]) => {
    const signals = new EventEmitter();
    const running = runSandbox({ files, passthrough: [] }, { bun: fake.bin, playwright: fake.bin }, parentEnv, { signals, graceMs: 300 });
    return { signals, running };
  };

  test("the child starts with the scratch home and sandbox, never the caller's, and the root is gone after", async () => {
    const fake = fakeRunner();
    expect(await start(fake).running).toBe(0);
    const { argv, env, gitconfig } = fake.run(0);
    expect(argv).toEqual(["test", `./${plainFile}`]);
    const root = env.PLANNOTATOR_TEST_SANDBOX!;
    expect(isScratchDataDir(root)).toBe(true);
    expect(env.HOME).toBe(join(root, "home"));
    expect(env.HOME).not.toBe(accountHome());
    for (const key of ["PLANNOTATOR_DATA_DIR", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) expect(env[key]!.startsWith(`${root}/`)).toBe(true);
    expect(env.PLANNOTATOR_BROWSER).toBe(NO_BROWSER);
    expect(env.NO_ANON_PING).toBe("1");
    expect(env.PLANNOTATOR_INBOX_CONNECT).toBe("0");
    expect(env.PLANNOTATOR_FEEDBACK_URL).toBe("http://127.0.0.1:9/feedback");
    // The calling agent, remote mode and an outer repo never reach the tests: the child looks like CI.
    expect(detectOrigin(env)).toBe(detectOrigin({}));
    for (const key of [...namesDetectOriginReads().names, "DOM_TESTS", "SSH_CONNECTION", "PLANNOTATOR_REMOTE", "GIT_DIR", "GIT_WORK_TREE", "T3CODE_THREAD_ID"]) expect(env[key]).toBeUndefined();
    // Switches CI leaves at their defaults stay unset.
    for (const key of ["PLANNOTATOR_UPDATE_CHECK", "PLANNOTATOR_INBOX_NOTES"]) expect(env[key]).toBeUndefined();
    expect(gitconfig).toContain("email =");
    expect(existsSync(root)).toBe(false);
  }, runTimeout);

  test("a registry under the root that names port 59812 fails the run, and the root still goes", async () => {
    const fake = fakeRunner({ body: `mkdir -p "$PLANNOTATOR_DATA_DIR/inbox" && printf '{"pid":2,"port":59812,"serverSession":"s"}' > "$PLANNOTATOR_DATA_DIR/inbox/inbox.json"` });
    expect(await start(fake).running).toBe(3);
    expect(existsSync(fake.run(0).env.PLANNOTATOR_TEST_SANDBOX!)).toBe(false);
  }, runTimeout);

  test("a registry naming a live process that is not an Inbox leaves it alone", async () => {
    const other = Bun.spawn(["sleep", "30"]);
    try {
      const fake = fakeRunner({ body: `mkdir -p "$PLANNOTATOR_DATA_DIR/inbox" && printf '{"pid":${other.pid},"port":9,"serverSession":"s"}' > "$PLANNOTATOR_DATA_DIR/inbox/inbox.json"` });
      expect(await start(fake).running).toBe(0);
      expect(other.exitCode).toBeNull();
      expect(existsSync(fake.run(0).env.PLANNOTATOR_TEST_SANDBOX!)).toBe(false);
    } finally {
      other.kill(); // inbox-guard: own child
    }
  }, runTimeout);

  test("a SIGTERM goes to the running child, no later run starts, and the root still goes", async () => {
    const fake = fakeRunner({ trap: `trap 'echo got > "$out/term"; exit 143' TERM`, body: WAIT });
    const { signals, running } = start(fake, [plainFile, domFile]);
    await fake.ready();
    signals.emit("SIGTERM", "SIGTERM");
    expect(await running).toBe(143);
    expect(readFileSync(join(fake.dir, "run-0", "term"), "utf8")).toContain("got");
    expect(existsSync(join(fake.dir, "run-1"))).toBe(false);
    expect(existsSync(fake.run(0).env.PLANNOTATOR_TEST_SANDBOX!)).toBe(false);
  }, runTimeout);

  test("a child that ignores SIGTERM is killed after the grace period, and the root still goes", async () => {
    const fake = fakeRunner({ trap: `trap 'echo got >> "$out/term"' TERM`, body: WAIT });
    const { signals, running } = start(fake);
    await fake.ready();
    const sent = Date.now();
    signals.emit("SIGTERM", "SIGTERM");
    expect(await running).not.toBe(0);
    // Well before the runner's own 10 s end.
    expect(Date.now() - sent).toBeLessThan(5_000);
    expect(readFileSync(join(fake.dir, "run-0", "term"), "utf8")).toContain("got");
    expect(existsSync(fake.run(0).env.PLANNOTATOR_TEST_SANDBOX!)).toBe(false);
  }, runTimeout);

  test("a SIGINT is not passed on (a terminal's Ctrl-C already reached the child); SIGTERM follows if the child keeps running", async () => {
    const fake = fakeRunner({ trap: `trap 'echo got > "$out/int"' INT\ntrap 'echo got > "$out/term"; exit 143' TERM`, body: WAIT });
    const { signals, running } = start(fake);
    await fake.ready();
    signals.emit("SIGINT", "SIGINT");
    expect(await running).toBe(143);
    expect(existsSync(join(fake.dir, "run-0", "int"))).toBe(false);
    expect(existsSync(join(fake.dir, "run-0", "term"))).toBe(true);
  }, runTimeout);

  test("a failing runner's exit code is the run's", async () => {
    const fake = fakeRunner({ body: "exit 7" });
    expect(await start(fake).running).toBe(7);
  }, runTimeout);
});
