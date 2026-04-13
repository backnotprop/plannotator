import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitContext, runGitDiff, startReviewServer } from "./server";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalPort = process.env.PLANNOTATOR_PORT;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function initRepo(): string {
  const repoDir = makeTempDir("plannotator-pi-review-");
  git(repoDir, ["init"]);
  git(repoDir, ["branch", "-M", "main"]);
  git(repoDir, ["config", "user.email", "pi-review@example.com"]);
  git(repoDir, ["config", "user.name", "Pi Review"]);

  writeFileSync(join(repoDir, "tracked.txt"), "before\n", "utf-8");
  git(repoDir, ["add", "tracked.txt"]);
  git(repoDir, ["commit", "-m", "initial"]);

  return repoDir;
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve test port"));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalPort === undefined) {
    delete process.env.PLANNOTATOR_PORT;
  } else {
    process.env.PLANNOTATOR_PORT = originalPort;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("pi review server", () => {
  test("serves review diff parity endpoints including drafts, uploads, and editor annotations", async () => {
    const homeDir = makeTempDir("plannotator-pi-home-");
    const repoDir = initRepo();
    process.env.HOME = homeDir;
    process.chdir(repoDir);
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
    writeFileSync(join(repoDir, "untracked.txt"), "brand new\n", "utf-8");

    const gitContext = await getGitContext();
    const diff = await runGitDiff("uncommitted", gitContext.defaultBranch);

    const server = await startReviewServer({
      rawPatch: diff.patch,
      gitRef: diff.label,
      error: diff.error,
      diffType: "uncommitted",
      gitContext,
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const diffResponse = await fetch(`${server.url}/api/diff`);
      expect(diffResponse.status).toBe(200);
      const diffPayload = await diffResponse.json() as {
        rawPatch: string;
        gitContext?: { diffOptions: Array<{ id: string }> };
        origin?: string;
        repoInfo?: { display: string };
      };
      expect(diffPayload.origin).toBe("pi");
      expect(diffPayload.rawPatch).toContain("diff --git a/untracked.txt b/untracked.txt");
      expect(diffPayload.gitContext?.diffOptions.map((option) => option.id)).toEqual(
        expect.arrayContaining(["uncommitted", "staged", "unstaged", "last-commit"]),
      );
      expect(diffPayload.repoInfo?.display).toBeTruthy();

      const fileContentResponse = await fetch(`${server.url}/api/file-content?path=tracked.txt`);
      const fileContent = await fileContentResponse.json() as {
        oldContent: string | null;
        newContent: string | null;
      };
      expect(fileContent.oldContent).toBe("before\n");
      expect(fileContent.newContent).toBe("after\n");

      const draftBody = { annotations: [{ id: "draft-1" }] };
      const draftSave = await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftBody),
      });
      expect(draftSave.status).toBe(200);

      const draftLoad = await fetch(`${server.url}/api/draft`);
      expect(draftLoad.status).toBe(200);
      expect(await draftLoad.json()).toEqual(draftBody);

      const annotationCreate = await fetch(`${server.url}/api/editor-annotation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: "tracked.txt",
          selectedText: "after",
          lineStart: 1,
          lineEnd: 1,
          comment: "Check wording",
        }),
      });
      expect(annotationCreate.status).toBe(200);
      const createdAnnotation = await annotationCreate.json() as { id: string };
      expect(createdAnnotation.id).toBeTruthy();

      const annotationsList = await fetch(`${server.url}/api/editor-annotations`);
      const annotationsPayload = await annotationsList.json() as { annotations: Array<{ id: string }> };
      expect(annotationsPayload.annotations).toHaveLength(1);
      expect(annotationsPayload.annotations[0].id).toBe(createdAnnotation.id);

      const annotationDelete = await fetch(
        `${server.url}/api/editor-annotation?id=${encodeURIComponent(createdAnnotation.id)}`,
        { method: "DELETE" },
      );
      expect(annotationDelete.status).toBe(200);

      const agentsResponse = await fetch(`${server.url}/api/agents`);
      expect(await agentsResponse.json()).toEqual({ agents: [] });

      const formData = new FormData();
      formData.append("file", new File(["png-bytes"], "diagram.png", { type: "image/png" }));
      const uploadResponse = await fetch(`${server.url}/api/upload`, {
        method: "POST",
        body: formData,
      });
      expect(uploadResponse.status).toBe(200);
      const uploadPayload = await uploadResponse.json() as { path: string; originalName: string };
      expect(uploadPayload.originalName).toBe("diagram.png");

      const imageResponse = await fetch(
        `${server.url}/api/image?path=${encodeURIComponent(uploadPayload.path)}`,
      );
      expect(imageResponse.status).toBe(200);
      expect(await imageResponse.text()).toBe("png-bytes");

      const draftDelete = await fetch(`${server.url}/api/draft`, { method: "DELETE" });
      expect(draftDelete.status).toBe(200);

      const draftMissing = await fetch(`${server.url}/api/draft`);
      expect(draftMissing.status).toBe(404);

      const feedbackResponse = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approved: false,
          feedback: "Please update the diff",
          annotations: [{ id: "note-1" }],
        }),
      });
      expect(feedbackResponse.status).toBe(200);

      await expect(server.waitForDecision()).resolves.toEqual({
        approved: false,
        feedback: "Please update the diff",
        annotations: [{ id: "note-1" }],
        agentSwitch: undefined,
      });
    } finally {
      server.stop();
    }
  });

  test("exit endpoint resolves decision with exit flag", async () => {
    const homeDir = makeTempDir("plannotator-pi-home-");
    const repoDir = initRepo();
    process.env.HOME = homeDir;
    process.chdir(repoDir);
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    const gitContext = await getGitContext();
    const diff = await runGitDiff("uncommitted", gitContext.defaultBranch);

    const server = await startReviewServer({
      rawPatch: diff.patch,
      gitRef: diff.label,
      error: diff.error,
      diffType: "uncommitted",
      gitContext,
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const exitResponse = await fetch(`${server.url}/api/exit`, { method: "POST" });
      expect(exitResponse.status).toBe(200);
      expect(await exitResponse.json()).toEqual({ ok: true });

      await expect(server.waitForDecision()).resolves.toEqual({
        exit: true,
        approved: false,
        feedback: "",
        annotations: [],
        agentSwitch: undefined,
      });
    } finally {
      server.stop();
    }
  });

  test("git-add endpoint stages and unstages files in review mode", async () => {
    const homeDir = makeTempDir("plannotator-pi-home-");
    const repoDir = initRepo();
    process.env.HOME = homeDir;
    process.chdir(repoDir);
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    writeFileSync(join(repoDir, "stage-me.txt"), "new file\n", "utf-8");

    const gitContext = await getGitContext();
    const diff = await runGitDiff("uncommitted", gitContext.defaultBranch);

    const server = await startReviewServer({
      rawPatch: diff.patch,
      gitRef: diff.label,
      error: diff.error,
      diffType: "uncommitted",
      gitContext,
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const stageResponse = await fetch(`${server.url}/api/git-add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "stage-me.txt" }),
      });
      expect(stageResponse.status).toBe(200);
      expect(git(repoDir, ["diff", "--staged", "--name-only"])).toContain("stage-me.txt");

      const unstageResponse = await fetch(`${server.url}/api/git-add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "stage-me.txt", undo: true }),
      });
      expect(unstageResponse.status).toBe(200);
      expect(git(repoDir, ["diff", "--staged", "--name-only"])).not.toContain("stage-me.txt");
      expect(git(repoDir, ["status", "--short"])).toContain("?? stage-me.txt");

      await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approved: true,
          feedback: "LGTM - no changes requested.",
          annotations: [],
        }),
      });
      await server.waitForDecision();
    } finally {
      server.stop();
    }
  }, 15_000);
});
