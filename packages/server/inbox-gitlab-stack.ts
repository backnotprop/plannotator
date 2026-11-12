import { diffHunkLines } from "@plannotator/core/diff-files";

export interface GitlabForkProjects {
  source: number;
  target: number;
}

const projectId = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

export function gitlabForkProjects(mergeRequest: Record<string, unknown>): GitlabForkProjects | null {
  const source = projectId(mergeRequest.source_project_id);
  const target = projectId(mergeRequest.target_project_id);
  return source && target && source !== target ? { source, target } : null;
}

export function gitlabCompareEndpoint(project: string, base: string, head: string, fork: GitlabForkProjects | null): string {
  const range = `from=${encodeURIComponent(base)}&to=${encodeURIComponent(head)}`;
  return fork
    ? `projects/${fork.source}/repository/compare?${range}&from_project_id=${fork.target}&straight=false`
    : `projects/${encodeURIComponent(project)}/repository/compare?${range}&straight=false`;
}

export function textsFitPatch(patch: string, oldText: string, newText: string): boolean {
  const hunks = diffHunkLines(patch);
  if (!hunks || hunks.length === 0) return false;
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  return hunks.every((hunk) =>
    hunk.lines.every((line) => (line.kind === "add" || oldLines[line.oldLine - 1] === line.text) && (line.kind === "del" || newLines[line.newLine - 1] === line.text)),
  );
}
