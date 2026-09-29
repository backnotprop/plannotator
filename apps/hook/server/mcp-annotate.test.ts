/**
 * The `annotate` MCP tool (`plannotator mcp`, the Codex plugin).
 *
 * Guards: relative targets resolve against the right directory through the
 * REAL CLI resolver (a wrong root is a silent "File not found" in Codex);
 * the tool result carries the plaintext CLI text plus the `--json` record;
 * cancelling the call stops the annotate server instead of leaking it; and
 * the URL reaches the client through notifications, since stdout is the
 * protocol.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { resolveAnnotateTarget, type AnnotateResolutionSuccess } from "./annotate-resolution";
import type { AnnotateOutcome } from "./annotate-output";
import {
  ANNOTATE_DISMISSED_TEXT,
  ANNOTATE_EMPTY_FEEDBACK_TEXT,
  ANNOTATE_STATUS_TOOL_NAME,
  ANNOTATE_TOOL_NAME,
  AnnotateSessionRegistry,
  buildAnnotateToolResult,
  createAnnotateResources,
  createAnnotateTools,
  runAnnotateTool,
  type AnnotateToolDeps,
} from "./mcp-annotate";
import { createMcpServer, McpCallCancelledError, type McpToolContext } from "./mcp-protocol";

let tempRoot: string;
let previousDataDir: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), "plannotator-mcp-"));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = path.join(tempRoot, "data");
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

interface FakeSession {
  deps: AnnotateToolDeps;
  started: AnnotateResolutionSuccess[];
  stopCount: () => number;
  decide: (outcome: AnnotateOutcome) => void;
}

function fakeDeps(options: { defaultCwd: string; remote?: boolean; url?: string }): FakeSession {
  const started: AnnotateResolutionSuccess[] = [];
  let stops = 0;
  let resolveDecision: (outcome: AnnotateOutcome) => void = () => {};
  const decision = new Promise<AnnotateOutcome>((resolve) => {
    resolveDecision = resolve;
  });
  const deps: AnnotateToolDeps = {
    defaultCwd: () => options.defaultCwd,
    isRemote: () => options.remote ?? false,
    liveAppRemoteMessage: "live app unavailable in remote mode",
    settleAfterDecision: async () => {},
    // The real resolver: resolution parity with `plannotator annotate` is the point.
    resolveTarget: (opts) => resolveAnnotateTarget({ ...opts }),
    startSession: async (resolution, { onReady }) => {
      started.push(resolution);
      const url = options.url ?? "http://localhost:4321";
      onReady(url, options.remote ?? false);
      return {
        url,
        isRemote: options.remote ?? false,
        waitForDecision: () => decision,
        stop: () => {
          stops += 1;
        },
      };
    },
  };
  return { deps, started, stopCount: () => stops, decide: resolveDecision };
}

/** Wait until the handler has started its (fake) annotate server. */
async function started(fake: FakeSession, count = 1): Promise<void> {
  for (let i = 0; i < 200 && fake.started.length < count; i += 1) await Bun.sleep(5);
  expect(fake.started.length).toBe(count);
  await Bun.sleep(0);
}

function ctx(signal: AbortSignal = new AbortController().signal) {
  const logs: string[] = [];
  const progress: string[] = [];
  const context: McpToolContext = {
    signal,
    log: (_level, data) => logs.push(data),
    progress: (message) => progress.push(message),
  };
  return { context, logs, progress };
}

describe("annotate tool: target resolution", () => {
  test("a relative file resolves against the server cwd and opens that file", async () => {
    writeFileSync(path.join(tempRoot, "notes.md"), "# Notes\n");
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const registry = new AnnotateSessionRegistry();
    const pending = runAnnotateTool({ target: "notes.md" }, ctx().context, fake.deps, registry);
    await started(fake);
    fake.decide({ feedback: "Tighten the intro." });
    const result = await pending;
    expect(result.isError).toBeUndefined();
    expect(fake.started[0].absolutePath).toBe(path.join(tempRoot, "notes.md"));
    expect(fake.started[0].markdown).toBe("# Notes\n");
  });

  test("an explicit cwd wins over the server cwd for relative targets", async () => {
    const project = path.join(tempRoot, "project");
    mkdirSync(project);
    writeFileSync(path.join(project, "plan.md"), "# Plan\n");
    // The server's own cwd has no plan.md, so resolving there would fail.
    const fake = fakeDeps({ defaultCwd: path.join(tempRoot) });
    const pending = runAnnotateTool(
      { target: "plan.md", cwd: project },
      ctx().context,
      fake.deps,
      new AnnotateSessionRegistry(),
    );
    await started(fake);
    fake.decide({ feedback: "", approved: true });
    await pending;
    expect(fake.started[0].absolutePath).toBe(path.join(project, "plan.md"));
  });

  test("a folder target opens a folder session", async () => {
    const docs = path.join(tempRoot, "docs");
    mkdirSync(docs);
    writeFileSync(path.join(docs, "a.md"), "# A\n");
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const pending = runAnnotateTool({ target: docs }, ctx().context, fake.deps, new AnnotateSessionRegistry());
    await started(fake);
    fake.decide({ feedback: "", exit: true });
    await pending;
    expect(fake.started[0].annotateMode).toBe("annotate-folder");
    expect(fake.started[0].folderPath).toBe(docs);
  });

  test("a missing file is a tool error naming the directory it was resolved against, and no server starts", async () => {
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const result = await runAnnotateTool(
      { target: "missing.md" },
      ctx().context,
      fake.deps,
      new AnnotateSessionRegistry(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found: missing.md");
    expect(result.content[0].text).toContain(tempRoot);
    expect(fake.started).toHaveLength(0);
  });

  test("a cwd that is not a directory is refused before resolution", async () => {
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const result = await runAnnotateTool(
      { target: "x.md", cwd: path.join(tempRoot, "nope") },
      ctx().context,
      fake.deps,
      new AnnotateSessionRegistry(),
    );
    expect(result.isError).toBe(true);
    expect(fake.started).toHaveLength(0);
  });

  test("bad input shapes are tool errors", async () => {
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const registry = new AnnotateSessionRegistry();
    for (const args of [{}, { target: "  " }, { target: "a.md", gate: "yes" }]) {
      const result = await runAnnotateTool(args, ctx().context, fake.deps, registry);
      expect(result.isError).toBe(true);
    }
    expect(fake.started).toHaveLength(0);
  });
});

describe("annotate tool: result shapes", () => {
  // The text half is the plaintext CLI contract; the structured half is the
  // `--json` record. Both are pinned on purpose: agents branch on them.
  test("feedback returns the feedback text and an annotated record", () => {
    const result = buildAnnotateToolResult({ feedback: "Fix step 2." });
    expect(result.content).toEqual([{ type: "text", text: "Fix step 2." }]);
    expect(result.structuredContent).toEqual({ decision: "annotated", feedback: "Fix step 2." });
  });

  test("approval returns the CLI approval marker", () => {
    const result = buildAnnotateToolResult({ feedback: "", approved: true });
    expect(result.content[0].text).toBe("The user approved.");
    expect(result.structuredContent).toEqual({ decision: "approved" });
  });

  test("close returns an explicit closed-without-feedback sentence, not an empty result", () => {
    const result = buildAnnotateToolResult({ feedback: "", exit: true });
    expect(result.content[0].text).toBe(ANNOTATE_DISMISSED_TEXT);
    expect(result.structuredContent).toEqual({ decision: "dismissed" });
  });

  test("an empty submission is distinguishable from a close", () => {
    const result = buildAnnotateToolResult({ feedback: "" });
    expect(result.content[0].text).toBe(ANNOTATE_EMPTY_FEEDBACK_TEXT);
    expect(result.structuredContent).toEqual({ decision: "annotated", feedback: "" });
  });
});

describe("annotate tool: session lifecycle", () => {
  test("the decision stops the server and the URL is announced through notifications", async () => {
    writeFileSync(path.join(tempRoot, "doc.md"), "# Doc\n");
    const fake = fakeDeps({ defaultCwd: tempRoot, url: "http://localhost:5555" });
    const registry = new AnnotateSessionRegistry();
    const c = ctx();
    const pending = runAnnotateTool({ target: "doc.md" }, c.context, fake.deps, registry);
    await started(fake);
    expect(registry.list()[0]).toMatchObject({ state: "open", url: "http://localhost:5555" });
    fake.decide({ feedback: "ok" });
    await pending;
    expect(fake.stopCount()).toBe(1);
    expect(c.logs.some((line) => line.includes("http://localhost:5555"))).toBe(true);
    expect(c.progress.some((line) => line.includes("http://localhost:5555"))).toBe(true);
    expect(registry.list()[0]).toMatchObject({ state: "decided", decision: "annotated", resultText: "ok" });
  });

  test("a remote session's notification says to open the URL on the local machine", async () => {
    writeFileSync(path.join(tempRoot, "doc.md"), "# Doc\n");
    const fake = fakeDeps({ defaultCwd: tempRoot, remote: true, url: "http://localhost:19432" });
    const c = ctx();
    const pending = runAnnotateTool({ target: "doc.md" }, c.context, fake.deps, new AnnotateSessionRegistry());
    await started(fake);
    fake.decide({ feedback: "", exit: true });
    await pending;
    expect(c.logs.find((line) => line.includes("http://localhost:19432"))).toContain("remote");
  });

  test("cancelling the call stops the server and sends no result", async () => {
    writeFileSync(path.join(tempRoot, "doc.md"), "# Doc\n");
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const registry = new AnnotateSessionRegistry();
    const controller = new AbortController();
    const pending = runAnnotateTool({ target: "doc.md" }, ctx(controller.signal).context, fake.deps, registry);
    await started(fake);
    controller.abort("user interrupted");
    await expect(pending).rejects.toBeInstanceOf(McpCallCancelledError);
    expect(fake.stopCount()).toBe(1);
    expect(registry.list()[0].state).toBe("cancelled");
  });
});

describe("annotate tool over the MCP protocol", () => {
  function server(deps: AnnotateToolDeps) {
    const sent: Record<string, any>[] = [];
    const registry = new AnnotateSessionRegistry();
    const mcp = createMcpServer({
      name: "plannotator",
      version: "test",
      tools: createAnnotateTools(deps, registry),
      resources: createAnnotateResources(),
      send: (message) => sent.push(message),
    });
    return { mcp, sent };
  }

  test("notifications/cancelled aborts the running call: server stopped, no response for that id", async () => {
    writeFileSync(path.join(tempRoot, "doc.md"), "# Doc\n");
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const { mcp, sent } = server(fake.deps);
    const call = mcp.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: ANNOTATE_TOOL_NAME, arguments: { target: "doc.md" }, _meta: { progressToken: "p1" } },
    });
    await started(fake);
    // A ping must be answered while the annotate call is still blocked.
    await mcp.handleMessage({ jsonrpc: "2.0", id: 8, method: "ping" });
    expect(sent.find((m) => m.id === 8)?.result).toEqual({});
    expect(sent.some((m) => m.method === "notifications/progress" && m.params.progressToken === "p1")).toBe(true);

    await mcp.handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
    await call;
    expect(fake.stopCount()).toBe(1);
    expect(sent.some((m) => m.id === 7)).toBe(false);
    expect(mcp.inFlight()).toBe(0);
  });

  test("transport shutdown cancels in-flight calls so no annotate server is left running", async () => {
    writeFileSync(path.join(tempRoot, "doc.md"), "# Doc\n");
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const { mcp } = server(fake.deps);
    const call = mcp.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: ANNOTATE_TOOL_NAME, arguments: { target: "doc.md" } },
    });
    await started(fake);
    await mcp.shutdown(1000);
    await call;
    expect(fake.stopCount()).toBe(1);
  });

  test("the tool result carries text and structured content", async () => {
    writeFileSync(path.join(tempRoot, "doc.md"), "# Doc\n");
    const fake = fakeDeps({ defaultCwd: tempRoot });
    const { mcp, sent } = server(fake.deps);
    const call = mcp.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: ANNOTATE_TOOL_NAME, arguments: { target: path.join(tempRoot, "doc.md") } },
    });
    await started(fake);
    fake.decide({ feedback: "Rename section 3." });
    await call;
    expect(sent.find((m) => m.id === 2)?.result).toEqual({
      content: [{ type: "text", text: "Rename section 3." }],
      structuredContent: { decision: "annotated", feedback: "Rename section 3." },
    });
  });

  test("the status tool is hidden from the model and reports the session URL to the view", async () => {
    writeFileSync(path.join(tempRoot, "doc.md"), "# Doc\n");
    const fake = fakeDeps({ defaultCwd: tempRoot, url: "http://localhost:6000" });
    const { mcp, sent } = server(fake.deps);
    await mcp.handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = sent.find((m) => m.id === 1)!.result.tools as Record<string, any>[];
    const status = tools.find((t) => t.name === ANNOTATE_STATUS_TOOL_NAME)!;
    expect(status._meta.ui.visibility).toEqual(["app"]);
    const annotate = tools.find((t) => t.name === ANNOTATE_TOOL_NAME)!;
    expect(annotate._meta.ui.resourceUri).toBe("ui://plannotator/annotate");
    expect(tools.every((t) => !("handler" in t))).toBe(true);

    const call = mcp.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: ANNOTATE_TOOL_NAME, arguments: { target: "doc.md" } },
    });
    await started(fake);
    await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: ANNOTATE_STATUS_TOOL_NAME, arguments: {} },
    });
    const sessions = sent.find((m) => m.id === 3)!.result.structuredContent.sessions;
    expect(sessions[0]).toMatchObject({ target: "doc.md", state: "open", url: "http://localhost:6000" });
    fake.decide({ feedback: "", exit: true });
    await call;
  });

  test("the ui:// resource is served as an MCP App document", async () => {
    const { mcp, sent } = server(fakeDeps({ defaultCwd: tempRoot }).deps);
    await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "ui://plannotator/annotate" },
    });
    const content = sent.find((m) => m.id === 1)!.result.contents[0];
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    // The view must drive the status tool the server actually exposes.
    expect(content.text).toContain(ANNOTATE_STATUS_TOOL_NAME);
  });
});
