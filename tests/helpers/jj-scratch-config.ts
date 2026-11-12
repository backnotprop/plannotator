import { afterAll, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScratchJjConfig {
  readonly dir: string;
  env(extra?: Readonly<Record<string, string | undefined>>): Record<string, string | undefined>;
}

export function useScratchJjConfig(): ScratchJjConfig {
  let dir: string | null = null;
  let saved: string | undefined;

  const scratch = (): string => {
    if (!dir) throw new Error("useScratchJjConfig: the scratch jj config folder exists only while the file's tests run");
    return dir;
  };

  beforeAll(() => {
    saved = process.env.XDG_CONFIG_HOME;
    dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-jj-config-")));
    process.env.XDG_CONFIG_HOME = dir;
  });
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = scratch();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  return {
    get dir() {
      return scratch();
    },
    env(extra) {
      const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: scratch() };
      for (const [key, value] of Object.entries(extra ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return env;
    },
  };
}
