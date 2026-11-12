export type ChildEnv = Record<string, string | undefined>;

export const SANDBOX_NO_KEYCHAIN_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GCM_INTERACTIVE: "never",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
});

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

export function isAskAiChild(env: Readonly<ChildEnv> = process.env): boolean {
  return env.PLANNOTATOR_ASK_AI_CHILD === "1";
}

export function childPath(): string {
  return process.env.PATH ?? "";
}
