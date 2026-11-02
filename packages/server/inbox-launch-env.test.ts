import { describe, expect, test } from "bun:test";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { CLAUDE_SKIP_PERMISSIONS_ENV, createLoginEnv, launchPlainEnv, launchSettingsEnv, launchSpawnEnv, launchStartOf, parseMarkedEnv, shellSkipsPermissions } from "./inbox-launch-env";

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
  PLANNOTATOR_BROWSER: NO_BROWSER,
  CODEX_THREAD_ID: "t1",
};

describe("launchSpawnEnv", () => {
  test("drops every PLANNOTATOR_* name and the session markers, keeps the person's env", () => {
    const env = launchSpawnEnv(login);
    expect(Object.keys(env).filter((name) => name.startsWith("PLANNOTATOR_"))).toEqual([]);
    for (const name of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PROJECT_DIR", "CODEX_THREAD_ID"]) expect(env[name]).toBeUndefined();
    expect(env).toMatchObject({ PATH: "/usr/bin:/bin", HOME: "/Users/me", CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  test("the skip-permissions export never rides the --bg env (it would reach the shared supervisor)", () => {
    const shell = { ...login, [CLAUDE_SKIP_PERMISSIONS_ENV]: "1" };
    expect(launchSpawnEnv(shell)[CLAUDE_SKIP_PERMISSIONS_ENV]).toBeUndefined();
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
    const env = launchSettingsEnv(login, { launchId: "lch_1", key: "k", dataDir: null, fullPermissions: false, bypassAvailable: false });
    expect(env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work", PLANNOTATOR_LAUNCH: "lch_1", PLANNOTATOR_LAUNCH_KEY: "k" });
  });

  test("the hook's leave to switch to Full permissions only with the person's consent and not already full; never Claude's export", () => {
    const allowed = launchSettingsEnv(login, { launchId: "lch_1", key: "k", dataDir: "/data/inbox", fullPermissions: false, bypassAvailable: true });
    expect(allowed.PLANNOTATOR_DATA_DIR).toBe("/data/inbox");
    expect(allowed.PLANNOTATOR_LAUNCH_FULL_PERMISSIONS).toBe("1");
    expect(allowed[CLAUDE_SKIP_PERMISSIONS_ENV]).toBeUndefined();
    const full = launchSettingsEnv(login, { launchId: "lch_1", key: "k", dataDir: null, fullPermissions: true, bypassAvailable: true });
    // Bypass is the start's --permission-mode; the export is inert beside a PermissionRequest hook anyway.
    expect(full[CLAUDE_SKIP_PERMISSIONS_ENV]).toBeUndefined();
    // Already full: nothing to switch to.
    expect(full.PLANNOTATOR_LAUNCH_FULL_PERMISSIONS).toBeUndefined();
  });

  test("how a launch starts: the switch, then the person's defaultMode, then the shell's export, then auto; full only with their consent", () => {
    const off = { consent: false, disabled: false };
    const on = { consent: true, disabled: false };
    const cases: [string, Parameters<typeof launchStartOf>[0], { full: boolean; ownMode: boolean; bypass: boolean }][] = [
      // The shell's export set or unset, crossed with the switch unset, on and off (consent recorded).
      ["unset, no export", { setting: null, defaultMode: null, shellSkips: false, ...on }, { full: false, ownMode: false, bypass: true }],
      ["unset, export", { setting: null, defaultMode: null, shellSkips: true, ...on }, { full: true, ownMode: false, bypass: true }],
      ["on, no export", { setting: true, defaultMode: null, shellSkips: false, ...on }, { full: true, ownMode: false, bypass: true }],
      ["on, export", { setting: true, defaultMode: null, shellSkips: true, ...on }, { full: true, ownMode: false, bypass: true }],
      ["off, no export", { setting: false, defaultMode: null, shellSkips: false, ...on }, { full: false, ownMode: false, bypass: true }],
      ["off, export", { setting: false, defaultMode: null, shellSkips: true, ...on }, { full: false, ownMode: false, bypass: true }],
      // The person's own defaultMode comes before the export, and is never forced to auto.
      ["unset, acceptEdits", { setting: null, defaultMode: "acceptEdits", shellSkips: true, ...on }, { full: false, ownMode: true, bypass: true }],
      ["unset, defaultMode bypass", { setting: null, defaultMode: "bypassPermissions", shellSkips: false, ...on }, { full: true, ownMode: false, bypass: true }],
      // The switch off never widens a person's own mode to auto (Full tried, then turned off again).
      ["off, acceptEdits", { setting: false, defaultMode: "acceptEdits", shellSkips: false, ...on }, { full: false, ownMode: true, bypass: true }],
      ["off, default", { setting: false, defaultMode: "default", shellSkips: false, ...on }, { full: false, ownMode: true, bypass: true }],
      ["on, acceptEdits, no consent", { setting: true, defaultMode: "acceptEdits", shellSkips: false, ...off }, { full: false, ownMode: true, bypass: false }],
      // No consent (or bypass disabled by policy): never full, and nothing to switch to.
      ["on, no consent", { setting: true, defaultMode: null, shellSkips: false, ...off }, { full: false, ownMode: false, bypass: false }],
      ["unset, export, no consent", { setting: null, defaultMode: null, shellSkips: true, ...off }, { full: false, ownMode: false, bypass: false }],
      ["on, disabled", { setting: true, defaultMode: null, shellSkips: false, consent: true, disabled: true }, { full: false, ownMode: false, bypass: false }],
    ];
    for (const [name, input, expected] of cases) {
      const { full, ownMode, bypass } = launchStartOf(input);
      expect([name, { full, ownMode, bypass }]).toEqual([name, expected]);
    }
    expect(["1", "true", "yes", "on", "0", "", "false"].map((v) => shellSkipsPermissions({ [CLAUDE_SKIP_PERMISSIONS_ENV]: v }))).toEqual([true, true, true, true, false, false, false]);
  });

  test("bypass mode comes from the launch record alone: the shell's own skip-permissions export is never copied while it is off", () => {
    const shell = { ...login, [CLAUDE_SKIP_PERMISSIONS_ENV]: "1" };
    expect(launchSettingsEnv(shell, { launchId: "lch_1", key: "k", dataDir: null, fullPermissions: false, bypassAvailable: true })[CLAUDE_SKIP_PERMISSIONS_ENV]).toBeUndefined();
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
