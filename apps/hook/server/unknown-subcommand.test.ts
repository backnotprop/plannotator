import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findClosestSubcommand,
  findUnknownSubcommand,
  formatUnknownSubcommandError,
  KNOWN_SUBCOMMANDS,
} from "./unknown-subcommand";

describe("unknown subcommand", () => {
  test("the known command registry matches the dispatcher", () => {
    const source = readFileSync(resolve(import.meta.dir, "index.ts"), "utf8");
    const dispatched = new Set(
      [...source.matchAll(/args\[0\] === "([^"]+)"/g)].map((match) => match[1]),
    );

    expect(dispatched.size).toBeGreaterThan(10);
    expect(dispatched).toEqual(KNOWN_SUBCOMMANDS);
  });

  test("leaves flags and the no-argument hook invocation to the dispatcher", () => {
    expect(findUnknownSubcommand([])).toBeNull();
    expect(findUnknownSubcommand(["--help"])).toBeNull();
    expect(findUnknownSubcommand(["-v"])).toBeNull();
    expect(findUnknownSubcommand(["review", "--nonsense"])).toBeNull();
  });

  test("reports the offending token", () => {
    expect(findUnknownSubcommand(["annotatte", "README.md"])).toBe("annotatte");
    expect(findUnknownSubcommand(["xyzzy"])).toBe("xyzzy");
  });

  test("suggests the nearest documented command", () => {
    expect(findClosestSubcommand("annotatte")).toBe("annotate");
    expect(findClosestSubcommand("revieww")).toBe("review");
    expect(findClosestSubcommand("guid")).toBe("guide");
    expect(findClosestSubcommand("annot")).toBe("annotate");
    expect(findClosestSubcommand("a")).toBeNull();
    expect(findClosestSubcommand("xyzzy")).toBeNull();
    expect(findClosestSubcommand("x".repeat(10_000))).toBeNull();
  });

  test("error text names the typo and points at --help", () => {
    const message = formatUnknownSubcommandError("annotatte");
    expect(message).toContain("Unknown command: annotatte");
    expect(message).toContain("plannotator annotate");
    expect(message).toContain("--help");
  });

  test("a typo'd subcommand exits instead of blocking on an open stdin", async () => {
    // The spawned CLI imports ../dist/{index,review}.html at module load.
    // Dev machines always have them built, but CI's test job does not build
    // the apps, so drop empty placeholders for any missing artifact and
    // remove exactly what this test created afterwards. The guard under test
    // exits before either page is ever served, so content is irrelevant.
    const distDir = resolve(import.meta.dir, "../dist");
    const created: string[] = [];
    let createdDir = false;
    if (!existsSync(distDir)) {
      mkdirSync(distDir, { recursive: true });
      createdDir = true;
    }
    for (const name of ["index.html", "review.html"]) {
      const file = resolve(distDir, name);
      if (!existsSync(file)) {
        writeFileSync(file, "<!doctype html>");
        created.push(file);
      }
    }
    try {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        resolve(import.meta.dir, "index.ts"),
        "annotatte",
        "README.md",
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => proc.kill(), 15_000);
    const [stderr, code] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);

    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command: annotatte");
    expect(stderr).toContain("plannotator annotate");
    } finally {
      for (const file of created) rmSync(file, { force: true });
      if (createdDir) rmSync(distDir, { recursive: true, force: true });
    }
  }, 30_000);
});
