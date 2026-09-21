import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { handleAnnotateCommand, handleAnnotateLastCommand, handleReviewCommand } from "./commands";
import { OpenCodePromptDeliveryError } from "./prompt-delivery-error";

// Inject the annotate-server stub through CommandDeps rather than
// `mock.module`. Bun's module mocks are process-global and cannot be unset,
// so a `mock.module("@plannotator/server/annotate", ...)` here would leak the
// stub into every other suite (it previously broke packages/server tests that
// boot the real annotate server). Dependency injection keeps it local.
const startAnnotateServerMock = mock(async (_options: any) => ({
  port: 0,
  url: "http://localhost",
  isRemote: false,
  waitForDecision: async () => ({ feedback: "", annotations: [] }),
  stop: () => {},
}));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "plannotator-opencode-commands-"));
  tempDirs.push(dir);
  return dir;
}

function makeDeps() {
  return {
    client: {
      app: {
        log: mock((_entry: unknown) => {}),
      },
      session: {
        prompt: mock(async (_input: unknown) => {}),
        messages: mock(async (_input: unknown) => ({ data: [] })),
      },
    },
    htmlContent: "<html></html>",
    reviewHtmlContent: "<html></html>",
    getSharingEnabled: async () => true,
    getShareBaseUrl: () => "https://share.example.test",
    getPasteApiUrl: () => "https://paste.example.test",
    directory: undefined as string | undefined,
    startAnnotateServer: startAnnotateServerMock,
  };
}

afterEach(() => {
  startAnnotateServerMock.mockClear();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

function initGitRepo(): string {
  const repoDir = makeTempDir();
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["branch", "-M", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repoDir, "README.md"), "# repo\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "initial"]);
  return repoDir;
}

describe("handleReviewCommand open state (--base / --diff-type)", () => {
  const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  });

  test("forwards the flag base into the diff AND the server options", async () => {
    // Failure caught: a base computed into the patch but not into the server
    // payload (or vice versa) — a mixed-base review; plus the explicit/pinned
    // bits being dropped on the OpenCode embedded path.
    process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
    const repoDir = initGitRepo();
    git(repoDir, ["checkout", "-q", "-b", "develop"]);
    writeFileSync(path.join(repoDir, "develop.txt"), "develop\n");
    git(repoDir, ["add", "develop.txt"]);
    git(repoDir, ["commit", "-q", "-m", "develop"]);
    git(repoDir, ["checkout", "-q", "-b", "feature/x"]);

    const deps: any = makeDeps();
    deps.directory = repoDir;
    const startReviewServerMock = mock(async (_options: any) => ({
      port: 0,
      url: "http://localhost",
      isRemote: false,
      waitForDecision: async () => ({ approved: false, feedback: "", annotations: [], exit: true }),
      stop: () => {},
    }));
    deps.startReviewServer = startReviewServerMock;

    await handleReviewCommand(
      { properties: { arguments: "--base develop", sessionID: "session-123" } },
      deps,
    );

    expect(startReviewServerMock).toHaveBeenCalledTimes(1);
    const options = startReviewServerMock.mock.calls[0]?.[0];
    expect(options.initialBase).toBe("develop");
    expect(options.initialBaseExplicit).toBe(true);
    expect(options.openStatePinned).toBe(true);
    // The empty-config default (since-base) is base-relative, so the seed
    // requests it explicitly rather than promoting.
    expect(options.diffType).toBe("since-base");
  });

  test("a base that does not resolve refuses to start a session", async () => {
    // Failure caught: the probe being skipped on this host, letting a typo'd
    // base open a mislabelled merge-base→HEAD diff.
    process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
    const repoDir = initGitRepo();
    const deps: any = makeDeps();
    deps.directory = repoDir;
    const startReviewServerMock = mock(async (_options: any) => {
      throw new Error("must not be reached");
    });
    deps.startReviewServer = startReviewServerMock;

    await handleReviewCommand(
      { properties: { arguments: "--base nope-missing", sessionID: "session-123" } },
      deps,
    );

    expect(startReviewServerMock).not.toHaveBeenCalled();
    const logged = deps.client.app.log.mock.calls.map((c: any[]) => c[0]?.message ?? "").join("\n");
    expect(logged).toContain("Base ref not found: nope-missing");
  });
});

describe("handleAnnotateCommand", () => {
  test("advertises approval notes only when an OpenCode session is available", async () => {
    const projectRoot = makeTempDir();
    const filePath = path.join(projectRoot, "plan.md");
    writeFileSync(filePath, "# Plan\n");

    const withSession = makeDeps();
    withSession.directory = projectRoot;
    await handleAnnotateCommand(
      { properties: { arguments: "plan.md --gate", sessionID: "session-123" } },
      withSession,
    );
    expect(startAnnotateServerMock.mock.calls[0]?.[0].approvalNotesSupported).toBe(true);

    startAnnotateServerMock.mockClear();
    const withoutSession = makeDeps();
    withoutSession.directory = projectRoot;
    await handleAnnotateCommand(
      { properties: { arguments: "plan.md --gate" } },
      withoutSession,
    );
    expect(startAnnotateServerMock.mock.calls[0]?.[0].approvalNotesSupported).toBe(false);
  });

  test("injects approved feedback as non-blocking notes with file context", async () => {
    const projectRoot = makeTempDir();
    const filePath = path.join(projectRoot, "plan.md");
    writeFileSync(filePath, "# Plan\n");
    const deps: any = makeDeps();
    deps.directory = projectRoot;
    deps.startAnnotateServer = mock(async (options: any) => ({
      port: 0,
      url: "http://localhost",
      isRemote: false,
      options,
      waitForDecision: async () => ({
        approved: true,
        feedback: "Keep the retry bounded.",
        annotations: [{ id: "a1" }],
      }),
      stop: () => {},
    }));

    await handleAnnotateCommand(
      { properties: { arguments: "plan.md --gate", sessionID: "session-123" } },
      deps,
    );

    expect(deps.client.session.prompt).toHaveBeenCalledTimes(1);
    const prompt = deps.client.session.prompt.mock.calls[0]?.[0].body.parts[0].text;
    expect(prompt).toContain("artifact is approved");
    expect(prompt).toContain("non-blocking guidance");
    expect(prompt).toContain(`File: ${filePath}`);
    expect(prompt).toContain("Keep the retry bounded.");
    expect(prompt).not.toContain("Please address");
  });

  test("logs and rejects when approved file notes cannot be injected", async () => {
    const projectRoot = makeTempDir();
    const filePath = path.join(projectRoot, "plan.md");
    writeFileSync(filePath, "# Plan\n");
    const deps: any = makeDeps();
    deps.directory = projectRoot;
    deps.client.session.prompt = mock(async () => {
      throw new Error("session busy");
    });
    deps.startAnnotateServer = mock(async () => ({
      port: 0,
      url: "http://localhost",
      isRemote: false,
      waitForDecision: async () => ({
        approved: true,
        feedback: "Keep the retry bounded.",
        annotations: [{ id: "a1" }],
      }),
      stop: () => {},
    }));

    try {
      await handleAnnotateCommand(
        { properties: { arguments: "plan.md --gate", sessionID: "session-123" } },
        deps,
      );
      throw new Error("Expected prompt delivery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodePromptDeliveryError);
      expect(error).toHaveProperty(
        "message",
        "Could not deliver approved annotation notes to the OpenCode session.",
      );
    }
    expect(deps.client.app.log).toHaveBeenCalledWith({
      level: "error",
      message: expect.stringContaining("Could not deliver approved annotation notes"),
    });
  });

  test("strips wrapping quotes from HTML paths and forwards pasteApiUrl", async () => {
    const projectRoot = makeTempDir();
    const docsDir = path.join(projectRoot, "docs");
    mkdirSync(docsDir, { recursive: true });
    const htmlPath = path.join(docsDir, "Design Spec.html");
    writeFileSync(htmlPath, "<h1>Design Spec</h1><p>Body</p>");

    const deps = makeDeps();
    deps.directory = projectRoot;

    await handleAnnotateCommand(
      { properties: { arguments: "\"docs/Design Spec.html\"" } },
      deps,
    );

    expect(startAnnotateServerMock).toHaveBeenCalledTimes(1);
    const options = startAnnotateServerMock.mock.calls[0]?.[0];
    expect(options.filePath).toBe(htmlPath);
    expect(options.mode).toBe("annotate");
    expect(options.pasteApiUrl).toBe("https://paste.example.test");
    expect(options.shareBaseUrl).toBe("https://share.example.test");
    expect(options.markdown).toBe("");
    expect(options.rawHtml).toContain("<h1>Design Spec</h1>");
    expect(options.renderHtml).toBe(true);
    expect(options.convertHtml).toBe(false);
    expect(options.sourceConverted).toBe(false);
  });

  test("--markdown converts HTML paths via Turndown", async () => {
    const projectRoot = makeTempDir();
    const docsDir = path.join(projectRoot, "docs");
    mkdirSync(docsDir, { recursive: true });
    const htmlPath = path.join(docsDir, "Design Spec.html");
    writeFileSync(htmlPath, "<h1>Design Spec</h1><p>Body</p>");

    const deps = makeDeps();
    deps.directory = projectRoot;

    await handleAnnotateCommand(
      { properties: { arguments: "\"docs/Design Spec.html\" --markdown" } },
      deps,
    );

    expect(startAnnotateServerMock).toHaveBeenCalledTimes(1);
    const options = startAnnotateServerMock.mock.calls[0]?.[0];
    expect(options.filePath).toBe(htmlPath);
    expect(options.markdown).toContain("# Design Spec");
    expect(options.rawHtml).toBeUndefined();
    expect(options.renderHtml).toBe(false);
    expect(options.convertHtml).toBe(true);
    expect(options.sourceConverted).toBe(true);
  });

  test("supports quoted folder paths and opens annotate-folder mode", async () => {
    const projectRoot = makeTempDir();
    const folderPath = path.join(projectRoot, "docs", "Specs Folder");
    mkdirSync(folderPath, { recursive: true });
    writeFileSync(path.join(folderPath, "plan.md"), "# Plan\n");

    const deps = makeDeps();
    deps.directory = projectRoot;

    await handleAnnotateCommand(
      { properties: { arguments: "\"docs/Specs Folder\"" } },
      deps,
    );

    expect(startAnnotateServerMock).toHaveBeenCalledTimes(1);
    const options = startAnnotateServerMock.mock.calls[0]?.[0];
    expect(options.filePath).toBe(folderPath);
    expect(options.folderPath).toBe(folderPath);
    expect(options.mode).toBe("annotate-folder");
    expect(options.pasteApiUrl).toBe("https://paste.example.test");
    expect(options.markdown).toBe("");
  });
});

describe("handleAnnotateLastCommand", () => {
  test("returns approved feedback and advertises support for an active session", async () => {
    const deps: any = makeDeps();
    deps.client.session.messages = mock(async (_input: unknown) => ({
      data: [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Latest assistant message" }],
        },
      ],
    }));
    deps.startAnnotateServer = mock(async (options: any) => ({
      port: 0,
      url: "http://localhost",
      isRemote: false,
      options,
      waitForDecision: async () => ({
        approved: true,
        feedback: "Retain this caveat.",
        annotations: [{ id: "a1" }],
      }),
      stop: () => {},
    }));

    const outcome = await handleAnnotateLastCommand(
      { properties: { sessionID: "session-123", arguments: "--gate" } },
      deps,
    );

    expect(deps.startAnnotateServer.mock.calls[0]?.[0].approvalNotesSupported).toBe(true);
    expect(outcome).toEqual({
      approved: true,
      feedback: "Retain this caveat.",
    });
  });

  test("forwards pasteApiUrl for annotate-last sessions", async () => {
    const deps = makeDeps();
    deps.client.session.messages = mock(async (_input: unknown) => ({
      data: [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Latest assistant message" }],
        },
      ],
    }));

    await handleAnnotateLastCommand(
      { properties: { sessionID: "session-123" } },
      deps,
    );

    expect(startAnnotateServerMock).toHaveBeenCalledTimes(1);
    const options = startAnnotateServerMock.mock.calls[0]?.[0];
    expect(options.mode).toBe("annotate-last");
    expect(options.filePath).toBe("last-message");
    expect(options.pasteApiUrl).toBe("https://paste.example.test");
    expect(options.markdown).toBe("Latest assistant message");
  });
});
