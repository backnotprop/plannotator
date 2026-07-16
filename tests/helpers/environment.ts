import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create an environment-and-temp-directory fixture for integration tests.
 * Call reset before each test and restore from afterEach.
 */
export function createTestEnvironment(
  envKeys: readonly string[],
  tempPrefix: string,
): {
  reset(): void;
  makeTempDir(): string;
  restore(): void;
} {
  const savedEnv = new Map<string, string | undefined>();
  const tempDirs: string[] = [];

  return {
    reset() {
      if (savedEnv.size > 0) {
        throw new Error("Test environment is already active");
      }
      for (const key of envKeys) {
        savedEnv.set(key, process.env[key]);
        delete process.env[key];
      }
    },
    makeTempDir() {
      const dir = mkdtempSync(join(tmpdir(), tempPrefix));
      tempDirs.push(dir);
      return dir;
    },
    restore() {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      savedEnv.clear();
      for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
