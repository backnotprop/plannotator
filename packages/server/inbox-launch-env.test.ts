import { describe, expect, test } from "bun:test";
import { CLAUDE_SKIP_PERMISSIONS_ENV, createLoginEnv, launchPlainEnv, launchSettingsEnv, launchSpawnEnv, parseMarkedEnv } from "./inbox-launch-env";

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
  PLANNOTATOR_PORT: "19432",
  PLANNOTATOR_BROWSER: "none",
  CODEX_THREAD_ID: "t1",
};

describe("launchSpawnEnv", () => {
  test("drops every PLANNOTATOR_* name and the session markers, keeps the person's env", () => {
    const env = launchSpawnEnv(login);
    expect(Object.keys(env).filter((name) => name.startsWith("PLANNOTATOR_"))).toEqual([]);
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "CODEX_THREAD_ID"]) expect(env[name]).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/usr/bin:/bin", HOME: "/Users/me", CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  test("the shell's own skip-permissions export never rides the --bg env; the switch alone sets it", () => {
    const shell = { ...login, [CLAUDE_SKIP_PERMISSIONS_ENV]: "1" };
    expect(launchSpawnEnv(shell)[CLAUDE_SKIP_PERMISSIONS_ENV]).toBeUndefined();
    expect(launchSpawnEnv(shell, false)[CLAUDE_SKIP_PERMISSIONS_ENV]).toBeUndefined();
    expect(launchSpawnEnv(login, true)[CLAUDE_SKIP_PERMISSIONS_ENV]).toBe("1");
  });
});

describe("launchPlainEnv", () => {
  test("the Inbox's own env for status, stop and respawn: no PLANNOTATOR_* or session marker, the person's CLAUDE_CONFIG_DIR kept, the extra dirs after its PATH", () => {
    const env = launchPlainEnv({ ...login, [CLAUDE_SKIP_PERMISSIONS_ENV]: "1" }, ["/Users/me/.local/bin", "/bin"]);
    expect(Object.keys(env).filter((name) => name.startsWith("PLANNOTATOR_"))).toEqual([]);
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", CLAUDE_SKIP_PERMISSIONS_ENV]) expect(env[name]).toBeUndefined();
    // The same config dir for availability, status, stop, respawn and rm as the start uses.
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/me/.claude-work");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.PATH).toBe("/usr/bin:/bin:/Users/me/.local/bin");
    expect(env.HOME).toBe("/Users/me");
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
    // The permission hook's "Allow and switch to Full permissions" is honoured only with this.
    expect(env.PLANNOTATOR_LAUNCH_FULL_PERMISSIONS).toBe("1");
  });

  test("bypass mode comes from the switch alone: the shell's own skip-permissions export is dropped while it is off", () => {
    const shell = { ...login, [CLAUDE_SKIP_PERMISSIONS_ENV]: "1" };
    expect(launchSettingsEnv(shell, { launchId: "lch_1", key: "k", dataDir: null, fullPermissions: false })[CLAUDE_SKIP_PERMISSIONS_ENV]).toBeUndefined();
  });
});

test("parseMarkedEnv reads only what is between the markers, values with = and newlines whole", () => {
  const mark = "__PLANNOTATOR_LAUNCH_ENV__";
  const stdout = `motd noise\n${mark}A=1\0B=x=y\0C=line1\nline2\0${mark}trailing`;
  expect(parseMarkedEnv(stdout)).toEqual({ A: "1", B: "x=y", C: "line1\nline2" });
  expect(parseMarkedEnv("no markers")).toBeNull();
});

describe("createLoginEnv", () => {
  test("the shell starts from the Inbox's env through the filter, is read on every call, logs names only, and falls back to the plain env", async () => {
    const lines: string[] = [];
    const seeds: Record<string, string | undefined>[] = [];
    const mark = "__PLANNOTATOR_LAUNCH_ENV__";
    const own = { SHELL: "/bin/zsh", HOME: "/Users/me", PATH: "/own", PLANNOTATOR_PORT: "1", CLAUDE_CODE_SESSION_ID: "x", SECRET_OF_THE_INBOX: "y" };
    const read = createLoginEnv({
      run: async (_argv, options) => {
        seeds.push({ ...options.env });
        return seeds.length === 1 ? { exitCode: 0, stdout: `${mark}CLAUDE_SECRET_THING=s3cret-value\0PATH=/bin\0${mark}` } : { exitCode: 1, stdout: "" };
      },
      env: () => own,
      log: (line) => lines.push(line),
    });
    expect(await read()).toEqual({ CLAUDE_SECRET_THING: "s3cret-value", PATH: "/bin" });
    expect(seeds[0]).toEqual({ SHELL: "/bin/zsh", HOME: "/Users/me", PATH: "/own", SECRET_OF_THE_INBOX: "y" });
    expect(await read()).toEqual({ SHELL: "/bin/zsh", HOME: "/Users/me", PATH: "/own", SECRET_OF_THE_INBOX: "y" });
    expect(seeds).toHaveLength(2);
    expect(lines.join("\n")).toContain("CLAUDE_SECRET_THING");
    expect(lines.join("\n")).not.toContain("s3cret-value");
  });

  test("what launchd and the session give (SSH_AUTH_SOCK, a launchctl proxy, LC_*) reaches the shell and the --bg env", async () => {
    const mark = "__PLANNOTATOR_LAUNCH_ENV__";
    const own = { SHELL: "/bin/zsh", HOME: "/Users/me", PATH: "/own", SSH_AUTH_SOCK: "/private/tmp/launchd-1/Listeners", HTTPS_PROXY: "http://proxy:3128", LC_ALL: "en_US.UTF-8" };
    const read = createLoginEnv({
      // A login shell inherits what it was started with and adds its rc's exports.
      run: async (_argv, options) => ({
        exitCode: 0,
        stdout: `${mark}${Object.entries({ ...options.env, CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" })
          .map(([name, value]) => `${name}=${value}`)
          .join("\0")}${mark}`,
      }),
      env: () => own,
    });
    const bg = launchSpawnEnv(await read());
    expect(bg).toMatchObject({ SSH_AUTH_SOCK: own.SSH_AUTH_SOCK, HTTPS_PROXY: own.HTTPS_PROXY, LC_ALL: own.LC_ALL, CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" });
  });

  test("an Inbox started inside a Claude session: that session's names reach neither the shell, the settings file nor the --bg env", async () => {
    const sessionNames = {
      CLAUDE_CODE_SESSION_ID: "parent-session",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/parent.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "parent-token",
      CLAUDE_PID: "4242",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_EXECPATH: "/opt/claude/bin/claude",
      CLAUDECODE: "1",
    };
    const parent = { SHELL: "/bin/zsh", HOME: "/Users/me", PATH: "/own", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work", ...sessionNames };
    const mark = "__PLANNOTATOR_LAUNCH_ENV__";
    const seeds: Record<string, string | undefined>[] = [];
    // Worst case: the shell hands them back anyway (as if inherited), next to the person's own value.
    const echoed = Object.entries({ ...sessionNames, CLAUDE_CONFIG_DIR: "/Users/me/.claude-work", PATH: "/bin" })
      .map(([name, value]) => `${name}=${value}`)
      .join("\0");
    let fail = false;
    const read = createLoginEnv({
      run: async (_argv, options) => {
        seeds.push({ ...options.env });
        return fail ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: `${mark}${echoed}${mark}` };
      },
      env: () => parent,
    });
    const names = Object.keys(sessionNames);
    const none = (env: Record<string, string | undefined>) => expect(Object.keys(env).filter((name) => names.includes(name))).toEqual([]);

    const shell = await read();
    none(seeds[0]!);
    const settings = launchSettingsEnv(shell, { launchId: "lch_1", key: "k", dataDir: null, fullPermissions: false });
    none(settings);
    expect(settings.CLAUDE_CONFIG_DIR).toBe("/Users/me/.claude-work");
    none(launchSpawnEnv(shell));
    // The shell could not be read: the Inbox's own env stands in, still without them.
    fail = true;
    const fallback = await read();
    none(fallback);
    none(launchSpawnEnv(fallback));
    none(launchSettingsEnv(fallback, { launchId: "lch_1", key: "k", dataDir: null, fullPermissions: false }));
    // Every other call (status, stop, respawn) runs with the plain env: none there either.
    none(launchPlainEnv(parent, []));
  });
});
