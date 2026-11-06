/**
 * `bun run test:sandbox` (scripts/test-sandbox.ts) is what agents run instead of
 * building a sandbox env by hand, so a slip here sends every such run to the
 * real home. Stand-in runners record what they were started with; no real
 * test runner, browser or Inbox starts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A runner that records its argv, its env and the seeded .gitconfig, then runs `extra` (sh). */
function fakeRunner(extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "test-sandbox-fake-"));
  dirs.push(dir);
  const bin = join(dir, "runner");
  writeFileSync(
    bin,
    `#!/bin/sh\nn=$(ls "${dir}" | grep -c '^run-')\nout="${dir}/run-$n"\nmkdir -p "$out"\nprintf '%s\\n' "$@" > "$out/argv"\nenv > "$out/env"\ncat "$HOME/.gitconfig" > "$out/gitconfig" 2>/dev/null\n${extra}\n`,
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
  return { bin, run, dir };
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

describe("a run", () => {
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
    // Every agent marker the origin detection reads.
    ...Object.fromEntries(originMarkers().map((name) => [name, name === "PLANNOTATOR_SESSION_TAG" ? "claude-code:caller" : name === "PLANNOTATOR_ORIGIN" ? "codex" : "1"])),
  };

  test("the child starts with the scratch home and sandbox, never the caller's, and the root is gone after", async () => {
    const fake = fakeRunner();
    const code = await runSandbox({ files: [plainFile], passthrough: [] }, { bun: fake.bin, playwright: fake.bin }, parentEnv);
    expect(code).toBe(0);
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
    for (const key of [...originMarkers(), "DOM_TESTS", "SSH_CONNECTION", "PLANNOTATOR_REMOTE", "GIT_DIR", "GIT_WORK_TREE", "T3CODE_THREAD_ID"]) expect(env[key]).toBeUndefined();
    // Switches CI leaves at their defaults stay unset.
    for (const key of ["PLANNOTATOR_UPDATE_CHECK", "PLANNOTATOR_INBOX_NOTES"]) expect(env[key]).toBeUndefined();
    expect(gitconfig).toContain("email =");
    expect(existsSync(root)).toBe(false);
  });

  test("a registry under the root that names port 59812 fails the run, and the root still goes", async () => {
    const fake = fakeRunner(`mkdir -p "$PLANNOTATOR_DATA_DIR/inbox" && printf '{"pid":2,"port":59812,"serverSession":"s"}' > "$PLANNOTATOR_DATA_DIR/inbox/inbox.json"`);
    const code = await runSandbox({ files: [plainFile], passthrough: [] }, { bun: fake.bin, playwright: fake.bin }, parentEnv);
    expect(code).toBe(3);
    expect(existsSync(fake.run(0).env.PLANNOTATOR_TEST_SANDBOX!)).toBe(false);
  });

  test("a registry naming a live process that is not an Inbox leaves it alone", async () => {
    const other = Bun.spawn(["sleep", "30"]);
    try {
      const fake = fakeRunner(`mkdir -p "$PLANNOTATOR_DATA_DIR/inbox" && printf '{"pid":${other.pid},"port":9,"serverSession":"s"}' > "$PLANNOTATOR_DATA_DIR/inbox/inbox.json"`);
      expect(await runSandbox({ files: [plainFile], passthrough: [] }, { bun: fake.bin, playwright: fake.bin }, parentEnv)).toBe(0);
      expect(other.exitCode).toBeNull();
      expect(existsSync(fake.run(0).env.PLANNOTATOR_TEST_SANDBOX!)).toBe(false);
    } finally {
      other.kill(); // inbox-guard: own child
    }
  });

  test("a SIGTERM goes to the running child, no later run starts, and the root still goes", async () => {
    const fake = fakeRunner(`trap 'echo got > "$out/term"; kill $! 2>/dev/null; exit 143' TERM\nsleep 20 &\nwait`);
    const running = runSandbox({ files: [plainFile, domFile], passthrough: [] }, { bun: fake.bin, playwright: fake.bin }, parentEnv);
    const started = join(fake.dir, "run-0", "gitconfig");
    for (let i = 0; i < 100 && !existsSync(started); i++) await Bun.sleep(50);
    await Bun.sleep(100);
    process.emit("SIGTERM", "SIGTERM");
    expect(await running).toBe(143);
    expect(readFileSync(join(fake.dir, "run-0", "term"), "utf8")).toContain("got");
    expect(existsSync(join(fake.dir, "run-1"))).toBe(false);
    expect(existsSync(fake.run(0).env.PLANNOTATOR_TEST_SANDBOX!)).toBe(false);
  });

  test("a failing runner's exit code is the run's", async () => {
    const fake = fakeRunner("exit 7");
    expect(await runSandbox({ files: [plainFile], passthrough: [] }, { bun: fake.bin, playwright: fake.bin }, parentEnv)).toBe(7);
  });
});
