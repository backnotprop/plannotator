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
