/**
 * A copy of the LIVE `process.env` for a child. On Bun, `Bun.spawn`/`spawnSync` and node's synchronous child_process calls give the child the env the process STARTED with when `env` is missing or undefined; the CLI deletes secrets from `process.env` at startup, so a spawn without `env` would hand them to git, gh and agent CLIs.
 * `tests/child-env-guard.test.ts` fails on a Bun or synchronous spawn that passes no `env`. Bun-free and Node-safe.
 */

export type ChildEnv = Record<string, string | undefined>;

/**
 * Keeps a sandboxed child's git and gh away from the macOS Keychain and prompts: the sandbox's scratch HOME has no keychain, so credential writes showed "Keychain Not Found" on screen.
 * `GIT_CONFIG_NOSYSTEM` skips the system config (Xcode's sets `credential.helper=osxkeychain`); the others stop credential-manager windows, gh prompts and update checks.
 */
export const SANDBOX_NO_KEYCHAIN_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GCM_INTERACTIVE: "never",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
});

/** A key in `extra` whose value is `undefined` removes that variable. Under the test sandbox, `SANDBOX_NO_KEYCHAIN_ENV` goes under `extra`. */
export function childEnv(extra?: Readonly<ChildEnv>): ChildEnv {
  const env: ChildEnv = { ...process.env, ...(process.env.PLANNOTATOR_TEST_SANDBOX ? SANDBOX_NO_KEYCHAIN_ENV : {}) };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

/** True when `PLANNOTATOR_ASK_AI_CHILD` is exactly "1": inside an agent Ask AI started, Plannotator's own integration stands down. */
export function isAskAiChild(env: Readonly<ChildEnv> = process.env): boolean {
  return env.PLANNOTATOR_ASK_AI_CHILD === "1";
}

/** Without the `PATH` option, Bun.which searches the startup PATH. */
export function childPath(): string {
  return process.env.PATH ?? "";
}
