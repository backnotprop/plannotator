import { afterEach, describe, expect, test } from "bun:test";
import {
  link,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  annotateOutcomeExitCode,
  annotateStartupFailureExitCode,
  assertResultPathAvailable,
  resolveResultFilePath,
  serializeStrictAnnotateResult,
  STRICT_GATE_ERROR_EXIT_CODE,
  writeAnnotateResultFile,
} from "./strict-annotate-result";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "plannotator-result-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("strict annotate result serialization", () => {
  test("serializes approval without feedback", () => {
    expect(
      serializeStrictAnnotateResult({ approved: true, feedback: "" }),
    ).toBe('{"decision":"approved"}');
  });

  test("serializes approval with feedback", () => {
    expect(
      serializeStrictAnnotateResult({
        approved: true,
        feedback: "Keep the cache bounded.",
      }),
    ).toBe(
      '{"decision":"approved","feedback":"Keep the cache bounded."}',
    );
  });

  test("serializes annotated and dismissed decisions", () => {
    expect(
      serializeStrictAnnotateResult({
        approved: false,
        exit: false,
        feedback: "revise",
      }),
    ).toBe('{"decision":"annotated","feedback":"revise"}');
    expect(
      serializeStrictAnnotateResult({ exit: true, feedback: "" }),
    ).toBe('{"decision":"dismissed"}');
  });
});

describe("strict annotate exit policy", () => {
  test("requires approval when requested", () => {
    expect(
      annotateOutcomeExitCode(
        { approved: false, exit: false, feedback: "revise" },
        true,
      ),
    ).toBe(1);
    expect(
      annotateOutcomeExitCode({ approved: true, feedback: "" }, true),
    ).toBe(0);
  });

  test("keeps legacy outcomes successful", () => {
    expect(
      annotateOutcomeExitCode({ exit: true, feedback: "" }, false),
    ).toBe(0);
  });

  test("reserves exit 2 for gate errors, distinct from decision outcomes", () => {
    // grep convention: 0 = approved, 1 = negative human outcome,
    // 2 = the gate itself was misconfigured or could not start.
    expect(STRICT_GATE_ERROR_EXIT_CODE).toBe(2);
    expect(
      annotateOutcomeExitCode({ exit: true, feedback: "" }, true),
    ).toBe(1);
  });
});

describe("annotate startup failure exit codes", () => {
  test("keeps legacy startup failures on exit 1", () => {
    expect(
      annotateStartupFailureExitCode({ requireApproval: false }),
    ).toBe(1);
    expect(
      annotateStartupFailureExitCode({
        requireApproval: false,
        resultFile: undefined,
      }),
    ).toBe(1);
  });

  test("routes strict startup failures to the gate error code", () => {
    // A mistyped path is a configuration error, not "the reviewer requested
    // changes" — exit 1 would make automation misread it as a rejection.
    expect(
      annotateStartupFailureExitCode({ requireApproval: true }),
    ).toBe(STRICT_GATE_ERROR_EXIT_CODE);
    expect(
      annotateStartupFailureExitCode({
        requireApproval: false,
        resultFile: "/tmp/result.json",
      }),
    ).toBe(STRICT_GATE_ERROR_EXIT_CODE);
    expect(
      annotateStartupFailureExitCode({
        requireApproval: true,
        resultFile: "/tmp/result.json",
      }),
    ).toBe(STRICT_GATE_ERROR_EXIT_CODE);
  });

  test("routes every annotate startup failure through the shared helper", () => {
    // The annotate startup path must not reach a bare `process.exit(1)`: each
    // of the six failure classes (missing path, unreachable URL, empty folder,
    // ambiguous name, missing/unsupported file, oversized file) has to pick
    // its code from the parsed strict options. The failure classes live in
    // annotate-resolution.ts, which returns them instead of exiting; index.ts
    // maps every returned failure onto the helper.
    const source = readFileSync(
      join(import.meta.dir, "index.ts"),
      "utf8",
    );
    const start = source.indexOf('} else if (args[0] === "annotate") {');
    const end = source.indexOf(
      '} else if (args[0] === "annotate-last" || args[0] === "last") {',
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const annotateStartupBlock = source.slice(start, end);
    // No bare exit(1) anywhere in the annotate startup path — that code is the
    // reviewer-requested-changes signal once a strict flag is in play. (The
    // tolerant handoff's `process.exit(0)` is fine: exit 0 is never a strict
    // outcome and the handoff is gated off strict invocations.)
    expect(annotateStartupBlock).not.toContain("process.exit(1)");
    // The tolerance gate must be the NEGATED strict predicate: an inverted
    // gate (tolerance in strict mode) cannot be spawn-tested without starting
    // a server, so pin the source shape here.
    expect(annotateStartupBlock).toContain("!strictAnnotate");
    expect(annotateStartupBlock).toContain("isStrictAnnotateInvocation(");
    // The usage failure and every resolution failure route through the helper
    // that reads the strict flags.
    for (const failure of [
      "Usage: plannotator annotate",
      "resolution.message",
    ]) {
      const site = annotateStartupBlock.indexOf(failure);
      expect(site).toBeGreaterThan(-1);
      expect(
        annotateStartupBlock
          .slice(0, site)
          .lastIndexOf("exitAnnotateStartupFailure("),
      ).toBeGreaterThan(
        annotateStartupBlock.slice(0, site).lastIndexOf("console.error("),
      );
    }

    // The extracted resolution pipeline returns failures instead of exiting;
    // every failure class must be present there and none may exit directly.
    const resolutionSource = readFileSync(
      join(import.meta.dir, "annotate-resolution.ts"),
      "utf8",
    );
    expect(resolutionSource).not.toContain("process.exit");
    for (const failure of [
      "Failed to fetch URL:",
      "No annotatable files",
      "Ambiguous filename",
      "File type not supported:",
      "File not found:",
      "File too large to annotate",
    ]) {
      expect(resolutionSource).toContain(failure);
    }
  });
});

describe("atomic annotate result publication", () => {
  test("resolves relative result paths from the invocation directory", () => {
    expect(
      resolveResultFilePath("results/review.json", "/workspace/project"),
    ).toBe("/workspace/project/results/review.json");
    expect(
      resolveResultFilePath("/var/tmp/review.json", "/workspace/project"),
    ).toBe("/var/tmp/review.json");
  });

  test("publishes one complete private newline-terminated record", async () => {
    const directory = await makeTemporaryDirectory();
    const resultFile = join(directory, "result.json");

    await assertResultPathAvailable(resultFile);
    await writeAnnotateResultFile(
      resultFile,
      '{"decision":"approved"}',
    );

    expect(await readFile(resultFile, "utf8")).toBe(
      '{"decision":"approved"}\n',
    );
    if (process.platform !== "win32") {
      expect((await stat(resultFile)).mode & 0o077).toBe(0);
    }
    expect(await readdir(directory)).toEqual(["result.json"]);
  });

  test("rejects a missing parent and an existing destination", async () => {
    const directory = await makeTemporaryDirectory();
    const missingParentResult = join(directory, "missing", "result.json");
    const existingResult = join(directory, "existing.json");
    await writeFile(existingResult, "existing", "utf8");

    await expect(
      assertResultPathAvailable(missingParentResult),
    ).rejects.toThrow(
      `Result file parent does not exist: ${join(directory, "missing")}`,
    );
    await expect(
      assertResultPathAvailable(existingResult),
    ).rejects.toThrow(`Result file already exists: ${existingResult}`);
    expect(await readdir(directory)).toEqual(["existing.json"]);
  });

  test.skipIf(process.platform === "win32")(
    "rejects a dangling destination symlink before startup",
    async () => {
      const directory = await makeTemporaryDirectory();
      const resultFile = join(directory, "result.json");
      await symlink(join(directory, "missing-target"), resultFile);

      await expect(
        assertResultPathAvailable(resultFile),
      ).rejects.toThrow(`Result file already exists: ${resultFile}`);
    },
  );

  test("never overwrites a destination created after validation", async () => {
    const directory = await makeTemporaryDirectory();
    const resultFile = join(directory, "result.json");
    await assertResultPathAvailable(resultFile);
    await writeFile(resultFile, "raced", { mode: 0o600 });

    await expect(
      writeAnnotateResultFile(
        resultFile,
        '{"decision":"approved"}',
      ),
    ).rejects.toThrow();

    expect(await readFile(resultFile, "utf8")).toBe("raced");
    expect(await readdir(directory)).toEqual(["result.json"]);
  });

  test("removes the temporary file when writing fails", async () => {
    const directory = await makeTemporaryDirectory();
    const resultFile = join(directory, "result.json");

    await expect(
      writeAnnotateResultFile(
        resultFile,
        '{"decision":"approved"}',
        {
          open,
          link,
          unlink,
          write: async () => {
            throw new Error("write failed");
          },
        },
      ),
    ).rejects.toThrow("write failed");

    expect(await readdir(directory)).toEqual([]);
  });

  test("fails closed when hard-link publication is unavailable", async () => {
    const directory = await makeTemporaryDirectory();
    const resultFile = join(directory, "result.json");

    await expect(
      writeAnnotateResultFile(
        resultFile,
        '{"decision":"approved"}',
        {
          open,
          link: async () => {
            throw new Error("hard links unavailable");
          },
          unlink,
          write: (handle, contents) => handle.writeFile(contents, "utf8"),
        },
      ),
    ).rejects.toThrow("hard links unavailable");

    expect(await readdir(directory)).toEqual([]);
  });
});
