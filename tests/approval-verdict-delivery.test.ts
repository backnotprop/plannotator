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
  id: "approval-test-plan",
  mode: "plan",
  origin: "claude-code",
  content: "# Approval Test Plan\n\nThis plan will be approved to test verdict delivery.\n",
};

const approvedFeedback: FeedbackPayload = {
  approved: true,
  feedback: "Approved for testing verdict delivery.",
  annotations: [],
  permissionMode: "acceptEdits",
};

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
  const daemonRouterModule = (await import(daemonRouterModuleUrl)) as DaemonRouterModule;

  const stateHarness = createRouterStateHarness(initialState);
  const eventBus = createDaemonEventBus();
  const fetchHandler = resolveFetchHandler(
    daemonRouterModule.createDaemonRouter(
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

describe("Approval verdict delivery", () => {
  test("approval delivers complete verdict with feedback and document", async () => {
    const server = await startDaemonServer(idleState);

    try {
      // Submit plan
      const submit = await postSubmit(server.url, planDocument);
      expect([200, 202]).toContain(submit.response.status);

      // Connect waiter
      const waiter = await connectSseClient(server.url);

      try {
        // Approve plan
        const approve = await postApprove(server.url, approvedFeedback);
        expect(approve.response.status).toBe(200);

        // Wait for verdict
        const verdict = await waiter.waitForEvent();
        expect(verdict.event).toBe("verdict");

        // Verify verdict payload has BOTH feedback AND document
        const payload = verdict.data;
        expect(isRecord(payload)).toBe(true);

        if (!isRecord(payload)) {
          throw new Error("Verdict payload is not a record");
        }

        // These assertions will FAIL with the current bug
        expect(payload.feedback).toBeDefined();
        expect(payload.document).toBeDefined();

        expect(isRecord(payload.feedback)).toBe(true);
        expect(isRecord(payload.document)).toBe(true);

        if (isRecord(payload.feedback)) {
          expect(payload.feedback.approved).toBe(true);
          expect(payload.feedback.feedback).toBe(approvedFeedback.feedback);
        }

        if (isRecord(payload.document)) {
          expect(payload.document.id).toBe(planDocument.id);
        }

        // Verify daemon transitioned to idle after approval
        const finalState = server.getState();
        expect(finalState.status).toBe("idle");
      } finally {
        await waiter.close();
      }
    } finally {
      await server.stop();
    }
  }, ROUTER_CASE_TIMEOUT_MS);
});
