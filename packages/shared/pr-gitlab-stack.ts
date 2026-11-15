import { apiArgs, encodeProject } from "./pr-gitlab";
import type { GitlabMRRef, PRListItem, PRMetadata, PRRuntime, PRStackNode, PRStackTree } from "./pr-types";

interface GlMRSummary {
  iid: number;
  title: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  state: string;
  author?: { username?: string } | null;
}

const STACK_MAX_DEPTH = 10;

function listState(state: string): PRListItem["state"] {
  if (state === "merged") return "merged";
  if (state === "opened" || state === "locked") return "open";
  return "closed";
}

async function queryMRs(runtime: PRRuntime, ref: GitlabMRRef, query: string): Promise<GlMRSummary[]> {
  const endpoint = `projects/${encodeProject(ref.projectPath)}/merge_requests?${query}`;
  const result = await runtime.runCommand("glab", apiArgs(ref.host, endpoint));
  if (result.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function stackMR(
  runtime: PRRuntime,
  ref: GitlabMRRef,
  side: "source_branch" | "target_branch",
  branch: string,
): Promise<GlMRSummary | undefined> {
  const mrs = (await queryMRs(runtime, ref, `${side}=${encodeURIComponent(branch)}&state=all&per_page=20`))
    .filter((mr) => mr.state === "opened" || mr.state === "merged");
  return mrs.find((mr) => mr.state === "opened") ?? mrs[0];
}

function stackNode(mr: GlMRSummary): PRStackNode {
  return {
    branch: mr.source_branch,
    number: mr.iid,
    title: mr.title,
    url: mr.web_url,
    isCurrent: false,
    isDefaultBranch: false,
    state: listState(mr.state),
  };
}

export async function fetchGlMRStack(runtime: PRRuntime, ref: GitlabMRRef, metadata: PRMetadata): Promise<PRStackTree | null> {
  if (metadata.platform !== "gitlab") return null;
  const defaultBranch = metadata.defaultBranch;
  if (!defaultBranch) return null;

  const ancestors: PRStackNode[] = [];
  let nextSource = metadata.baseBranch;
  for (let i = 0; i < STACK_MAX_DEPTH && nextSource !== defaultBranch; i++) {
    const mr = await stackMR(runtime, ref, "source_branch", nextSource);
    if (!mr) {
      ancestors.push({ branch: nextSource, isCurrent: false, isDefaultBranch: false });
      break;
    }
    ancestors.push(stackNode(mr));
    nextSource = mr.target_branch;
  }

  const descendants: PRStackNode[] = [];
  let nextTarget = metadata.headBranch;
  for (let i = 0; i < STACK_MAX_DEPTH; i++) {
    const mr = await stackMR(runtime, ref, "target_branch", nextTarget);
    if (!mr) break;
    descendants.push(stackNode(mr));
    nextTarget = mr.source_branch;
  }

  return {
    nodes: [
      { branch: defaultBranch, isCurrent: false, isDefaultBranch: true },
      ...ancestors.reverse(),
      {
        branch: metadata.headBranch,
        number: metadata.iid,
        title: metadata.title,
        url: metadata.url,
        isCurrent: true,
        isDefaultBranch: false,
      },
      ...descendants,
    ],
  };
}

export async function fetchGlMRList(runtime: PRRuntime, ref: GitlabMRRef): Promise<PRListItem[]> {
  const mrs = await queryMRs(runtime, ref, "state=all&order_by=updated_at&sort=desc&per_page=30");
  return mrs.map((mr) => ({
    id: String(mr.iid),
    number: mr.iid,
    title: mr.title,
    author: mr.author?.username ?? "",
    url: mr.web_url,
    baseBranch: mr.target_branch,
    state: listState(mr.state),
  }));
}
