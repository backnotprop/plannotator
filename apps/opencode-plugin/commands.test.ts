import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { handleAnnotateCommand, handleAnnotateLastCommand, handleReviewCommand } from "./commands";
import { OpenCodePromptDeliveryError } from "./prompt-delivery-error";
import { getReviewDeniedSuffix } from "@plannotator/shared/prompts";

const startAnnotateServerMock = mock(async (_options: any) => ({
  port: 0,
  url: "http://localhost",
  isRemote: false,
  waitForDecision: async () => ({ feedback: "", annotations: [] }),
  stop: () => {},
}));

const tempDirs: string[] = [];

function makeTempDir(): string {
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
    expect(options.diffType).toBe("since-base");
  });

  test("a base that does not resolve refuses to start a session", async () => {
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
    expect(deps.client.tui.showToast.mock.calls.map((call: any[]) => call[0].body.message).join("\n")).toContain("does not exist");

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

  test("zero-annotation feedback gets the suffix; the platform status post does not", async () => {
    const previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
    try {
      const caller = initGitRepo("caller");
      writeFileSync(path.join(caller, "caller.ts"), "caller-only\n");
      const runWith = async (decision: Record<string, unknown>) => {
        const deps = {
          ...makeDeps(),
          directory: caller,
          startReviewServer: mock(async (_options: any) => ({
            port: 0, url: "http://localhost", isRemote: false,
            waitForDecision: async () => ({ approved: false, annotations: [], ...decision }),
            stop: () => {},
          })),
        };
        await handleReviewCommand({ properties: { arguments: "", sessionID: "s" } }, deps as any);
        expect(deps.client.session.prompt).toHaveBeenCalledTimes(1);
        return (deps.client.session.prompt.mock.calls[0]?.[0] as any).body.parts[0].text as string;
      };

      const descriptionOnly = await runWith({ feedback: "## PR description\n\nExplain the fallback." });
      expect(descriptionOnly).toContain("Explain the fallback.");
      expect(descriptionOnly).toContain(getReviewDeniedSuffix("opencode"));

      const status = "Pull request reviewed on GitHub: https://github.com/o/r/pull/1";
      expect(await runWith({ feedback: status, platform: true })).toBe(status);
    } finally {
      if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
    }
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

  test("several file paths open one bundle session, and the prompt names every file", async () => {
    const projectRoot = makeTempDir();
    const spec = path.join(projectRoot, "spec.md");
    const mock_ = path.join(projectRoot, "mock.html");
    writeFileSync(spec, "# Spec\n");
    writeFileSync(mock_, "<h1>Mock</h1>");
    const deps: any = makeDeps();
    deps.directory = projectRoot;
    deps.startAnnotateServer = mock(async (options: any) => ({
      port: 0,
      url: "http://localhost",
      isRemote: false,
      options,
      waitForDecision: async () => ({ feedback: "Two notes.", annotations: [{ id: "a1" }] }),
      stop: () => {},
    }));

    await handleAnnotateCommand({ properties: { arguments: "mock.html spec.md", sessionID: "session-123" } }, deps);

    const options = deps.startAnnotateServer.mock.calls[0]?.[0];
    expect(options.mode).toBe("annotate-bundle");
    expect(options.bundleFiles).toEqual([
      { path: mock_, renderAs: "html" },
      { path: spec, renderAs: "markdown" },
    ]);
    const prompt = deps.client.session.prompt.mock.calls[0]?.[0].body.parts[0].text;
    expect(prompt).toContain(`Files: ${mock_}, ${spec}`);
  });

  test("a list of file paths with a missing one opens nothing and names it", async () => {
    const projectRoot = makeTempDir();
    writeFileSync(path.join(projectRoot, "spec.md"), "# Spec\n");
    const deps: any = makeDeps();
    deps.directory = projectRoot;
    deps.startAnnotateServer = mock(async () => { throw new Error("must not start"); });
    await handleAnnotateCommand({ properties: { arguments: "spec.md typo.md", sessionID: "s" } }, deps);
    expect(deps.startAnnotateServer).not.toHaveBeenCalled();
    const logged = deps.client.app.log.mock.calls.map(([entry]: [{ message: string }]) => entry.message).join("\n");
    expect(logged).toContain("File not found: typo.md");
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

  test("a Done with nothing to send prompts nothing", async () => {
    const projectRoot = makeTempDir();
    writeFileSync(path.join(projectRoot, "plan.md"), "# Plan\n");
    const done = { feedback: "User reviewed the document and has no feedback.", annotations: [], nothingToSend: true };
    const fileDeps = routingDeps(MESSAGES.slice(0, 2), done);
    fileDeps.directory = projectRoot;
    await handleAnnotateCommand({ properties: { arguments: "plan.md", sessionID: "session-123" } }, fileDeps);
    expect(fileDeps.client.session.prompt).not.toHaveBeenCalled();

    const lastDeps = routingDeps(MESSAGES, { ...done, feedback: "User reviewed the messages and has no feedback." });
    expect(await handleAnnotateLastCommand({ properties: { sessionID: "session-123" } }, lastDeps)).toBeNull();
  });
});

describe("embedded commands toast the session URL", () => {
  const REMOTE_URL = "http://remote.example.test:19432";

  function readyThenDecide(decision: Record<string, unknown>) {
    return mock(async (options: any) => {
      await options.onReady(REMOTE_URL, true, 19432);
      return {
        port: 19432,
        url: REMOTE_URL,
        isRemote: true,
        waitForDecision: async () => ({ annotations: [], ...decision }),
        stop: () => {},
      };
    });
  }

  function toastedMessages(deps: any): string[] {
    return deps.client.tui.showToast.mock.calls.map((call: any[]) => call[0].body.message);
  }

  async function withoutBrowser(run: () => Promise<void>): Promise<void> {
    const skip = process.env.PLANNOTATOR_SKIP_BROWSER_OPEN;
    const readyFile = process.env.PLANNOTATOR_READY_FILE;
    const dataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_SKIP_BROWSER_OPEN = "1";
    delete process.env.PLANNOTATOR_READY_FILE;
    process.env.PLANNOTATOR_DATA_DIR = makeTempDir();
    try {
      await run();
    } finally {
      if (skip === undefined) delete process.env.PLANNOTATOR_SKIP_BROWSER_OPEN;
      else process.env.PLANNOTATOR_SKIP_BROWSER_OPEN = skip;
      if (readyFile !== undefined) process.env.PLANNOTATOR_READY_FILE = readyFile;
      if (dataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = dataDir;
    }
  }

  test("/plannotator-review", async () => {
    await withoutBrowser(async () => {
      const repoDir = initGitRepo();
      writeFileSync(path.join(repoDir, "change.ts"), "x\n");
      const deps: any = makeDeps();
      deps.directory = repoDir;
      deps.startReviewServer = readyThenDecide({ exit: true });

      await handleReviewCommand({ properties: { arguments: "", sessionID: "s" } }, deps);

      expect(toastedMessages(deps).some((message) => message.includes(REMOTE_URL))).toBe(true);
    });
  });

  test("/plannotator-annotate", async () => {
    await withoutBrowser(async () => {
      const projectRoot = makeTempDir();
      writeFileSync(path.join(projectRoot, "notes.md"), "# Notes\n");
      const deps: any = makeDeps();
      deps.directory = projectRoot;
      deps.startAnnotateServer = readyThenDecide({ exit: true });

      await handleAnnotateCommand({ properties: { arguments: "notes.md", sessionID: "s" } }, deps);

      expect(toastedMessages(deps).some((message) => message.includes(REMOTE_URL))).toBe(true);
    });
  });

  test("/plannotator-last", async () => {
    await withoutBrowser(async () => {
      const deps: any = makeDeps();
      deps.client.session.messages = mock(async (_input: unknown) => ({
        data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Answer" }] }],
      }));
      deps.startAnnotateServer = readyThenDecide({ exit: true });

      await handleAnnotateLastCommand({ properties: { sessionID: "s" } }, deps);

      expect(toastedMessages(deps).some((message) => message.includes(REMOTE_URL))).toBe(true);
    });
  });
});
