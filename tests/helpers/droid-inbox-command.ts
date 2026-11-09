/**
 * Runs Droid's `/plannotator-inbox` script (apps/droid-plugin/commands/
 * plannotator-inbox.js) against a stand-in `plannotator` first on PATH, from a
 * scratch folder with a scratch data dir, and returns what the agent would
 * read. The stand-in answers with `body` (shell), so no Inbox starts and no
 * browser opens; the real CLI is never reached.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { NO_BROWSER } from "./no-browser";

export const DROID_INBOX_SCRIPT = resolve(import.meta.dir, "../../apps/droid-plugin/commands/plannotator-inbox.js");

export function runDroidInboxCommand(body: string): { status: number | null; stdout: string; stderr: string; argv: string } {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-droid-inbox-"));
  try {
    const calls = join(dir, "calls");
    const bin = join(dir, "plannotator");
    writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${calls}'\n${body}\n`);
    chmodSync(bin, 0o755);
    const run = spawnSync(process.execPath, [DROID_INBOX_SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`, PLANNOTATOR_DATA_DIR: join(dir, "data"), PLANNOTATOR_BROWSER: NO_BROWSER },
      timeout: 20_000,
    });
    const argv = existsSync(calls) ? readFileSync(calls, "utf8").trim() : "";
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", argv };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
