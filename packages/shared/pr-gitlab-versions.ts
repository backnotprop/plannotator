import type { PRRuntime } from "./pr-types";
import type { GitLabDiffEntry } from "./pr-gitlab";
import { parsePaginatedArray } from "./cli-pagination";

interface GlMRAt {
  host: string;
  projectPath: string;
  iid: number;
}

interface GlMRVersion {
  id: number;
  head_commit_sha?: string | null;
  base_commit_sha?: string | null;
  start_commit_sha?: string | null;
}

export interface GlVersionAt {
  baseSha: string;
  startSha: string;
  diffs: GitLabDiffEntry[] | null;
}

export const glVersionsEndpoint = (ref: GlMRAt) => `projects/${encodeURIComponent(ref.projectPath)}/merge_requests/${ref.iid}/versions`;

export function glVersionOf(stdout: string, sha: string): GlMRVersion | null {
  const wanted = sha.toLowerCase();
  return parsePaginatedArray<GlMRVersion>(stdout).find((version) => version.head_commit_sha?.toLowerCase() === wanted) ?? null;
}

const apiArgs = (host: string, endpoint: string, extra: string[] = []) => ["api", endpoint, ...extra, ...(host !== "gitlab.com" ? ["--hostname", host] : [])];

export async function readGlVersionAt(runtime: PRRuntime, ref: GlMRAt, sha: string): Promise<GlVersionAt | null> {
  try {
    const list = await runtime.runCommand("glab", apiArgs(ref.host, `${glVersionsEndpoint(ref)}?per_page=100`, ["--paginate"]));
    if (list.exitCode !== 0) return null;
    const version = glVersionOf(list.stdout, sha);
    if (!version?.base_commit_sha || !version.start_commit_sha) return null;
    const read = await runtime.runCommand("glab", apiArgs(ref.host, `${glVersionsEndpoint(ref)}/${version.id}`)).catch(() => null);
    let diffs: GitLabDiffEntry[] | null = null;
    if (read && read.exitCode === 0) {
      try {
        const answer = JSON.parse(read.stdout) as { diffs?: unknown };
        diffs = Array.isArray(answer.diffs) ? (answer.diffs as GitLabDiffEntry[]) : null;
      } catch {
        diffs = null;
      }
    }
    return { baseSha: version.base_commit_sha, startSha: version.start_commit_sha, diffs };
  } catch {
    return null;
  }
}
