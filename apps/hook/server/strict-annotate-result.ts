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
  nothingToSend?: boolean;
  annotations?: unknown[];
}

export const STRICT_GATE_ERROR_EXIT_CODE = 2;

export interface StrictAnnotateFlags {
  requireApproval: boolean;
  resultFile?: string;
}

export function isStrictAnnotateInvocation(
  flags: StrictAnnotateFlags,
): boolean {
  return flags.requireApproval || !!flags.resultFile;
}

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
