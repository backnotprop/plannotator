import type { PRRuntime, PRReviewFileLevelComment } from "./pr-types";

type GlApiArgs = (endpoint: string, extra?: string[]) => string[];

interface GlDiffRefs {
  base_sha: string;
  start_sha: string;
}

const POST_JSON = ["--method", "POST", "--input", "-", "-H", "Content-Type:application/json"];

async function readDiffRefs(runtime: PRRuntime, api: GlApiArgs, mrEndpoint: string): Promise<GlDiffRefs | null> {
  try {
    const result = await runtime.runCommand("glab", api(mrEndpoint));
    if (result.exitCode !== 0) return null;
    const refs = (JSON.parse(result.stdout) as { diff_refs?: Partial<GlDiffRefs> | null }).diff_refs;
    return typeof refs?.base_sha === "string" && typeof refs.start_sha === "string" ? { base_sha: refs.base_sha, start_sha: refs.start_sha } : null;
  } catch {
    return null;
  }
}

export async function postGlFileThreads(
  runtime: PRRuntime,
  api: GlApiArgs,
  mrEndpoint: string,
  headSha: string,
  comments: PRReviewFileLevelComment[],
): Promise<{ posted: number; folded: PRReviewFileLevelComment[] }> {
  const run = runtime.runCommandWithInput?.bind(runtime);
  if (comments.length === 0 || !run) return { posted: 0, folded: comments };
  const refs = await readDiffRefs(runtime, api, mrEndpoint);
  if (!refs) return { posted: 0, folded: comments };
  const folded: PRReviewFileLevelComment[] = [];
  for (const comment of comments) {
    const position = { position_type: "file", base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: headSha, new_path: comment.path, old_path: comment.path };
    const result = await run("glab", api(`${mrEndpoint}/discussions`, POST_JSON), JSON.stringify({ body: comment.body, position })).catch(() => null);
    if (result?.exitCode === 0) continue;
    console.error(`[plannotator] file comment on ${comment.path} could not be posted as a file thread on GitLab; posting it in the review body`);
    folded.push(comment);
  }
  return { posted: comments.length - folded.length, folded };
}
