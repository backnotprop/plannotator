import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
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
  // realpath: macOS tmpdir is a symlink, and git reports the resolved toplevel.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "plannotator-opencode-commands-")));
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
      tui: {
        showToast: mock((_input: any) => {}),
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

function initGitRepo(name?: string): string {
  const root = makeTempDir();
  const repoDir = name ? path.join(root, name) : root;
  if (name) mkdirSync(repoDir);
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

  test("a directory selects another repo while feedback stays in the invoking session", async () => {
    // Catch cwd leakage on the embedded path and delivery into the wrong session.
    process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
    const caller = initGitRepo("caller");
    const target = initGitRepo("target");
    mkdirSync(path.join(target, "src"));
    const hostCwd = process.cwd();
    writeFileSync(path.join(caller, "caller.ts"), "caller-only\n");
    writeFileSync(path.join(target, "target.ts"), "target-only\n");
    const deps = {
      ...makeDeps(),
      directory: caller,
      startReviewServer: mock(async (_options: any) => ({
        port: 0, url: "http://localhost", isRemote: false,
        waitForDecision: async () => ({ feedback: "Please check target.ts.", annotations: [], reviewDirectory: path.join(target, "switched-worktree") }),
        stop: () => {},
      })),
    };
    await handleReviewCommand({ properties: { arguments: JSON.stringify(path.relative(caller, path.join(target, "src"))), sessionID: "original-session" } }, deps as any);
    const options = deps.startReviewServer.mock.calls[0]?.[0];
    expect(options.rawPatch).toContain("target-only");
    expect(options.rawPatch).not.toContain("caller-only");
    expect(options.gitContext.cwd).toBe(target);
    expect(options.project).toBe(path.basename(target));
    expect(options.includeReviewDirectory).toBe(true);
    const prompt = deps.client.session.prompt.mock.calls[0]?.[0] as any;
    expect(prompt.path.id).toBe("original-session");
    expect(prompt.body.parts[0].text).toContain(`Review directory: ${path.join(target, "switched-worktree")}`);
    expect(process.cwd()).toBe(hostCwd);

    deps.startReviewServer.mockClear();
    await handleReviewCommand({ properties: { arguments: "./missing-directory", sessionID: "original-session" } }, deps as any);
    expect(deps.startReviewServer).not.toHaveBeenCalled();
    expect(deps.client.app.log.mock.calls.map((call: any[]) => call[0].message).join("\n")).toContain("does not exist");
    // app.log never reaches the TUI, so the refusal must also be toasted.
    expect(deps.client.tui.showToast.mock.calls.map((call: any[]) => call[0].body.message).join("\n")).toContain("does not exist");

    // Prose that names no directory keeps the pre-directory behavior (#1483):
    // the invoking repo is reviewed and the ignored words are reported.
    await handleReviewCommand({ properties: { arguments: "please review my changes", sessionID: "original-session" } }, deps as any);
    const proseOptions = deps.startReviewServer.mock.calls[0]?.[0];
    expect(proseOptions.rawPatch).toContain("caller-only");
    expect(proseOptions.includeReviewDirectory).toBe(false);
    expect(deps.client.app.log.mock.calls.map((call: any[]) => call[0].message).join("\n")).toContain("please review my changes");
  });

  test("path-shaped prose among several words reviews the invoking repo (v0.27.23 regression)", async () => {
    process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
    const caller = initGitRepo("caller");
    writeFileSync(path.join(caller, "caller.ts"), "caller-only\n");
    const deps = {
      ...makeDeps(),
      directory: caller,
      startReviewServer: mock(async (_options: any) => ({
        port: 0, url: "http://localhost", isRemote: false,
        waitForDecision: async () => ({ feedback: "", annotations: [] }),
        stop: () => {},
      })),
    };
    await handleReviewCommand({ properties: { arguments: "look at the api/users code", sessionID: "s" } }, deps as any);
    const options = deps.startReviewServer.mock.calls[0]?.[0];
    expect(options.rawPatch).toContain("caller-only");
    expect(options.includeReviewDirectory).toBe(false);
    expect(deps.client.tui.showToast).not.toHaveBeenCalled();
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

// #1612, embedded runtime: feedback is answered by the agent that wrote the
// annotated message (or, for a file, the agent the user is talking to), not by
// OpenCode's default agent.
describe("annotate feedback agent routing (embedded runtime)", () => {
  const MESSAGES = [
    { info: { role: "user", id: "u1", agent: "agent-engineer" }, parts: [{ type: "text", text: "q" }] },
    { info: { role: "assistant", id: "a1", agent: "agent-engineer" }, parts: [{ type: "text", text: "Engineer answer" }] },
    { info: { role: "user", id: "u2", agent: "build" }, parts: [{ type: "text", text: "q2" }] },
    { info: { role: "assistant", id: "a2", agent: "build" }, parts: [{ type: "text", text: "Build answer" }] },
  ];

  function routingDeps(messages: unknown[], decision: Record<string, unknown>) {
    const deps: any = makeDeps();
    deps.client.session.messages = mock(async (_input: unknown) => ({ data: messages }));
    deps.client.app.agents = mock(async (_input?: unknown) => ({
      data: [{ name: "build", mode: "primary" }, { name: "agent-engineer", mode: "primary" }],
    }));
    deps.startAnnotateServer = mock(async (options: any) => ({
      port: 0,
      url: "http://localhost",
      isRemote: false,
      options,
      waitForDecision: async () => ({ annotations: [{ id: "x" }], ...decision }),
      stop: () => {},
    }));
    return deps;
  }

  test("/plannotator-last returns the picked message's agent", async () => {
    const deps = routingDeps(MESSAGES, { feedback: "Tighten this.", selectedMessageId: "a1" });

    const outcome = await handleAnnotateLastCommand({ properties: { sessionID: "session-123" } }, deps);

    expect(outcome?.agent).toBe("agent-engineer");
  });

  test("/plannotator-last with no recorded writer returns no agent", async () => {
    const deps = routingDeps(
      MESSAGES.map((m) => ({ ...m, info: { ...m.info, agent: undefined } })),
      { feedback: "Tighten this.", selectedMessageId: "a1" },
    );

    const outcome = await handleAnnotateLastCommand({ properties: { sessionID: "session-123" } }, deps);

    expect(outcome).not.toBeNull();
    expect("agent" in outcome!).toBe(false);
  });

  test("/plannotator-annotate names the session's current agent", async () => {
    const projectRoot = makeTempDir();
    writeFileSync(path.join(projectRoot, "plan.md"), "# Plan\n");
    const deps = routingDeps(MESSAGES.slice(0, 2), { feedback: "Rename section 2." });
    deps.directory = projectRoot;

    await handleAnnotateCommand({ properties: { arguments: "plan.md", sessionID: "session-123" } }, deps);

    expect(deps.client.session.prompt.mock.calls[0]?.[0].body.agent).toBe("agent-engineer");
  });
});
