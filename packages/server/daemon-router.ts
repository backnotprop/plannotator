import {
  transition,
  type DaemonState,
  type DocMode,
  type FeedbackPayload,
} from "./state";

type JsonObject = Record<string, unknown>;

type RouterFallback = (
  req: Request,
  url: URL,
  currentState: DaemonState,
) => Response | Promise<Response | undefined> | undefined;

type TransitionHookArgs = {
  body: JsonObject;
  currentState: DaemonState;
  feedback: FeedbackPayload;
  nextState: DaemonState;
  request: Request;
};

type SubmitHookArgs = {
  body: JsonObject;
  currentState: DaemonState;
  nextState: DaemonState;
  request: Request;
  uiUrl: string;
};

type ResetHookArgs = {
  currentState: DaemonState;
  request: Request;
};

export type DaemonRouterEvent = {
  type: "awaiting-revision";
  feedback: FeedbackPayload;
  state: DaemonState;
};

export interface DaemonRouterState {
  annotateResponse?: JsonObject;
  getAnnotateResponse?: () => JsonObject;
  getPlanResponse?: () => JsonObject;
  getReviewResponse?: () => JsonObject;
  getState?: () => DaemonState;
  handleFallback?: RouterFallback;
  loadState?: () => DaemonState;
  onSubmit?: (
    args: SubmitHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onApprove?: (
    args: TransitionHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onCancel?: (
    args: TransitionHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onDeny?: (
    args: TransitionHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onFeedback?: (
    args: TransitionHookArgs,
  ) => JsonObject | void | Promise<JsonObject | void>;
  onReset?: (args: ResetHookArgs) => JsonObject | void | Promise<JsonObject | void>;
  planHtml?: string;
  planResponse?: JsonObject;
  readState?: () => DaemonState;
  reviewHtml?: string;
  reviewResponse?: JsonObject;
  saveState?: (state: DaemonState) => void;
  setState?: (state: DaemonState) => void;
  ui?: {
    planHtml?: string;
    reviewHtml?: string;
  };
  updateState?: (state: DaemonState) => void;
}

export interface DaemonRouterEventBus {
  dispatch?: (event: DaemonRouterEvent) => void;
  emit?: (event: DaemonRouterEvent) => void;
  publish?: (event: DaemonRouterEvent) => void;
  subscribe?: (
    listener: (event: DaemonRouterEvent) => void,
  ) => (() => void);
}

function getBundleHtml(
  stateAdapter: DaemonRouterState,
  mode: DocMode,
): string | undefined {
  if (mode === "review") {
    return stateAdapter.reviewHtml ?? stateAdapter.ui?.reviewHtml;
  }

  return stateAdapter.planHtml ?? stateAdapter.ui?.planHtml;
}

function readDaemonState(stateAdapter: DaemonRouterState): DaemonState {
  const reader =
    stateAdapter.getState ??
    stateAdapter.readState ??
    stateAdapter.loadState;

  if (!reader) {
    throw new Error(
      "createDaemonRouter requires a state adapter with getState(), readState(), or loadState().",
    );
  }

  return reader();
}

function writeDaemonState(
  stateAdapter: DaemonRouterState,
  nextState: DaemonState,
): void {
  const mutator = stateAdapter.setState ?? stateAdapter.updateState;
  const persister = stateAdapter.saveState;

  if (!mutator && !persister) {
    throw new Error(
      "createDaemonRouter requires a state adapter with setState(), updateState(), or saveState().",
    );
  }

  mutator?.(nextState);

  if (persister && persister !== mutator) {
    persister(nextState);
  }
}

function publishDaemonEvent(
  eventBus: DaemonRouterEventBus,
  event: DaemonRouterEvent,
): void {
  const publisher = eventBus.emit ?? eventBus.dispatch ?? eventBus.publish;
  if (!publisher) {
    throw new Error(
      "createDaemonRouter requires an event bus with emit(), dispatch(), or publish().",
    );
  }

  publisher(event);
}

function getCurrentMode(currentState: DaemonState): DocMode | null {
  return currentState.document?.mode ?? null;
}

function requireMode(
  currentState: DaemonState,
  expectedModes: DocMode[],
): Response | null {
  const currentMode = getCurrentMode(currentState);

  if (currentMode && expectedModes.includes(currentMode)) {
    return null;
  }

  const expected = expectedModes.join(" or ");
  const actual = currentMode ?? "none";

  return Response.json(
    { error: `Active mode ${actual} does not support this route. Expected ${expected}.` },
    { status: 409 },
  );
}

function getPlanPayload(stateAdapter: DaemonRouterState): JsonObject {
  return stateAdapter.getPlanResponse?.() ?? stateAdapter.planResponse ?? {};
}

function getAnnotatePayload(stateAdapter: DaemonRouterState): JsonObject {
  return (
    stateAdapter.getAnnotateResponse?.() ??
    stateAdapter.annotateResponse ??
    {}
  );
}

function getReviewPayload(stateAdapter: DaemonRouterState): JsonObject {
  return stateAdapter.getReviewResponse?.() ?? stateAdapter.reviewResponse ?? {};
}

function getRequiredDocument(currentState: DaemonState) {
  if (!currentState.document) {
    throw new Error("Daemon router requires an active document.");
  }

  return currentState.document;
}

async function readJsonBody(req: Request): Promise<JsonObject> {
  const body = await req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }

  return body as JsonObject;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toAnnotations(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry),
  );
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAwaitingRevisionState(
  state: DaemonState,
): state is Extract<DaemonState, { status: "awaiting-revision" }> {
  return state.status === "awaiting-revision";
}

function buildCancelledFeedback(message: string): FeedbackPayload {
  return {
    approved: false,
    feedback: message,
    annotations: [],
    cancelled: true,
  };
}

function resolveTransition(
  currentState: DaemonState,
  feedback: FeedbackPayload,
): DaemonState | Response {
  try {
    return transition(currentState, {
      type: "resolve",
      feedback,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 409 });
  }
}

async function applyResolution(
  stateAdapter: DaemonRouterState,
  eventBus: DaemonRouterEventBus,
  hook:
    | DaemonRouterState["onApprove"]
    | DaemonRouterState["onDeny"]
    | DaemonRouterState["onFeedback"]
    | DaemonRouterState["onCancel"],
  request: Request,
  body: JsonObject,
  feedback: FeedbackPayload,
): Promise<Response> {
  const currentState = readDaemonState(stateAdapter);
  const nextState = resolveTransition(currentState, feedback);
  if (nextState instanceof Response) {
    return nextState;
  }

  const responsePayload =
    (await hook?.({
      body,
      currentState,
      feedback,
      nextState,
      request,
    })) ?? {};

  writeDaemonState(stateAdapter, nextState);
  publishDaemonEvent(eventBus, {
    type: "awaiting-revision",
    feedback,
    state: nextState,
  });

  return Response.json({ ok: true, ...responsePayload });
}

function resolveSubmitTransition(
  currentState: DaemonState,
  document: unknown,
): DaemonState | Response {
  try {
    return transition(currentState, {
      type: "submit",
      document,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
  }
}

function resolveClearTransition(currentState: DaemonState): DaemonState | Response {
  try {
    return transition(currentState, {
      type: "clear",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 409 });
  }
}

function resolveForcedClearTransition(
  currentState: DaemonState,
): DaemonState | Response {
  return resolveTransition(
    currentState,
    buildCancelledFeedback(
      "Submission cleared before a verdict was delivered.",
    ),
  );
}

function toSseChunk(event: string, payload: JsonObject): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
  );
}

function buildVerdictPayload(
  resolvedState: Extract<DaemonState, { status: "awaiting-revision" }>,
): JsonObject {
  return {
    feedback: resolvedState.feedback,
    document: resolvedState.document,
    state: resolvedState,
  };
}

function maybeConsumeDeliveredVerdict(
  stateAdapter: DaemonRouterState,
  resolvedState: Extract<DaemonState, { status: "awaiting-revision" }>,
): void {
  const currentState = readDaemonState(stateAdapter);
  if (!isAwaitingRevisionState(currentState)) {
    return;
  }

  if (currentState.document.id !== resolvedState.document.id) {
    return;
  }

  const nextState = resolveClearTransition(currentState);
  if (nextState instanceof Response) {
    throw new Error("Delivered verdict could not be consumed.");
  }

  writeDaemonState(stateAdapter, nextState);
}

function buildCancelFeedback(
  currentState: DaemonState,
): FeedbackPayload {
  const document = currentState.document;
  const feedback =
    document?.mode === "annotate" && document.filePath
      ? `Annotation of ${document.filePath} cancelled by user.`
      : document?.mode === "review"
        ? "Code review cancelled by user."
        : "Plan review cancelled by user.";

  return {
    approved: false,
    feedback,
    annotations: [],
    cancelled: true,
  };
}

function serveActiveBundle(
  stateAdapter: DaemonRouterState,
  currentState: DaemonState,
): Response {
  const currentMode = getCurrentMode(currentState);
  if (!currentMode) {
    return Response.json(
      { error: "No active document is available." },
      { status: 409 },
    );
  }

  const html = getBundleHtml(stateAdapter, currentMode);
  if (html === undefined) {
    throw new Error(`Missing UI bundle for daemon mode ${currentMode}`);
  }

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

export function createDaemonRouter(
  stateAdapter: DaemonRouterState,
  eventBus: DaemonRouterEventBus,
) {
  return {
    async fetch(
      req: Request,
      server?: { timeout?: (request: Request, seconds: number) => void },
    ): Promise<Response> {
      const url = new URL(req.url);
      const currentState = readDaemonState(stateAdapter);

      if (url.pathname === "/") {
        return serveActiveBundle(stateAdapter, currentState);
      }

      if (url.pathname === "/api/state" && req.method === "GET") {
        return Response.json(currentState);
      }

      if (url.pathname === "/api/submit" && req.method === "POST") {
        if (currentState.status !== "idle" && currentState.status !== "awaiting-revision") {
          return Response.json(
            {
              error: `Daemon cannot accept a new submission while state is ${currentState.status}.`,
            },
            { status: 409 },
          );
        }

        const body = await readJsonBody(req).catch(() => ({}));
        if (!isRecord(body.document)) {
          return Response.json(
            { error: "submit requires a document object." },
            { status: 400 },
          );
        }

        const nextState = resolveSubmitTransition(currentState, body.document);
        if (nextState instanceof Response) {
          return nextState;
        }

        const uiUrl = new URL("/", req.url).toString();
        const responsePayload =
          (await stateAdapter.onSubmit?.({
            body,
            currentState,
            nextState,
            request: req,
            uiUrl,
          })) ?? {};

        writeDaemonState(stateAdapter, nextState);

        return Response.json(
          { ok: true, state: nextState, url: uiUrl, ...responsePayload },
          { status: 202 },
        );
      }

      if (url.pathname === "/api/plan" && req.method === "GET") {
        const modeMismatch = requireMode(currentState, ["plan", "annotate"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const document = getRequiredDocument(currentState);
        if (document.mode === "annotate") {
          return Response.json({
            plan: document.content,
            origin: document.origin,
            mode: "annotate",
            filePath: document.filePath,
            ...getAnnotatePayload(stateAdapter),
          });
        }

        return Response.json({
          plan: document.content,
          origin: document.origin,
          ...getPlanPayload(stateAdapter),
        });
      }

      if (url.pathname === "/api/diff" && req.method === "GET") {
        const modeMismatch = requireMode(currentState, ["review"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const document = getRequiredDocument(currentState);
        return Response.json({
          rawPatch: document.content,
          gitRef: document.gitRef,
          origin: document.origin,
          ...getReviewPayload(stateAdapter),
        });
      }

      if (url.pathname === "/api/wait" && req.method === "GET") {
        const requestId = url.searchParams.get("requestId") ?? undefined;

        if (currentState.status === "idle") {
          return Response.json(
            { error: "No active or buffered daemon verdict is available.", code: "verdict_consumed_or_unknown" },
            { status: 409 },
          );
        }

        // D2: in resolved (verdict_ready), plain wait without requestId is a stale-verdict
        // risk — a later unrelated command could inadvertently consume an old verdict.
        // Only an exact-ID waiter may recover the buffered verdict.
        if (currentState.status === "awaiting-revision") {
          if (!requestId) {
            return Response.json(
              {
                error:
                  "Cannot deliver buffered verdict without a requestId. Use: plannotator wait --request-id " +
                  currentState.document.id,
                code: "illegal_state",
                activeRequestId: currentState.document.id,
                recovery: "plannotator wait --request-id " + currentState.document.id,
              },
              { status: 409 },
            );
          }
          if (requestId !== currentState.document.id) {
            return Response.json(
              {
                error: `requestId mismatch: active request is ${currentState.document.id}.`,
                code: "request_id_mismatch",
                activeRequestId: currentState.document.id,
              },
              { status: 409 },
            );
          }
          // Correct requestId: fall through to SSE delivery below.
        }

        // D2: in awaiting-response (in_review), validate requestId if provided.
        if (currentState.status === "awaiting-response" && requestId && requestId !== currentState.document.id) {
          return Response.json(
            {
              error: `requestId mismatch: active request is ${currentState.document.id}.`,
              code: "request_id_mismatch",
              activeRequestId: currentState.document.id,
            },
            { status: 409 },
          );
        }

        const subscribe = eventBus.subscribe;
        if (!subscribe) {
          throw new Error(
            "createDaemonRouter requires an event bus with subscribe() for /api/wait.",
          );
        }

        server?.timeout?.(req, 0);

        let unsubscribe = () => {};
        let closed = false;
        let detachAbortHandler = () => {};

        const stream = new ReadableStream({
          start(controller) {
            const cleanup = () => {
              if (closed) {
                return;
              }

              closed = true;
              unsubscribe();
              detachAbortHandler();
            };

            const finish = () => {
              cleanup();
              controller.close();
            };

            const handleAbort = () => {
              cleanup();
            };

            if (req.signal.aborted) {
              handleAbort();
              return;
            }

            req.signal.addEventListener("abort", handleAbort, { once: true });
            detachAbortHandler = () => {
              req.signal.removeEventListener("abort", handleAbort);
            };

            const deliver = (
              resolvedState: Extract<DaemonState, { status: "awaiting-revision" }>,
            ) => {
              if (closed) {
                return;
              }

              try {
                controller.enqueue(
                  toSseChunk("verdict", buildVerdictPayload(resolvedState)),
                );
              } catch {
                cleanup();
                return;
              }

              // Don't auto-clear after delivering verdict - state should stay resolved
              // until user submits revision or explicitly clears
              // maybeConsumeDeliveredVerdict(stateAdapter, resolvedState);
              finish();
            };

            if (isAwaitingRevisionState(currentState)) {
              deliver(currentState);
              return;
            }

            controller.enqueue(new TextEncoder().encode(": connected\n\n"));

            unsubscribe = subscribe((event) => {
              if (event.type !== "awaiting-revision") {
                return;
              }

              deliver(event.state);
            });
          },
          cancel() {
            if (closed) {
              return;
            }

            closed = true;
            unsubscribe();
            detachAbortHandler();
          },
        });

        return new Response(stream, {
          headers: {
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream",
          },
        });
      }

      if (url.pathname === "/api/approve" && req.method === "POST") {
        const modeMismatch = requireMode(currentState, ["plan"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const body = await readJsonBody(req).catch(() => ({}));
        const feedback: FeedbackPayload = {
          approved: true,
          feedback: toStringValue(body.feedback) ?? "",
          annotations: toAnnotations(body.annotations),
          agentSwitch: toStringValue(body.agentSwitch),
          permissionMode: toStringValue(body.permissionMode),
        };

        return applyResolution(
          stateAdapter,
          eventBus,
          stateAdapter.onApprove,
          req,
          body,
          feedback,
        );
      }

      if (url.pathname === "/api/deny" && req.method === "POST") {
        const modeMismatch = requireMode(currentState, ["plan"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const body = await readJsonBody(req).catch(() => ({}));
        const feedback: FeedbackPayload = {
          approved: false,
          feedback: toStringValue(body.feedback) ?? "Plan rejected by user",
          annotations: [],
        };

        return applyResolution(
          stateAdapter,
          eventBus,
          stateAdapter.onDeny,
          req,
          body,
          feedback,
        );
      }

      if (url.pathname === "/api/feedback" && req.method === "POST") {
        const modeMismatch = requireMode(currentState, ["review", "annotate"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        try {
          const body = await readJsonBody(req);
          const feedback: FeedbackPayload = {
            approved:
              currentState.document?.mode === "review"
                ? Boolean(body.approved)
                : false,
            feedback: toStringValue(body.feedback) ?? "",
            annotations: toAnnotations(body.annotations),
            agentSwitch: toStringValue(body.agentSwitch),
          };

          return applyResolution(
            stateAdapter,
            eventBus,
            stateAdapter.onFeedback,
            req,
            body,
            feedback,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to process feedback";
          return Response.json({ error: message }, { status: 500 });
        }
      }

      if (url.pathname === "/api/cancel" && req.method === "POST") {
        const modeMismatch = requireMode(currentState, ["plan", "review", "annotate"]);
        if (modeMismatch) {
          return modeMismatch;
        }

        const feedback = buildCancelFeedback(currentState);

        return applyResolution(
          stateAdapter,
          eventBus,
          stateAdapter.onCancel,
          req,
          {},
          feedback,
        );
      }

      if (url.pathname === "/api/clear" && req.method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        const force = body.force === true;

        if (currentState.status === "idle") {
          return Response.json(
            { error: "Daemon state is already idle." },
            { status: 409 },
          );
        }

        if (currentState.status === "awaiting-response") {
          if (!force) {
            return Response.json(
              {
                error:
                  "Refusing to clear an in-flight submission without { force: true }.",
              },
              { status: 409 },
            );
          }

          const nextState = resolveForcedClearTransition(currentState);
          if (nextState instanceof Response) {
            return nextState;
          }

          writeDaemonState(stateAdapter, nextState);
          publishDaemonEvent(eventBus, {
            type: "awaiting-revision",
            feedback: nextState.feedback,
            state: nextState,
          });

          return Response.json({
            ok: true,
            forced: true,
            state: nextState,
          });
        }

        const nextState = resolveClearTransition(currentState);
        if (nextState instanceof Response) {
          return nextState;
        }

        writeDaemonState(stateAdapter, nextState);
        return Response.json({ ok: true, state: nextState });
      }

      if (url.pathname === "/api/reset" && req.method === "POST") {
        await stateAdapter.onReset?.({
          currentState,
          request: req,
        });

        return Response.json({ ok: true });
      }

      const fallbackResponse = await stateAdapter.handleFallback?.(
        req,
        url,
        currentState,
      );
      if (fallbackResponse) {
        return fallbackResponse;
      }

      if (url.pathname.startsWith("/api/")) {
        return new Response("Not Found", { status: 404 });
      }

      return serveActiveBundle(stateAdapter, currentState);
    },
  };
}
