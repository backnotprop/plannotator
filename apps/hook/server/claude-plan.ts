/**
 * Claude Code Plan Resolver
 *
 * Claude Code fills ExitPlanMode's `plan` from the plan file when it records
 * the assistant message, before any of that message's tools run. When the
 * model edits the plan file and calls ExitPlanMode in the same message, the
 * inline `plan` is the version from before the edit, so the review would show
 * the plan the user already rejected. By the time the PermissionRequest hook
 * fires, the edit has landed, so the file at `planFilePath` is current.
 * (Claude Code 2.1.285 fixed this on its side; older versions still need it.)
 *
 * The file is read only when it passes the same gate `readPlanFile`
 * (`@plannotator/shared/doc-resolve`) applies before trusting a plan file: an
 * absolute `.md` path naming a regular file no larger than the annotate cap.
 * That keeps a FIFO, device or directory from hanging the hook and a huge
 * file from being read into memory, and it means a plan read from the file
 * always passes that later trust check (its contents equal the plan).
 *
 * Fallback: the inline `plan`, for hosts that send no path or when the file
 * fails the gate, cannot be read, or is empty.
 */

import { readFileSync, statSync } from "node:fs";
import { MAX_ANNOTATABLE_FILE_BYTES } from "@plannotator/shared/annotatable";
import { isAbsoluteUserPath, resolveUserPath } from "@plannotator/shared/resolve-file";

interface ClaudePlanToolInput {
  plan?: unknown;
  planFilePath?: unknown;
}

export function resolveClaudePlan(toolInput: ClaudePlanToolInput | undefined): string {
  const inlinePlan = typeof toolInput?.plan === "string" ? toolInput.plan : "";
  const planFilePath = toolInput?.planFilePath;
  if (typeof planFilePath !== "string" || !planFilePath) return inlinePlan;
  if (!isAbsoluteUserPath(planFilePath) || !/\.md$/i.test(planFilePath)) return inlinePlan;

  try {
    const path = resolveUserPath(planFilePath);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_ANNOTATABLE_FILE_BYTES) return inlinePlan;
    return readFileSync(path, "utf8") || inlinePlan;
  } catch {
    return inlinePlan;
  }
}
