import { existsSync, lstatSync, statSync } from "node:fs";
import {
  link,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

export interface AnnotateOutcome {
  feedback: string;
  exit?: boolean;
  approved?: boolean;
}

/**
 * Exit code for gate errors, following the grep convention:
 * `0` = approved, `1` = negative human outcome (annotated/dismissed under
 * `--require-approval`), `2` = the gate itself was misconfigured, could not
 * start, or could not publish its result file (usage, startup, validation, and
 * publication failures). Exit `2` never reports a reviewer outcome; when the
 * decision itself completed, the stdout record is still emitted before exiting.
 */
export const STRICT_GATE_ERROR_EXIT_CODE = 2;

export interface StrictAnnotateFlags {
  requireApproval: boolean;
  resultFile?: string;
}

/**
 * True when the invocation carries a strict flag (`--require-approval` /
 * `--result-file`, neither of which the CLI accepts without `--gate --json`).
 *
 * Strict invocations own the exit-code contract below, which is why tolerant
 * annotate argument resolution is bypassed for them: quietly annotating a
 * later argument because the first one was a typo would let a gate publish
 * "approved" for a document the caller never named. A typo must keep exiting
 * 2 here. This predicate is the single definition both the exit-code path
 * and the tolerance bypass read, so the two can never drift.
 */
export function isStrictAnnotateInvocation(
  flags: StrictAnnotateFlags,
): boolean {
  return flags.requireApproval || !!flags.resultFile;
}

/**
 * Exit code for an annotate startup failure (missing path, unreachable URL,
 * empty folder, ambiguous name, missing file, oversized file).
 *
 * Legacy invocations keep exiting `1`. Under a strict flag, `1` is reserved for
 * "the reviewer did not approve", so a startup failure must exit with the gate
 * error code instead — otherwise automation reads a typo'd path as a rejection.
 */
export function annotateStartupFailureExitCode(
  strict: StrictAnnotateFlags,
): number {
  return isStrictAnnotateInvocation(strict) ? STRICT_GATE_ERROR_EXIT_CODE : 1;
}

export function serializeStrictAnnotateResult(
  result: AnnotateOutcome,
): string {
  if (result.approved) {
    return JSON.stringify({
      decision: "approved",
      ...(result.feedback ? { feedback: result.feedback } : {}),
    });
  }
  if (result.exit) return JSON.stringify({ decision: "dismissed" });
  return JSON.stringify({
    decision: "annotated",
    feedback: result.feedback || "",
  });
}

export function annotateOutcomeExitCode(
  result: AnnotateOutcome,
  requireApproval: boolean,
): number {
  return requireApproval && !result.approved ? 1 : 0;
}

export function resolveResultFilePath(
  resultFile: string,
  invocationCwd: string,
): string {
  return resolve(invocationCwd, resultFile);
}

export async function assertResultPathAvailable(
  resultFile: string,
): Promise<void> {
  let destinationExists = existsSync(resultFile);
  if (!destinationExists) {
    try {
      lstatSync(resultFile);
      destinationExists = true;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  if (destinationExists) {
    throw new Error(`Result file already exists: ${resultFile}`);
  }
  const parent = dirname(resultFile);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error(`Result file parent does not exist: ${parent}`);
  }
}

interface ResultFileOperations {
  open: typeof open;
  link: typeof link;
  unlink: typeof unlink;
  write: (handle: FileHandle, contents: string) => Promise<unknown>;
}

const defaultResultFileOperations: ResultFileOperations = {
  open,
  link,
  unlink,
  write: (handle, contents) => handle.writeFile(contents, "utf8"),
};

export async function writeAnnotateResultFile(
  resultFile: string,
  serialized: string,
  operations: ResultFileOperations = defaultResultFileOperations,
): Promise<void> {
  const temporary = join(
    dirname(resultFile),
    `.${basename(resultFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | null = null;
  try {
    handle = await operations.open(temporary, "wx", 0o600);
    await operations.write(handle, `${serialized}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await operations.link(temporary, resultFile);
    await operations.unlink(temporary);
  } catch (error) {
    await handle?.close().catch(() => {});
    await operations.unlink(temporary).catch(() => {});
    throw error;
  }
}
