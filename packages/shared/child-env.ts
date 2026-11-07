/**
 * The environment to hand a child process: a copy of the LIVE `process.env`.
 *
 * Why every spawn passes one explicitly: on Bun, `Bun.spawn`, `Bun.spawnSync`
 * and node:child_process's synchronous calls (`spawnSync`, `execFileSync`,
 * `execSync`) give a child the environment the process STARTED with when
 * their `env` option is missing or `undefined` (documented on Bun's
 * `SpawnOptions.env`). The CLI deletes secrets from `process.env` at startup
 * (the pull bridge's `PLANNOTATOR_SESSION_BRIDGE_TOKEN`, the host result and
 * messages files, the review id, …), so a spawn without `env` would hand them
 * to git, gh and agent CLIs anyway. Node's async `spawn`/`execFile` and Bun
 * Shell read the live env and are not affected, but use this helper anywhere
 * code can run under Bun.
 *
 * `tests/child-env-guard.test.ts` fails on a Bun or synchronous spawn in the
 * production trees that passes no `env`.
 *
 * Bun-free and Node-safe: vendored into the Pi extension.
 */

export type ChildEnv = Record<string, string | undefined>;

/**
 * A fresh copy of the live `process.env`, with `extra` laid over it. A key in
 * `extra` whose value is `undefined` removes that variable from the child's
 * environment.
 */
export function childEnv(extra?: Readonly<ChildEnv>): ChildEnv {
  const env: ChildEnv = { ...process.env };
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

/**
 * Whether this process runs inside an agent Plannotator's Ask AI started:
 * `PLANNOTATOR_ASK_AI_CHILD` is exactly "1" (set by `askAiChildEnv` in
 * packages/ai/providers/ask-ai-env.ts). There, Plannotator's own integration
 * stands down: the Inbox MCP shim lists no tools, the plan-review hook exits
 * 0, and the OpenCode plugin registers nothing. Any other value, or none, is
 * a person's session and changes nothing.
 */
export function isAskAiChild(env: Readonly<ChildEnv> = process.env): boolean {
  return env.PLANNOTATOR_ASK_AI_CHILD === "1";
}

/**
 * The live PATH, for `Bun.which(command, { PATH: childPath() })`: without the
 * option Bun.which searches the startup PATH.
 */
export function childPath(): string {
  return process.env.PATH ?? "";
}
