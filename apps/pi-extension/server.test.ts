import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canStageFiles,
  getGitContext,
  getVcsContext,
  getVcsFileContentsForDiff,
  prepareLocalReviewDiff,
  runGitDiff,
  runVcsDiff,
  stageFile,
  startAnnotateServer,
  startPlanReviewServer,
  startReviewServer,
  unstageFile,
} from "./server";
import { WorkspaceReviewSession } from "./generated/review-workspace.js";
import { warmFileListCache } from "./generated/resolve-file.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalPort = process.env.PLANNOTATOR_PORT;
const originalSemPath = process.env.PLANNOTATOR_SEM_PATH;
const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalFileBrowserLimit = process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeTempFile(root: string, relativePath: string, content = "x"): string {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf-8");
  return full;
}

interface PiTreeNode {
  path: string;
  type: "file" | "folder";
  children?: PiTreeNode[];
}

function flattenTree(nodes: PiTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === "file") paths.push(node.path);
    else paths.push(...flattenTree(node.children ?? []));
  }
  return paths;
}

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: childEnv() });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function hasJj(): boolean {
  return spawnSync("jj", ["--version"], { encoding: "utf-8", env: childEnv() }).status === 0;
}

function jj(cwd: string, args: string[]): string {
  const result = spawnSync("jj", ["-R", cwd, ...args], { encoding: "utf-8", env: childEnv() });
  if (result.status !== 0) {
    throw new Error(result.stderr || `jj ${args.join(" ")} failed`);
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

function makeMockSem(dir: string, options: {
  runCwdLogPath?: string;
  inputLogPath?: string;
} = {}): string {
  const semPath = join(dir, "sem");
  writeFileSync(
    semPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "--version" ]; then',
      '  echo "sem 0.8.0"',
      "  exit 0",
      "fi",
      ...(options.runCwdLogPath ? [`pwd >> ${JSON.stringify(options.runCwdLogPath)}`] : []),
      ...(options.inputLogPath ? [`cat > ${JSON.stringify(options.inputLogPath)}`] : ["cat >/dev/null"]),
      "cat <<'JSON'",
      JSON.stringify({
        summary: { fileCount: 1, added: 1, modified: 0, deleted: 0, moved: 0, renamed: 0, reordered: 0, binary: 0, orphan: 0, total: 1 },
        changes: [
          {
            entityId: "src/app.ts::function::created",
            changeType: "added",
            entityType: "function",
            entityName: "created",
            filePath: "src/app.ts",
            startLine: 1,
            endLine: 3,
          },
        ],
        binaryChanges: [],
      }),
      "JSON",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(semPath, 0o755);
  return semPath;
}

function initJjRepo(): string {
  const repoDir = initRepo();
  writeFileSync(join(repoDir, "spacey.ts"), "const x = 1;\n", "utf-8");
  git(repoDir, ["add", "spacey.ts"]);
  git(repoDir, ["commit", "-m", "add spacey file"]);

  const init = spawnSync("jj", ["git", "init", "--colocate", repoDir], { encoding: "utf-8", env: childEnv() });
  if (init.status !== 0) {
    throw new Error(init.stderr || "jj git init --colocate failed");
  }
  jj(repoDir, ["config", "set", "--repo", "user.name", "Pi Review"]);
  jj(repoDir, ["config", "set", "--repo", "user.email", "pi-review@example.com"]);

  writeFileSync(join(repoDir, "last.txt"), "last\n", "utf-8");
  jj(repoDir, ["commit", "-m", "add last change"]);

  writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
  writeFileSync(join(repoDir, "spacey.ts"), "const  x = 1;\n", "utf-8");

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
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalPort === undefined) {
    delete process.env.PLANNOTATOR_PORT;
  } else {
    process.env.PLANNOTATOR_PORT = originalPort;
  }
  if (originalSemPath === undefined) {
    delete process.env.PLANNOTATOR_SEM_PATH;
  } else {
    process.env.PLANNOTATOR_SEM_PATH = originalSemPath;
  }
  if (originalDataDir === undefined) {
    delete process.env.PLANNOTATOR_DATA_DIR;
  } else {
    process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  }
  if (originalFileBrowserLimit === undefined) {
    delete process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
  } else {
    process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = originalFileBrowserLimit;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function observePiWarmState(projectRoot: string): Promise<"ready" | "warm"> {
  const warm = warmFileListCache(projectRoot, "code").then(() => "warm" as const);
  const ready = new Promise<"ready">((resolve) => {
    queueMicrotask(() => resolve("ready"));
  });
  return Promise.race([warm, ready]);
}

async function expectPiReadyBeforeWarm(
  start: () => Promise<{ url: string; stop(): void }>,
): Promise<void> {
  const projectRoot = makeTempDir("plannotator-pi-startup-warm-");
  const dataRoot = makeTempDir("plannotator-pi-startup-data-");
  writeTempFile(projectRoot, "document.md", "# Test\n");
  writeTempFile(projectRoot, "source.ts", "export {};\n");
  process.chdir(projectRoot);
  process.env.PLANNOTATOR_DATA_DIR = dataRoot;
  process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = "1";
  process.env.PLANNOTATOR_PORT = String(await reservePort());

  const server = await start();
  try {
    expect(await observePiWarmState(process.cwd())).toBe("ready");
    const response = await fetch(`${server.url}/api/plan`);
    expect(response.status).toBe(200);
  } finally {
    server.stop();
  }
}

describe("pi startup file-cache warm", () => {
  test("plan server binds before its cache warm can settle", async () => {
    await expectPiReadyBeforeWarm(() =>
      startPlanReviewServer({
        plan: "# Test plan",
        origin: "pi",
        htmlContent: "<!doctype html><html><body>plan</body></html>",
      }),
    );
  });

  test("annotate server binds before its cache warm can settle", async () => {
    await expectPiReadyBeforeWarm(() =>
      startAnnotateServer({
        markdown: "# Test document",
        filePath: join(process.cwd(), "document.md"),
        htmlContent: "<!doctype html><html><body>annotate</body></html>",
        origin: "pi",
      }),
    );
  });
});

describe("pi review server", () => {
  const testIfJj = hasJj() ? test : test.skip;
  const semanticRawPatch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/src/app.ts",
    "@@ -0,0 +1,3 @@",
    "+export function created() {",
    "+  return true;",
    "+}",
    "",
  ].join("\n");

  test("advertises semantic diff availability and serves parsed sem output", async () => {
    const dir = makeTempDir("plannotator-pi-sem-server-");
    const dataDir = makeTempDir("plannotator-pi-sem-data-");
    const cwdLogPath = join(dir, "cwd-log");
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    process.env.PLANNOTATOR_SEM_PATH = makeMockSem(dir, { runCwdLogPath: cwdLogPath });
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    const server = await startReviewServer({
      rawPatch: semanticRawPatch,
      gitRef: "test",
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const diffPayload = await fetch(`${server.url}/api/diff`).then((response) => response.json()) as {
        semanticDiff?: { available: boolean; semVersion?: string; semSource?: string };
      };
      expect(diffPayload.semanticDiff).toMatchObject({
        available: true,
        semVersion: "0.8.0",
        semSource: "env",
      });

      const semanticPayload = await fetch(`${server.url}/api/semantic-diff?fileExt=.ts`).then((response) => response.json()) as {
        status: string;
        summary?: { added: number; fileCount: number };
        changes?: Array<{ entityType: string; entityName: string; filePath: string }>;
      };
      expect(semanticPayload).toMatchObject({
        status: "ok",
        summary: { added: 1, fileCount: 1 },
        changes: [
          { entityType: "function", entityName: "created", filePath: "src/app.ts" },
        ],
      });
      expect(realpathSync(readFileSync(cwdLogPath, "utf-8").trim())).toBe(
        realpathSync(join(dataDir, "semantic-diff", "patch-only")),
      );
    } finally {
      server.stop();
    }
  });

  test("runs semantic diff from the local agent cwd when one is available", async () => {
    const dir = makeTempDir("plannotator-pi-sem-agent-");
    const agentCwd = makeTempDir("plannotator-pi-sem-agent-cwd-");
    const cwdLogPath = join(dir, "cwd-log");
    process.env.PLANNOTATOR_SEM_PATH = makeMockSem(dir, { runCwdLogPath: cwdLogPath });
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    const server = await startReviewServer({
      rawPatch: semanticRawPatch,
      gitRef: "test",
      origin: "pi",
      agentCwd,
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const semanticPayload = await fetch(`${server.url}/api/semantic-diff`).then((response) => response.json()) as {
        status: string;
      };
      expect(semanticPayload.status).toBe("ok");
      expect(realpathSync(readFileSync(cwdLogPath, "utf-8").trim())).toBe(realpathSync(agentCwd));
    } finally {
      server.stop();
    }
  });

  test("runs semantic diff from the local git context cwd in local review mode", async () => {
    const dir = makeTempDir("plannotator-pi-sem-local-");
    const repoDir = initRepo();
    const cwdLogPath = join(dir, "cwd-log");
    const gitContext = await getVcsContext(repoDir);
    process.env.PLANNOTATOR_SEM_PATH = makeMockSem(dir, { runCwdLogPath: cwdLogPath });
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    const server = await startReviewServer({
      rawPatch: semanticRawPatch,
      gitRef: "test",
      origin: "pi",
      diffType: "unstaged",
      gitContext,
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const semanticPayload = await fetch(`${server.url}/api/semantic-diff`).then((response) => response.json()) as {
        status: string;
      };
      expect(semanticPayload.status).toBe("ok");
      expect(realpathSync(readFileSync(cwdLogPath, "utf-8").trim())).toBe(realpathSync(repoDir));
    } finally {
      server.stop();
    }
  });

  test("hides semantic diff from /api/diff when sem cannot be resolved", async () => {
    const dir = makeTempDir("plannotator-pi-sem-missing-server-");
    process.env.PLANNOTATOR_SEM_PATH = join(dir, "missing-sem");
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    const server = await startReviewServer({
      rawPatch: semanticRawPatch,
      gitRef: "test",
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const diffPayload = await fetch(`${server.url}/api/diff`).then((response) => response.json()) as {
        semanticDiff?: { available: boolean };
      };
      expect(diffPayload.semanticDiff).toEqual({ available: false });

      const semanticPayload = await fetch(`${server.url}/api/semantic-diff`).then((response) => response.json()) as {
        status: string;
        reason?: string;
      };
      expect(semanticPayload).toMatchObject({
        status: "unavailable",
        reason: "sem-path-missing",
      });
    } finally {
      server.stop();
    }
  });

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

      const generatedDraft = { codeAnnotations: [{ id: "stale-draft" }], draftGeneration: 5 };
      const generatedDraftSave = await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generatedDraft),
      });
      expect(generatedDraftSave.status).toBe(200);

      const feedbackResponse = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draftGeneration: 5,
          approved: false,
          feedback: "Please update the diff",
          annotations: [{ id: "note-1" }],
        }),
      });
      expect(feedbackResponse.status).toBe(200);

      const lateDraftSave = await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(generatedDraft),
      });
      expect(lateDraftSave.status).toBe(200);
      const lateDraftLoad = await fetch(`${server.url}/api/draft`);
      expect(lateDraftLoad.status).toBe(404);
      expect(await lateDraftLoad.json()).toEqual({ found: false, draftGeneration: 5 });

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

  test("workspace mode maps prefixed paths to child repos", async () => {
    const homeDir = makeTempDir("plannotator-pi-home-");
    const root = makeTempDir("plannotator-pi-workspace-");
    const apiDir = join(root, "api");
    const semDir = makeTempDir("plannotator-pi-workspace-switch-sem-");
    const cwdLogPath = join(semDir, "cwd-log");
    const inputLogPath = join(semDir, "input.patch");
    mkdirSync(apiDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.PLANNOTATOR_PORT = String(await reservePort());
    process.env.PLANNOTATOR_SEM_PATH = makeMockSem(semDir, { runCwdLogPath: cwdLogPath, inputLogPath });

    git(apiDir, ["init"]);
    git(apiDir, ["branch", "-M", "main"]);
    git(apiDir, ["config", "user.email", "pi-review@example.com"]);
    git(apiDir, ["config", "user.name", "Pi Review"]);
    writeFileSync(join(apiDir, "tracked.txt"), "before\n", "utf-8");
    git(apiDir, ["add", "tracked.txt"]);
    git(apiDir, ["commit", "-m", "initial"]);
    writeFileSync(join(apiDir, "tracked.txt"), "after\n", "utf-8");

    const workspace = await WorkspaceReviewSession.create({
      getVcsContext,
      runVcsDiff,
      getVcsFileContentsForDiff,
      canStageFiles,
      stageFile,
      unstageFile,
    }, root);

    const server = await startReviewServer({
      rawPatch: workspace.rawPatch,
      gitRef: workspace.gitRef,
      error: workspace.error,
      diffType: workspace.diffType,
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
      workspace,
      agentCwd: root,
    });

    try {
      const diffResponse = await fetch(`${server.url}/api/diff`);
      const diffPayload = await diffResponse.json() as {
        mode?: string;
        agentCwd?: string;
        diffType?: string;
        diffOptions?: Array<{ id: string }>;
        semanticDiff?: { available: boolean };
      };
      expect(diffPayload.mode).toBe("workspace");
      expect(diffPayload.diffType).toBe("workspace-current");
      expect(diffPayload.diffOptions?.map((option) => option.id)).toContain("workspace-last");
      expect(diffPayload.agentCwd).toBe(root);
      expect(diffPayload.semanticDiff).toEqual(expect.objectContaining({ available: true }));
      expect("workspace" in diffPayload).toBe(false);

      const semanticPayload = await fetch(`${server.url}/api/semantic-diff`).then((response) => response.json()) as {
        status: string;
      };
      expect(semanticPayload.status).toBe("ok");
      expect(realpathSync(readFileSync(cwdLogPath, "utf-8").trim())).toBe(realpathSync(root));
      expect(readFileSync(inputLogPath, "utf-8")).toContain("diff --git a/api/tracked.txt b/api/tracked.txt");

      const switchResponse = await fetch(`${server.url}/api/diff/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffType: "workspace-last", hideWhitespace: true }),
      });
      expect(switchResponse.status).toBe(200);
      const switched = await switchResponse.json() as {
        diffType?: string;
        diffOptions?: Array<{ id: string }>;
        semanticDiff?: { available: boolean };
      };
      expect(switched.diffType).toBe("workspace-last");
      expect(switched.diffOptions?.map((option) => option.id)).toContain("workspace-current");
      expect(switched.semanticDiff).toEqual(expect.objectContaining({ available: true }));

      const currentResponse = await fetch(`${server.url}/api/diff/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffType: "workspace-current", hideWhitespace: false }),
      });
      expect(currentResponse.status).toBe(200);

      const fileContentResponse = await fetch(`${server.url}/api/file-content?path=api/tracked.txt`);
      expect(fileContentResponse.status).toBe(200);
      const fileContent = await fileContentResponse.json() as {
        oldContent: string | null;
        newContent: string | null;
      };
      expect(fileContent.oldContent).toBe("before\n");
      expect(fileContent.newContent).toBe("after\n");

      const stageResponse = await fetch(`${server.url}/api/git-add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "api/tracked.txt" }),
      });
      expect(stageResponse.status).toBe(200);
      expect(git(apiDir, ["diff", "--staged", "--name-only"])).toContain("tracked.txt");

      const invalidStageResponse = await fetch(`${server.url}/api/git-add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "api/../tracked.txt" }),
      });
      expect(invalidStageResponse.status).toBe(400);
    } finally {
      server.stop();
    }
  }, 15_000);

  test("round-trips the active base branch through /api/diff and /api/diff/switch", async () => {
    const homeDir = makeTempDir("plannotator-pi-home-");
    const repoDir = initRepo();
    process.env.HOME = homeDir;
    process.chdir(repoDir);
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    // Create a second branch the picker can switch to, then branch off it so
    // currentBranch !== defaultBranch and the branch/merge-base options appear.
    git(repoDir, ["checkout", "-b", "develop"]);
    writeFileSync(join(repoDir, "develop-file.txt"), "develop\n", "utf-8");
    git(repoDir, ["add", "develop-file.txt"]);
    git(repoDir, ["commit", "-m", "develop commit"]);
    git(repoDir, ["checkout", "-b", "feature/x"]);
    writeFileSync(join(repoDir, "feature-file.txt"), "feature\n", "utf-8");
    git(repoDir, ["add", "feature-file.txt"]);
    git(repoDir, ["commit", "-m", "feature commit"]);

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
      // Initial load: server echoes the detected default as the active base.
      const initial = await fetch(`${server.url}/api/diff`).then((r) => r.json()) as {
        base?: string;
        gitContext?: { defaultBranch: string };
      };
      expect(initial.base).toBe(gitContext.defaultBranch);
      expect(initial.base).toBe(initial.gitContext?.defaultBranch);

      // Switch to a custom base — response must echo the resolved base.
      const switchResponse = await fetch(`${server.url}/api/diff/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffType: "branch", base: "develop" }),
      });
      expect(switchResponse.status).toBe(200);
      const switched = await switchResponse.json() as { base?: string; diffType: string };
      expect(switched.base).toBe("develop");
      expect(switched.diffType).toBe("branch");

      const stageWhileOnBranch = await fetch(`${server.url}/api/git-add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "feature-file.txt" }),
      });
      expect(stageWhileOnBranch.status).toBe(400);
      expect(await stageWhileOnBranch.json()).toEqual({ error: "Staging not available" });

      // Subsequent /api/diff load reflects the switched base — this is what
      // survives a page refresh / reconnect.
      const rehydrate = await fetch(`${server.url}/api/diff`).then((r) => r.json()) as {
        base?: string;
      };
      expect(rehydrate.base).toBe("develop");

      // Unknown refs pass through verbatim — the resolver trusts callers so
      // unusual-but-valid refs (tags, SHAs, non-origin remotes) work. Truly
      // invalid refs surface via the diff error, not via a silent swap.
      const unknownResponse = await fetch(`${server.url}/api/diff/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffType: "branch", base: "nope-does-not-exist" }),
      });
      const unknown = await unknownResponse.json() as { base?: string; error?: string };
      expect(unknown.base).toBe("nope-does-not-exist");
      expect(unknown.error).toBeTruthy();

      // Feedback to clean up the waitForDecision promise.
      await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false, feedback: "done", annotations: [] }),
      });
      await server.waitForDecision();
    } finally {
      server.stop();
    }
  }, 15_000);

  test("initialBase overrides gitContext.defaultBranch in server state", async () => {
    // Simulates a programmatic caller (Pi event bus, other extensions) that
    // opens a review against a non-default base. The server's currentBase —
    // which drives /api/diff, agent prompts, and file-content fetches — must
    // honor that override instead of falling back to the detected default.
    const homeDir = makeTempDir("plannotator-pi-home-");
    const repoDir = initRepo();
    process.env.HOME = homeDir;
    process.chdir(repoDir);
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    git(repoDir, ["checkout", "-b", "develop"]);
    writeFileSync(join(repoDir, "develop-file.txt"), "develop\n", "utf-8");
    git(repoDir, ["add", "develop-file.txt"]);
    git(repoDir, ["commit", "-m", "develop commit"]);
    git(repoDir, ["checkout", "-b", "feature/x"]);

    const gitContext = await getGitContext();
    // Detected default is "main"; caller explicitly wants "develop".
    expect(gitContext.defaultBranch).toBe("main");
    const diff = await runGitDiff("branch", "develop");

    const server = await startReviewServer({
      rawPatch: diff.patch,
      gitRef: diff.label,
      error: diff.error,
      diffType: "branch",
      gitContext,
      initialBase: "develop",
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const payload = await fetch(`${server.url}/api/diff`).then((r) => r.json()) as {
        base?: string;
        gitContext?: { defaultBranch: string };
      };
      // The server must echo the caller's override, not the detected default.
      expect(payload.base).toBe("develop");
      expect(payload.gitContext?.defaultBranch).toBe("main");

      await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false, feedback: "done", annotations: [] }),
      });
      await server.waitForDecision();
    } finally {
      server.stop();
    }
  }, 15_000);

  testIfJj("supports JJ local review modes through the Pi server", async () => {
    const homeDir = makeTempDir("plannotator-pi-home-");
    process.env.HOME = homeDir;
    process.env.XDG_CONFIG_HOME = join(homeDir, ".config");
    const repoDir = initJjRepo();
    process.chdir(repoDir);
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    const vcsContext = await getVcsContext(repoDir);
    expect(vcsContext.vcsType).toBe("jj");
    const expectedJjBase = vcsContext.defaultBranch;
    const prepared = await prepareLocalReviewDiff({
      cwd: repoDir,
      requestedDiffType: "merge-base",
      requestedBase: "main",
      configuredDiffType: "unstaged",
    });
    expect(prepared.gitContext.vcsType).toBe("jj");
    expect(prepared.diffType).toBe("jj-current");
    expect(prepared.base).toBe(expectedJjBase);

    const forcedGit = await prepareLocalReviewDiff({
      cwd: repoDir,
      vcsType: "git",
      requestedDiffType: "unstaged",
      configuredDiffType: "unstaged",
    });
    expect(forcedGit.gitContext.vcsType).toBe("git");
    expect(forcedGit.diffType).toBe("unstaged");
    expect(forcedGit.rawPatch).toContain("tracked.txt");

    const forcedGitServer = await startReviewServer({
      rawPatch: forcedGit.rawPatch,
      gitRef: forcedGit.gitRef,
      error: forcedGit.error,
      diffType: forcedGit.diffType,
      gitContext: forcedGit.gitContext,
      initialBase: forcedGit.base,
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });
    try {
      const switchResponse = await fetch(`${forcedGitServer.url}/api/diff/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffType: "merge-base", base: "main" }),
      });
      expect(switchResponse.status).toBe(200);
      const switched = await switchResponse.json() as {
        gitContext?: { vcsType?: string; diffOptions: Array<{ id: string }> };
      };
      expect(switched.gitContext?.vcsType).toBe("git");
      expect(switched.gitContext?.diffOptions.map((option) => option.id)).toContain("merge-base");
      expect(switched.gitContext?.diffOptions.map((option) => option.id)).not.toContain("jj-current");
    } finally {
      forcedGitServer.stop();
    }

    process.env.PLANNOTATOR_PORT = String(await reservePort());
    const server = await startReviewServer({
      rawPatch: prepared.rawPatch,
      gitRef: prepared.gitRef,
      error: prepared.error,
      diffType: prepared.diffType,
      gitContext: prepared.gitContext,
      initialBase: prepared.base,
      origin: "pi",
      htmlContent: "<!doctype html><html><body>review</body></html>",
    });

    try {
      const initial = await fetch(`${server.url}/api/diff`).then((r) => r.json()) as {
        diffType: string;
        rawPatch: string;
        base?: string;
        gitContext?: { vcsType?: string; diffOptions: Array<{ id: string }> };
      };
      expect(initial.diffType).toBe("jj-current");
      expect(initial.base).toBe(expectedJjBase);
      expect(initial.gitContext?.vcsType).toBe("jj");
      const optionIds = initial.gitContext?.diffOptions.map((option) => option.id) ?? [];
      expect(optionIds).toContain("jj-current");
      expect(optionIds).toContain("jj-last");
      expect(optionIds).toContain("jj-line");
      expect(optionIds).toContain("jj-all");
      expect(initial.rawPatch).toContain("tracked.txt");
      expect(initial.rawPatch).toContain("+after");

      const lastResponse = await fetch(`${server.url}/api/diff/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffType: "jj-last" }),
      });
      expect(lastResponse.status).toBe(200);
      const last = await lastResponse.json() as { rawPatch: string; diffType: string };
      expect(last.diffType).toBe("jj-last");
      expect(last.rawPatch).toContain("last.txt");

      for (const nextType of ["jj-line", "jj-all"] as const) {
        const response = await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: nextType }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json() as { diffType: string; rawPatch: string };
        expect(payload.diffType).toBe(nextType);
        expect(payload.rawPatch).toContain("tracked.txt");
      }

      const hideWhitespaceResponse = await fetch(`${server.url}/api/diff/switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ diffType: "jj-current", hideWhitespace: true }),
      });
      expect(hideWhitespaceResponse.status).toBe(200);
      const hidden = await hideWhitespaceResponse.json() as { rawPatch: string };
      expect(hidden.rawPatch).toContain("+after");
      expect(hidden.rawPatch).not.toContain("+const  x = 1;");

      const fileContentResponse = await fetch(`${server.url}/api/file-content?path=tracked.txt`);
      expect(fileContentResponse.status).toBe(200);
      const fileContent = await fileContentResponse.json() as {
        oldContent: string | null;
        newContent: string | null;
      };
      expect(fileContent.oldContent).toBe("before\n");
      expect(fileContent.newContent).toBe("after\n");

      const stageResponse = await fetch(`${server.url}/api/git-add`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath: "tracked.txt" }),
      });
      expect(stageResponse.status).toBe(400);
      expect(await stageResponse.json()).toEqual({ error: "Staging not available" });

      await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, feedback: "LGTM", annotations: [] }),
      });
      await server.waitForDecision();
    } finally {
      server.stop();
    }
  }, 20_000);
});

describe("pi plan archive server", () => {
  test("serves an empty archived plan as a found plan", async () => {
    const archiveDir = makeTempDir("plannotator-pi-archive-");
    const filename = "2026-01-02-empty-approved.md";
    writeFileSync(join(archiveDir, filename), "", "utf-8");
    process.env.PLANNOTATOR_PORT = String(await reservePort());

    const server = await startPlanReviewServer({
      plan: "",
      origin: "pi",
      htmlContent: "<!doctype html><html><body>archive</body></html>",
      mode: "archive",
      customPlanPath: archiveDir,
    });

    try {
      const url = new URL(`${server.url}/api/archive/plan`);
      url.searchParams.set("filename", filename);
      url.searchParams.set("customPath", archiveDir);
      const response = await fetch(url);
      const payload = await response.json() as { markdown?: string; filepath?: string };

      expect(response.status).toBe(200);
      expect(payload.markdown).toBe("");
      expect(payload.filepath).toBe(filename);
    } finally {
      server.stop();
    }
  });
});

describe("pi plan server file browser", () => {
  test("filters excluded folders from tree and workspace status", async () => {
    const repo = makeTempDir("plannotator-pi-files-");
    const dataDir = makeTempDir("plannotator-pi-files-data-");
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    process.env.PLANNOTATOR_PORT = String(await reservePort());
    process.chdir(repo);

    git(repo, ["init"]);
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["config", "user.email", "pi-files@example.com"]);
    git(repo, ["config", "user.name", "Pi Files"]);
    writeTempFile(repo, "docs/visible.md", "visible\n");
    writeTempFile(repo, "dist/generated.md", "before\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "initial"]);

    writeTempFile(repo, "dist/generated.md", "after\n");
    writeTempFile(repo, "packages/app/node_modules/pkg/readme.md", "hidden\n");

    const server = await startPlanReviewServer({
      plan: "# Plan",
      origin: "pi",
      htmlContent: "<!doctype html><html><body>plan</body></html>",
    });

    try {
      const url = new URL(`${server.url}/api/reference/files`);
      url.searchParams.set("dirPath", repo);
      const response = await fetch(url);
      const payload = await response.json() as {
        tree: PiTreeNode[];
        workspaceStatus: { totals: { files: number }; files: Record<string, unknown> };
      };

      expect(response.status).toBe(200);
      expect(flattenTree(payload.tree)).toEqual(["docs/visible.md"]);
      expect(payload.workspaceStatus.totals.files).toBe(0);
      expect(payload.workspaceStatus.files).toEqual({});
    } finally {
      server.stop();
    }
  });
});
