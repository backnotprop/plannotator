import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { handleAnnotateCommand, handleAnnotateLastCommand } from "./commands";

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

describe("handleAnnotateCommand", () => {
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
