import { describe, expect, spyOn, test } from "bun:test";
import { submitPRReview } from "./pr-provider";
import type { PRRuntime } from "./pr-types";

const REF = { platform: "gitlab" as const, host: "gitlab.com", projectPath: "g/p", iid: 1 };
const MR = "projects/g%2Fp/merge_requests/1";

function fakeGlab(refuse: { files?: string[]; note?: boolean } = {}) {
  const posts: Array<{ endpoint: string; payload: { body: string; position?: Record<string, unknown> } }> = [];
  const runtime: PRRuntime = {
    async runCommand(_command, args) {
      if (args[1] === MR) return { stdout: JSON.stringify({ diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" } }), stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "not found", exitCode: 1 };
    },
    async runCommandWithInput(_command, args, input) {
      const endpoint = args[1] ?? "";
      const payload = JSON.parse(input);
      const refused = (endpoint.endsWith("/notes") && refuse.note) || (endpoint.endsWith("/discussions") && refuse.files?.includes(payload.position?.new_path));
      if (refused) return { stdout: "", stderr: "HTTP 400", exitCode: 1 };
      posts.push({ endpoint, payload });
      return { stdout: "{}", stderr: "", exitCode: 0 };
    },
  };
  return { runtime, posts };
}

describe("GitLab file comments", () => {
  test("each goes as its own file discussion; one GitLab refuses rides the note", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    const { runtime, posts } = fakeGlab({ files: ["old.md"] });
    const result = await submitPRReview(runtime, REF, "head", "comment", "Overall fine.", [], [
      { path: "src/app.ts", body: "Split this file." },
      { path: "old.md", body: "Drop this." },
    ]);
    quiet.mockRestore();
    expect(result).toEqual({ status: "complete" });
    expect(posts).toEqual([
      {
        endpoint: `${MR}/discussions`,
        payload: { body: "Split this file.", position: { position_type: "file", base_sha: "base", start_sha: "start", head_sha: "head", new_path: "src/app.ts", old_path: "src/app.ts" } },
      },
      { endpoint: `${MR}/notes`, payload: { body: "Overall fine.\n\n**old.md:** Drop this." } },
    ]);
  });

  test("a note that fails after a file thread went is owed by the retry, never the thread again", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    const { runtime } = fakeGlab({ note: true });
    const result = await submitPRReview(runtime, REF, "head", "approve", "Ship it.", [], [{ path: "src/app.ts", body: "Nice split." }]);
    quiet.mockRestore();
    expect(result).toMatchObject({ status: "partial", reviewBodyPosted: false, approval: "succeeded", retry: { action: "comment", fileComments: [], body: "Ship it." } });
  });
});
