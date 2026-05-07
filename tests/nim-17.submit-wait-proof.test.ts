import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDaemonEventBus } from "../packages/server/daemon-events";
import type { DaemonState, DocumentSnapshot, FeedbackPayload } from "../packages/server/state";

type DaemonRouterFactory = (
  state: Record<string, unknown>,
  eventBus: Record<string, unknown>,
) => unknown;

type DaemonRouterModule = {
  createDaemonRouter: DaemonRouterFactory;
};

type DaemonRouterGate =
  | {
      available: true;
      module: DaemonRouterModule;
    }
  | {
      available: false;
      reason: string;
    };

type SubmitWaitSurfaceGate =
  | {
      available: true;
      module: DaemonRouterModule;
    }
  | {
      available: false;
      reason: string;
    };

type StartedDaemonServer = {
  url: string;
  getState: () => DaemonState;
  stop: () => Promise<void>;
};

type JsonResponse = {
  response: Response;
  text: string;
  json: Record<string, unknown> | null;
};

type SseEvent = {
  event: string;
  data: unknown;
  rawData: string;
};

type SseClient = {
  response: Response;
  close: () => Promise<void>;
  waitForEvent: (
    matcher?: (event: SseEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<SseEvent>;
};

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const daemonRouterModuleUrl = pathToFileURL(
  join(repoRoot, "packages/server/daemon-router.ts"),
).href;
const ROUTER_CASE_TIMEOUT_MS = 60_000;
const SSE_EVENT_TIMEOUT_MS = 10_000;

const idleState: DaemonState = {
  schemaVersion: 1,
  status: "idle",
  document: null,
  feedback: null,
};

const planDocument: DocumentSnapshot = {
  id: "nim-17-plan-doc",
  mode: "plan",
  origin: "claude-code",
  content: "# Submit/Wait Proof\n\n1. Start daemon in idle.\n2. Submit plan.\n3. Wait for verdict.\n",
};

const reviewDocument: DocumentSnapshot = {
  id: "nim-17-review-doc",
  mode: "review",
  origin: "opencode",
  gitRef: "HEAD",
  content: [
    "diff --git a/src/submit.ts b/src/submit.ts",
    "--- a/src/submit.ts",
    "+++ b/src/submit.ts",
    "@@ -1,3 +1,3 @@",
    "-export const submit = legacySubmit;",
    "+export const submit = daemonSubmit;",
  ].join("\n"),
};

const approvedPlanFeedback: FeedbackPayload = {
  approved: true,
  feedback: "The daemon delivered the plan verdict.",
      annotations: [
        {
          blockId: "proof-1",
          type: "COMMENT",
          text: "Verdict should be consumed once the eligible waiter receives it.",
        },
      ],
  permissionMode: "acceptEdits",
};

async function probeDaemonRouterModule(): Promise<DaemonRouterGate> {
  let imported: unknown;

  try {
    imported = await import(daemonRouterModuleUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason: [
        "NIM-17 expects packages/server/daemon-router.ts to exist and export createDaemonRouter(state, eventBus).",
        `Import failed: ${message}`,
      ].join("\n"),
    };
  }

  const candidate = imported as Partial<DaemonRouterModule>;
  if (typeof candidate.createDaemonRouter !== "function") {
    return {
      available: false,
      reason:
        "packages/server/daemon-router.ts must export createDaemonRouter(state, eventBus).",
    };
  }

  return {
    available: true,
    module: candidate as DaemonRouterModule,
  };
}

const daemonRouterGate = await probeDaemonRouterModule();

function createRouterStateHarness(initialState: DaemonState) {
  let currentState = structuredClone(initialState);

  const writeState = (nextState: DaemonState) => {
    currentState = structuredClone(nextState);
  };

  return {
    getState: () => structuredClone(currentState),
    saveState: (nextState: DaemonState) => writeState(nextState),
    setState: (nextState: DaemonState) => writeState(nextState),
    updateState: (nextState: DaemonState) => writeState(nextState),
    loadState: () => structuredClone(currentState),
    readState: () => structuredClone(currentState),
    planHtml: "<html><body>plan</body></html>",
    reviewHtml: "<html><body>review</body></html>",
    ui: {
      planHtml: "<html><body>plan</body></html>",
      reviewHtml: "<html><body>review</body></html>",
    },
  };
}

function resolveFetchHandler(candidate: unknown): (req: Request) => Response | Promise<Response> {
  if (typeof candidate === "function") {
    return candidate as (req: Request) => Response | Promise<Response>;
  }

  if (
    candidate &&
    typeof candidate === "object" &&
    "fetch" in candidate &&
    typeof candidate.fetch === "function"
  ) {
    return candidate.fetch.bind(candidate) as (req: Request) => Response | Promise<Response>;
  }

  throw new Error(
    "createDaemonRouter() must return a fetch handler function or an object with a fetch() method.",
  );
}

async function startDaemonServer(initialState: DaemonState): Promise<StartedDaemonServer> {
  if (!daemonRouterGate.available) {
    throw new Error(daemonRouterGate.reason);
  }

  const stateHarness = createRouterStateHarness(initialState);
  const eventBus = createDaemonEventBus();
  const fetchHandler = resolveFetchHandler(
    daemonRouterGate.module.createDaemonRouter(
      stateHarness as unknown as Record<string, unknown>,
      eventBus as unknown as Record<string, unknown>,
    ),
  );

  const server = Bun.serve({
    port: 0,
    fetch: fetchHandler,
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    getState: () => stateHarness.getState(),
    stop: async () => {
      await server.stop(true);
    },
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<JsonResponse> {
  const response = await fetch(url, init);
  const text = await response.text();
  let json: Record<string, unknown> | null = null;

  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }

  return {
    response,
    text,
    json,
  };
}

async function postSubmit(url: string, document: DocumentSnapshot): Promise<JsonResponse> {
  return await fetchJson(`${url}/api/submit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document }),
  });
}

async function postApprove(url: string, feedback: FeedbackPayload): Promise<JsonResponse> {
  return await fetchJson(`${url}/api/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feedback: feedback.feedback,
      annotations: feedback.annotations,
      permissionMode: feedback.permissionMode,
    }),
  });
}

async function postClear(url: string, force?: boolean): Promise<JsonResponse> {
  return await fetchJson(`${url}/api/clear`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(force ? { force: true } : {}),
  });
}

function parseSseEvent(rawEvent: string): SseEvent | null {
  const trimmed = rawEvent.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const rawData = dataLines.join("\n");
  if (rawData.length === 0) {
    return null;
  }

  try {
    return {
      event,
      data: JSON.parse(rawData) as unknown,
      rawData,
    };
  } catch {
    return {
      event,
      data: rawData,
      rawData,
    };
  }
}

async function connectSseClient(url: string, requestId?: string): Promise<SseClient> {
  const controller = new AbortController();
  const waitUrl = requestId ? `${url}/api/wait?requestId=${encodeURIComponent(requestId)}` : `${url}/api/wait`;
  const response = await fetch(waitUrl, {
    headers: {
      accept: "text/event-stream",
    },
    signal: controller.signal,
  });

  if (response.status !== 200) {
    throw new Error(
      [
        `Expected /api/wait to return 200 with an SSE stream, got ${response.status}.`,
        await response.text(),
      ].join("\n"),
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error(
      `Expected /api/wait to use text/event-stream, received ${contentType || "<missing>"}.`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("/api/wait must provide a readable response body for SSE clients.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const readNextEvent = async (): Promise<SseEvent> => {
    while (true) {
      const delimiterIndex = buffer.indexOf("\n\n");
      if (delimiterIndex !== -1) {
        const rawEvent = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) {
          return parsed;
        }
        continue;
      }

      const { done, value } = await reader.read();
      if (done) {
        throw new Error("SSE stream ended before delivering a verdict event.");
      }

      buffer += decoder.decode(value, { stream: true });
    }
  };

  return {
    response,
    async close() {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // Abort tears the stream down; a second cancel may throw after disconnect.
      }
    },
    async waitForEvent(
      matcher: (event: SseEvent) => boolean = () => true,
      timeoutMs = SSE_EVENT_TIMEOUT_MS,
    ): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs;

      while (Date.now() <= deadline) {
        const remaining = deadline - Date.now();
        const event = await Promise.race([
          readNextEvent(),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("Timed out waiting for matching SSE verdict.")), remaining);
          }),
        ]);

        if (matcher(event)) {
          return event;
        }
      }

      throw new Error("Timed out waiting for matching SSE verdict.");
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFeedbackFromEvent(event: SseEvent): FeedbackPayload {
  const candidate = event.data;
  if (isRecord(candidate) && isRecord(candidate.feedback)) {
    return candidate.feedback as FeedbackPayload;
  }

  if (
    isRecord(candidate) &&
    isRecord(candidate.state) &&
    isRecord(candidate.state.feedback)
  ) {
    return candidate.state.feedback as FeedbackPayload;
  }

  throw new Error(
    `Expected verdict SSE payload to include feedback or state.feedback, received: ${event.rawData}`,
  );
}

function extractDocumentIdFromEvent(event: SseEvent): string | undefined {
  const candidate = event.data;
  if (isRecord(candidate) && isRecord(candidate.document) && typeof candidate.document.id === "string") {
    return candidate.document.id;
  }

  if (
    isRecord(candidate) &&
    isRecord(candidate.state) &&
    isRecord(candidate.state.document) &&
    typeof candidate.state.document.id === "string"
  ) {
    return candidate.state.document.id;
  }

  return undefined;
}

function eventCarriesApprovedVerdict(event: SseEvent): boolean {
  try {
    const feedback = extractFeedbackFromEvent(event);
    return feedback.approved === true && feedback.feedback === approvedPlanFeedback.feedback;
  } catch {
    return false;
  }
}

function eventCarriesCancelledVerdict(event: SseEvent): boolean {
  try {
    const feedback = extractFeedbackFromEvent(event);
    return feedback.approved === false && feedback.cancelled === true;
  } catch {
    return false;
  }
}

async function probeSubmitWaitSurface(): Promise<SubmitWaitSurfaceGate> {
  if (!daemonRouterGate.available) {
    return daemonRouterGate;
  }

  const server = await startDaemonServer(idleState);

  try {
    const submit = await postSubmit(server.url, planDocument);
    if ([404, 405].includes(submit.response.status)) {
      return {
        available: false,
        reason: [
          "NIM-17 expects the daemon-owned router to accept POST /api/submit from idle state.",
          `Observed status ${submit.response.status} with body:`,
          submit.text || "<empty>",
        ].join("\n"),
      };
    }

    const waitClient = await connectSseClient(server.url).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      return {
        response: null,
        error: message,
      };
    });

    if ("error" in waitClient) {
      return {
        available: false,
        reason: [
          "NIM-17 expects GET /api/wait to open a text/event-stream verdict channel after submit.",
          waitClient.error,
        ].join("\n"),
      };
    }

    await waitClient.close();

    const clear = await postClear(server.url, true);
    if ([404, 405].includes(clear.response.status)) {
      return {
        available: false,
        reason: [
          "NIM-17 expects POST /api/clear to exist so buffered or in-flight verdicts can be cleared.",
          `Observed status ${clear.response.status} with body:`,
          clear.text || "<empty>",
        ].join("\n"),
      };
    }

    return {
      available: true,
      module: daemonRouterGate.module,
    };
  } finally {
    await server.stop();
  }
}

const submitWaitGate = await probeSubmitWaitSurface();

describe("NIM-17 submit/wait proof", () => {
  test("defines daemon-owned /api/submit, /api/wait, and /api/clear routes before submit/wait semantics activate", () => {
    if (!submitWaitGate.available) {
      throw new Error(submitWaitGate.reason);
    }
  });

  if (!submitWaitGate.available) {
    return;
  }

  test("rejects a second submission while the first document is still awaiting verdict", async () => {
    const server = await startDaemonServer(idleState);

    try {
      const firstSubmit = await postSubmit(server.url, planDocument);
      expect([200, 202]).toContain(firstSubmit.response.status);

      const visiblePlan = await fetchJson(`${server.url}/api/plan`);
      expect(visiblePlan.response.status).toBe(200);
      expect(visiblePlan.json).toMatchObject({
        plan: planDocument.content,
        origin: planDocument.origin,
      });

      const secondSubmit = await postSubmit(server.url, reviewDocument);
      expect(secondSubmit.response.status).toBe(409);

      const stillActive = await fetchJson(`${server.url}/api/plan`);
      expect(stillActive.response.status).toBe(200);
      expect(stillActive.json).toMatchObject({
        plan: planDocument.content,
        origin: planDocument.origin,
      });
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);

  test("delivers a live verdict to a connected waiter and clears the request once that waiter consumes it", async () => {
    const server = await startDaemonServer(idleState);

    try {
      const submit = await postSubmit(server.url, planDocument);
      expect([200, 202]).toContain(submit.response.status);

      const waiter = await connectSseClient(server.url);
      try {
        const approve = await postApprove(server.url, approvedPlanFeedback);
        expect(approve.response.status).toBe(200);

        const verdict = await waiter.waitForEvent(eventCarriesApprovedVerdict);
        expect(extractFeedbackFromEvent(verdict)).toMatchObject({
          approved: true,
          feedback: approvedPlanFeedback.feedback,
          permissionMode: approvedPlanFeedback.permissionMode,
        });
        expect(extractDocumentIdFromEvent(verdict)).toBe(planDocument.id);
      } finally {
        await waiter.close();
      }

      const lateWait = await fetch(`${server.url}/api/wait?requestId=${planDocument.id}`);
      expect(lateWait.status).toBe(409);
      expect(await lateWait.text()).toContain("verdict_consumed_or_unknown");

      const resubmitted = await postSubmit(server.url, reviewDocument);
      expect([200, 202]).toContain(resubmitted.response.status);
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);

  test("survives waiter disconnects and replays the buffered verdict to a later reconnect", async () => {
    const server = await startDaemonServer(idleState);

    try {
      const submit = await postSubmit(server.url, planDocument);
      expect([200, 202]).toContain(submit.response.status);

      const disconnectedWaiter = await connectSseClient(server.url);
      await disconnectedWaiter.close();

      const approve = await postApprove(server.url, approvedPlanFeedback);
      expect(approve.response.status).toBe(200);

      // State is now resolved — must pass requestId per D2 enforcement
      const reconnectedWaiter = await connectSseClient(server.url, planDocument.id);
      try {
        const replayedVerdict = await reconnectedWaiter.waitForEvent(eventCarriesApprovedVerdict);
        expect(extractFeedbackFromEvent(replayedVerdict)).toMatchObject({
          approved: true,
          feedback: approvedPlanFeedback.feedback,
        });
      } finally {
        await reconnectedWaiter.close();
      }
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);

  test("force clear aborts an in-flight submission, emits a cancelled verdict, and reopens the singleton slot", async () => {
    const server = await startDaemonServer(idleState);

    try {
      const submit = await postSubmit(server.url, reviewDocument);
      expect([200, 202]).toContain(submit.response.status);

      const waiter = await connectSseClient(server.url);
      try {
        const forcedClear = await postClear(server.url, true);
        expect(forcedClear.response.status).toBe(200);

        const cancelledVerdict = await waiter.waitForEvent(eventCarriesCancelledVerdict);
        expect(extractFeedbackFromEvent(cancelledVerdict)).toMatchObject({
          approved: false,
          cancelled: true,
        });
        expect(extractDocumentIdFromEvent(cancelledVerdict)).toBe(reviewDocument.id);
      } finally {
        await waiter.close();
      }

      const replacementSubmit = await postSubmit(server.url, planDocument);
      expect([200, 202]).toContain(replacementSubmit.response.status);
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);
});
