/**
 * `--app` / `--static` belong to `annotate`. The global flag pass used to strip
 * them from every subcommand's argv, so `plannotator snapshot --app` (App
 * Capture) never reached its command.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { takeAnnotateLiveFlags } from "./live-flags";

describe("takeAnnotateLiveFlags", () => {
  test("annotate: both flags are taken out of argv, wherever they sit", () => {
    const args = ["annotate", "--app", "http://localhost:5173", "--static"];
    expect(takeAnnotateLiveFlags(args)).toEqual({ app: true, static: true });
    expect(args).toEqual(["annotate", "http://localhost:5173"]);

    const leading = ["--app", "annotate", "http://localhost:5173"];
    expect(takeAnnotateLiveFlags(leading)).toEqual({ app: true, static: false });
    expect(leading).toEqual(["annotate", "http://localhost:5173"]);
  });

  test("annotate without the flags: nothing changes", () => {
    const args = ["annotate", "notes.md"];
    expect(takeAnnotateLiveFlags(args)).toEqual({ app: false, static: false });
    expect(args).toEqual(["annotate", "notes.md"]);
  });

  test("any other subcommand keeps its own --app / --static", () => {
    for (const subcommand of ["snapshot", "review", "annotate-last", "last"]) {
      const args = [subcommand, "--app", "--static"];
      expect(takeAnnotateLiveFlags(args)).toEqual({ app: false, static: false });
      expect(args).toEqual([subcommand, "--app", "--static"]);
    }
  });
});

describe("plannotator snapshot receives --app", () => {
  test("the snapshot command parses --app itself (and refuses an option it does not know)", async () => {
    // The spawned CLI imports ../dist/{index,review,inbox}.html at module load;
    // drop placeholders for missing ones (CI's test job does not build apps).
    // The snapshot command's own page is imported only when it runs a hub,
    // which an option error never reaches.
    const distDir = resolve(import.meta.dir, "../dist");
    const created: string[] = [];
    let createdDir = false;
    if (!existsSync(distDir)) {
      mkdirSync(distDir, { recursive: true });
      createdDir = true;
    }
    for (const name of ["index.html", "review.html", "inbox.html", "snapshots-hud.html"]) {
      const file = resolve(distDir, name);
      if (!existsSync(file)) {
        writeFileSync(file, "<!doctype html>");
        created.push(file);
      }
    }
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-live-flags-"));
    try {
      // `--app` is accepted, then `--static` (an annotate flag the old global
      // pass also stripped) is refused by the snapshot command's own parser:
      // both reached it. Under the old pass `--static` vanished and the
      // command went on to start a hub.
      const proc = Bun.spawn(["bun", "run", resolve(import.meta.dir, "index.ts"), "snapshot", "--app", "--static"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir },
      });
      const timeout = setTimeout(() => proc.kill(), 15_000);
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      clearTimeout(timeout);
      expect(stderr).toContain("Unknown snapshot option: --static");
      expect(stderr).not.toContain("Unknown snapshot option: --app");
      expect(code).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      for (const file of created) rmSync(file, { force: true });
      if (createdDir) rmSync(distDir, { recursive: true, force: true });
    }
  }, 30_000);
});
