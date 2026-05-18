import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createPluginSuccessResponse,
  getPluginCapabilities,
} from "../../packages/shared/plugin-protocol";

const ensurePlannotatorBinaryMock = mock(() => ({
  ok: true,
  path: "/bin/plannotator",
  source: "path",
  installed: false,
  capabilities: getPluginCapabilities(),
}));

const runPluginAnnotateMock = mock(async (_binaryPath: string, _request: unknown) =>
  createPluginSuccessResponse({ feedback: "", filePath: "/repo/docs/Design Spec.html", mode: "annotate" }),
);
const runPluginReviewMock = mock(async (_binaryPath: string, _request: unknown) =>
  createPluginSuccessResponse({ approved: false, feedback: "", annotations: [] }),
);
const runPluginArchiveMock = mock(async (_binaryPath: string, _request: unknown) =>
  createPluginSuccessResponse({ opened: true }),
);

const { handleAnnotateCommand, handleAnnotateLastCommand, handleArchiveCommand, handleReviewCommand } = await import("./commands");

function makeDeps() {
  return {
    client: {
      app: {
        log: mock((_entry: unknown) => {}),
        agents: mock(async (_input: unknown) => ({
          data: [{ name: "build", mode: "primary" }],
        })),
      },
      session: {
        prompt: mock(async (_input: unknown) => {}),
        messages: mock(async (_input: unknown) => ({ data: [] })),
      },
    },
    getSharingEnabled: async () => true,
    getShareBaseUrl: () => "https://share.example.test",
    getPasteApiUrl: () => "https://paste.example.test",
    directory: "/repo" as string | undefined,
    binaryClient: {
      ensurePlannotatorBinary: ensurePlannotatorBinaryMock,
      runPluginAnnotate: runPluginAnnotateMock,
      runPluginReview: runPluginReviewMock,
      runPluginArchive: runPluginArchiveMock,
    },
  };
}

afterEach(() => {
  ensurePlannotatorBinaryMock.mockClear();
  runPluginAnnotateMock.mockClear();
  runPluginReviewMock.mockClear();
  runPluginArchiveMock.mockClear();
});

describe("handleAnnotateCommand", () => {
  test("forwards raw annotate arguments and sharing settings to the binary", async () => {
    const deps = makeDeps();

    await handleAnnotateCommand(
      { properties: { arguments: "\"docs/Design Spec.html\"" } },
      deps,
    );

    expect(runPluginAnnotateMock).toHaveBeenCalledTimes(1);
    expect(runPluginAnnotateMock.mock.calls[0]?.[0]).toBe("/bin/plannotator");
    expect(runPluginAnnotateMock.mock.calls[0]?.[1]).toEqual({
      origin: "opencode",
      cwd: "/repo",
      args: "\"docs/Design Spec.html\"",
      sharingEnabled: true,
      shareBaseUrl: "https://share.example.test",
      pasteApiUrl: "https://paste.example.test",
    });
    const options = runPluginAnnotateMock.mock.calls[0]?.[3] as any;
    options.onSession({ url: "http://127.0.0.1:1234/s/s1" });
    expect(deps.client.app.log).toHaveBeenCalledWith({
      level: "info",
      message: "[Plannotator] Open in browser: http://127.0.0.1:1234/s/s1",
    });
  });

  test("injects folder feedback using file metadata returned by the binary", async () => {
    runPluginAnnotateMock.mockImplementationOnce(async (_binaryPath: string, _request: unknown) =>
      createPluginSuccessResponse({
        feedback: "Please revise this section.",
        filePath: "/repo/docs/Specs Folder",
        mode: "annotate-folder",
      }),
    );
    const deps = makeDeps();

    await handleAnnotateCommand(
      { properties: { arguments: "\"docs/Specs Folder\"", sessionID: "session-123" } },
      deps,
    );

    expect(deps.client.session.prompt).toHaveBeenCalledTimes(1);
    const prompt = deps.client.session.prompt.mock.calls[0]?.[0] as any;
    expect(prompt.body.parts[0].text).toContain("Folder: /repo/docs/Specs Folder");
    expect(prompt.body.parts[0].text).toContain("Please revise this section.");
  });
});

describe("handleReviewCommand", () => {
  test("forwards available OpenCode agents to the binary", async () => {
    const deps = makeDeps();

    await handleReviewCommand(
      { properties: { arguments: "--base main" } },
      deps,
    );

    expect(deps.client.app.agents).toHaveBeenCalledWith({
      query: { directory: "/repo" },
    });
    expect(runPluginReviewMock).toHaveBeenCalledTimes(1);
    expect(runPluginReviewMock.mock.calls[0]?.[1]).toEqual({
      origin: "opencode",
      cwd: "/repo",
      args: "--base main",
      sharingEnabled: true,
      shareBaseUrl: "https://share.example.test",
      pasteApiUrl: "https://paste.example.test",
      availableAgents: [{ name: "build", mode: "primary" }],
    });
    const options = runPluginReviewMock.mock.calls[0]?.[3] as any;
    options.onSession({ url: "http://127.0.0.1:1234/s/review" });
    expect(deps.client.app.log).toHaveBeenCalledWith({
      level: "info",
      message: "[Plannotator] Open in browser: http://127.0.0.1:1234/s/review",
    });
  });

  test("logs when OpenCode agents cannot be loaded", async () => {
    const deps = makeDeps();
    deps.client.app.agents = mock(async () => {
      throw new Error("agent API unavailable");
    });

    await handleReviewCommand(
      { properties: { arguments: "--base main" } },
      deps,
    );

    expect(deps.client.app.agents).toHaveBeenCalledTimes(3);
    expect(deps.client.app.log).toHaveBeenCalledWith({
      level: "info",
      message: "[Plannotator] OpenCode agent list unavailable; agent switching is disabled for this session. agent API unavailable",
    });
    expect(runPluginReviewMock.mock.calls[0]?.[1]).toMatchObject({
      availableAgents: undefined,
    });
  });
});

describe("handleAnnotateLastCommand", () => {
  test("passes the last assistant message through annotate-last binary mode", async () => {
    runPluginAnnotateMock.mockImplementationOnce(async (_binaryPath: string, _request: unknown) =>
      createPluginSuccessResponse({ feedback: "Tighten the conclusion.", mode: "annotate-last" }),
    );
    const deps = makeDeps();
    deps.client.session.messages = mock(async (_input: unknown) => ({
      data: [
        {
          info: { role: "assistant" },
          parts: [{ type: "text", text: "Latest assistant message" }],
        },
      ],
    }));

    const feedback = await handleAnnotateLastCommand(
      { properties: { sessionID: "session-123" } },
      deps,
    );

    expect(feedback).toBe("Tighten the conclusion.");
    expect(runPluginAnnotateMock).toHaveBeenCalledTimes(1);
    expect(runPluginAnnotateMock.mock.calls[0]?.[1]).toEqual({
      origin: "opencode",
      cwd: "/repo",
      markdown: "Latest assistant message",
      filePath: "last-message",
      mode: "annotate-last",
      sharingEnabled: true,
      shareBaseUrl: "https://share.example.test",
      pasteApiUrl: "https://paste.example.test",
      gate: false,
    });
    const options = runPluginAnnotateMock.mock.calls[0]?.[3] as any;
    options.onSession({ url: "http://127.0.0.1:1234/s/last" });
    expect(deps.client.app.log).toHaveBeenCalledWith({
      level: "info",
      message: "[Plannotator] Open in browser: http://127.0.0.1:1234/s/last",
    });
  });

  test("handles missing session messages without throwing", async () => {
    const deps = makeDeps();
    deps.client.session.messages = mock(async () => {
      throw new Error("session unavailable");
    });

    const feedback = await handleAnnotateLastCommand(
      { properties: { sessionID: "session-123" } },
      deps,
    );

    expect(feedback).toBeNull();
    expect(runPluginAnnotateMock).not.toHaveBeenCalled();
    expect(deps.client.app.log).toHaveBeenCalledWith({
      level: "error",
      message: "[Plannotator] Could not read the current session messages. session unavailable",
    });
  });
});

describe("handleArchiveCommand", () => {
  test("surfaces the archive browser URL through OpenCode logs", async () => {
    const deps = makeDeps();

    await handleArchiveCommand({}, deps);

    expect(runPluginArchiveMock).toHaveBeenCalledTimes(1);
    const options = runPluginArchiveMock.mock.calls[0]?.[3] as any;
    options.onSession({ url: "http://127.0.0.1:1234/s/archive" });
    expect(deps.client.app.log).toHaveBeenCalledWith({
      level: "info",
      message: "[Plannotator] Open in browser: http://127.0.0.1:1234/s/archive",
    });
  });
});
