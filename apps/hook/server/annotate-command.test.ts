import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeAnnotateCommand } from "./annotate-command";
import type { AnnotateOutcome } from "./strict-annotate-result";

interface RunResult {
  events: string[];
  stdout: string[];
  resultBytes: string[];
  legacy: AnnotateOutcome[];
}

async function runCompletion(
  outcome: AnnotateOutcome,
  options: {
    requireApproval?: boolean;
    resultFile?: string;
    resultWriter?: (path: string, serialized: string) => Promise<void>;
  } = {},
): Promise<RunResult> {
  const events: string[] = [];
  const stdout: string[] = [];
  const resultBytes: string[] = [];
  const legacy: AnnotateOutcome[] = [];

  await completeAnnotateCommand({
    waitForDecision: async () => {
      events.push("decision");
      return outcome;
    },
    settleAfterDecision: async () => {
      events.push("settle");
    },
    stopServer: () => {
      events.push("stop");
    },
    requireApproval: options.requireApproval ?? false,
    resultFile: options.resultFile,
    writeResultFile:
      options.resultWriter ??
      (async (_path, serialized) => {
        events.push("result");
        resultBytes.push(`${serialized}\n`);
      }),
    writeStdout: async (bytes) => {
      events.push("stdout");
      stdout.push(bytes);
    },
    emitLegacyOutcome: (result) => {
      events.push("legacy");
      legacy.push(result);
    },
    exit: (code) => {
      events.push(`exit:${code}`);
    },
  });

  return { events, stdout, resultBytes, legacy };
}

describe("completeAnnotateCommand", () => {
  test("publishes approved feedback to matching stdout and result bytes", async () => {
    const result = await runCompletion(
      {
        approved: true,
        feedback: "Keep the cache bounded.",
      },
      {
        requireApproval: true,
        resultFile: "/result.json",
      },
    );

    const expected =
      '{"decision":"approved","feedback":"Keep the cache bounded."}\n';
    expect(result.resultBytes).toEqual([expected]);
    expect(result.stdout).toEqual([expected]);
    expect(result.events).toEqual([
      "decision",
      "settle",
      "stop",
      "stdout",
      "result",
      "exit:0",
    ]);
  });

  test("publishes annotated and dismissed decisions before nonzero exit", async () => {
    const annotated = await runCompletion(
      { approved: false, exit: false, feedback: "revise" },
      { requireApproval: true, resultFile: "/annotated.json" },
    );
    const dismissed = await runCompletion(
      { exit: true, feedback: "" },
      { requireApproval: true, resultFile: "/dismissed.json" },
    );

    expect(annotated.stdout).toEqual([
      '{"decision":"annotated","feedback":"revise"}\n',
    ]);
    expect(annotated.resultBytes).toEqual(annotated.stdout);
    expect(annotated.events.slice(-3)).toEqual([
      "stdout",
      "result",
      "exit:1",
    ]);
    expect(dismissed.stdout).toEqual([
      '{"decision":"dismissed"}\n',
    ]);
    expect(dismissed.resultBytes).toEqual(dismissed.stdout);
    expect(dismissed.events.slice(-3)).toEqual([
      "stdout",
      "result",
      "exit:1",
    ]);
  });

  test("delegates legacy output unchanged and exits zero", async () => {
    const outcome = { exit: false, feedback: "legacy feedback" };
    const result = await runCompletion(outcome);

    expect(result.legacy).toEqual([outcome]);
    expect(result.stdout).toEqual([]);
    expect(result.resultBytes).toEqual([]);
    expect(result.events.slice(-2)).toEqual(["legacy", "exit:0"]);
  });

  test("supports each strict option independently", async () => {
    const resultFileOnly = await runCompletion(
      { approved: false, feedback: "revise" },
      { resultFile: "/result.json" },
    );
    const approvalOnly = await runCompletion(
      { exit: true, feedback: "" },
      { requireApproval: true },
    );

    expect(resultFileOnly.events.slice(-3)).toEqual([
      "stdout",
      "result",
      "exit:0",
    ]);
    expect(resultFileOnly.resultBytes).toEqual(resultFileOnly.stdout);
    expect(approvalOnly.events.slice(-2)).toEqual(["stdout", "exit:1"]);
    expect(approvalOnly.resultBytes).toEqual([]);
  });

  test("emits the decision on stdout before exiting 2 on publication failure", async () => {
    const events: string[] = [];
    const errors: string[] = [];
    const stdout: string[] = [];

    await completeAnnotateCommand({
      waitForDecision: async () => ({
        approved: false,
        feedback: "revise",
      }),
      settleAfterDecision: async () => {},
      stopServer: () => {},
      requireApproval: true,
      resultFile: "/raced.json",
      writeResultFile: async () => {
        events.push("result");
        throw new Error("destination appeared");
      },
      writeStdout: async (bytes) => {
        events.push("stdout");
        stdout.push(bytes);
      },
      emitLegacyOutcome: () => {
        events.push("legacy");
      },
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      logError: (message) => {
        errors.push(message);
      },
    });

    // The reviewer's draft is already deleted by the time publication runs, so
    // the completed decision must reach stdout before the failure aborts the
    // run. Exit 2 still means "the result file was not published" — an
    // environment error, never a reviewer outcome and never approval.
    expect(events).toEqual(["stdout", "result", "exit:2"]);
    expect(stdout).toEqual(['{"decision":"annotated","feedback":"revise"}\n']);
    expect(errors).toEqual(["destination appeared"]);
  });

  test("exits 2 without publishing a result file when stdout fails first", async () => {
    const events: string[] = [];
    const errors: string[] = [];

    await completeAnnotateCommand({
      waitForDecision: async () => ({ approved: true, feedback: "" }),
      settleAfterDecision: async () => {},
      stopServer: () => {},
      requireApproval: true,
      resultFile: "/unreachable.json",
      writeResultFile: async () => {
        events.push("result");
      },
      writeStdout: async () => {
        events.push("stdout");
        throw new Error("stdout closed");
      },
      emitLegacyOutcome: () => {
        events.push("legacy");
      },
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      logError: (message) => {
        errors.push(message);
      },
    });

    // Only a stdout failure leaves no decision record anywhere.
    expect(events).toEqual(["stdout", "exit:2"]);
    expect(errors).toEqual(["stdout closed"]);
  });

  test("exits 2 when the stdout record cannot be written", async () => {
    const events: string[] = [];
    const errors: string[] = [];

    await completeAnnotateCommand({
      waitForDecision: async () => ({
        approved: true,
        feedback: "",
      }),
      settleAfterDecision: async () => {},
      stopServer: () => {},
      requireApproval: true,
      writeResultFile: async () => {
        events.push("result");
      },
      writeStdout: async () => {
        events.push("stdout");
        throw new Error("stdout closed");
      },
      emitLegacyOutcome: () => {
        events.push("legacy");
      },
      exit: (code) => {
        events.push(`exit:${code}`);
      },
      logError: (message) => {
        errors.push(message);
      },
    });

    expect(events).toEqual(["stdout", "exit:2"]);
    expect(errors).toEqual(["stdout closed"]);
  });

  test("emits stdout and exits 2 when the real publisher cannot write the destination", async () => {
    // Real publisher, real filesystem: a destination whose parent directory does
    // not exist is the cheap stand-in for the filesystems where publication
    // fails outright (no hard links on exFAT/FAT32/SMB, read-only mounts).
    const directory = await mkdtemp(join(tmpdir(), "plannotator-publish-"));
    const stdout: string[] = [];
    const errors: string[] = [];
    const codes: number[] = [];

    try {
      await completeAnnotateCommand({
        waitForDecision: async () => ({
          approved: false,
          exit: false,
          feedback: "needs another pass",
        }),
        settleAfterDecision: async () => {},
        stopServer: () => {},
        requireApproval: true,
        resultFile: join(directory, "missing", "result.json"),
        writeStdout: async (bytes) => {
          stdout.push(bytes);
        },
        emitLegacyOutcome: () => {
          throw new Error("legacy output must not run in strict mode");
        },
        exit: (code) => {
          codes.push(code);
        },
        logError: (message) => {
          errors.push(message);
        },
      });

      // The decision survives even though nothing was published.
      expect(stdout).toEqual([
        '{"decision":"annotated","feedback":"needs another pass"}\n',
      ]);
      expect(codes).toEqual([2]);
      expect(errors).toHaveLength(1);
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
