import { describe, expect, test } from "bun:test";
import { CLAUDE_SKIP_PERMISSIONS_ENV, createLoginEnv, launchSettingsEnv, launchSpawnEnv, parseMarkedEnv } from "./inbox-launch-env";

const login = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/me",
  SHELL: "/bin/zsh",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SESSION_ID: "abc",
  CLAUDE_PROJECT_DIR: "/somewhere",
  PLANNOTATOR_SESSION_TAG: "tag",
  PLANNOTATOR_DATA_DIR: "/tmp/inbox-data",
  PLANNOTATOR_ASK_AI_CHILD: "1",
  CODEX_THREAD_ID: "t1",
};

describe("launchSpawnEnv", () => {
  test("drops the starting session's markers and the Inbox's data dir, keeps the person's env", () => {
    const env = launchSpawnEnv(login);
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "PLANNOTATOR_SESSION_TAG", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_ASK_AI_CHILD", "CODEX_THREAD_ID"]) expect(env[name]).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/usr/bin:/bin", HOME: "/Users/me", CLAUDE_CODE_USE_BEDROCK: "1" });
  });
});

describe("launchSettingsEnv", () => {
  test("copies the shell's own CLAUDE_* values but never a session's, and adds the launch's markers", () => {
    const env = launchSettingsEnv(login, { launchId: "lch_1", key: "k", dataDir: null, fullPermissions: false });
    expect(env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work", PLANNOTATOR_LAUNCH: "lch_1", PLANNOTATOR_LAUNCH_KEY: "k" });
  });

  test("a non-default data dir and full permissions go in the file", () => {
    const env = launchSettingsEnv(login, { launchId: "lch_1", key: "k", dataDir: "/data/inbox", fullPermissions: true });
    expect(env.PLANNOTATOR_DATA_DIR).toBe("/data/inbox");
    expect(env[CLAUDE_SKIP_PERMISSIONS_ENV]).toBe("1");
  });
});

test("parseMarkedEnv reads only what is between the markers, values with = and newlines whole", () => {
  const mark = "__PLANNOTATOR_LAUNCH_ENV__";
  const stdout = `motd noise\n${mark}A=1\0B=x=y\0C=line1\nline2\0${mark}trailing`;
  expect(parseMarkedEnv(stdout)).toEqual({ A: "1", B: "x=y", C: "line1\nline2" });
  expect(parseMarkedEnv("no markers")).toBeNull();
});

describe("createLoginEnv", () => {
  test("logs names only, caches for the TTL, and falls back to the Inbox's env when the shell fails", async () => {
    const lines: string[] = [];
    let t = 0;
    let calls = 0;
    const mark = "__PLANNOTATOR_LAUNCH_ENV__";
    const read = createLoginEnv({
      run: async () => {
        calls++;
        return calls === 1 ? { exitCode: 0, stdout: `${mark}CLAUDE_SECRET_THING=s3cret-value\0PATH=/bin\0${mark}` } : { exitCode: 1, stdout: "" };
      },
      env: () => ({ SHELL: "/bin/zsh", PATH: "/own" }),
      now: () => t,
      ttlMs: 1000,
      log: (line) => lines.push(line),
    });
    expect(await read()).toEqual({ CLAUDE_SECRET_THING: "s3cret-value", PATH: "/bin" });
    t = 500;
    await read();
    expect(calls).toBe(1);
    t = 2000;
    expect(await read()).toEqual({ SHELL: "/bin/zsh", PATH: "/own" });
    expect(lines.join("\n")).toContain("CLAUDE_SECRET_THING");
    expect(lines.join("\n")).not.toContain("s3cret-value");
  });
});
