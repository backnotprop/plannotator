/**
 * HTTP endpoint handlers for AI features.
 *
 * These handlers are provider-agnostic — they work with whatever AIProvider
 * is registered in the provided ProviderRegistry. They're designed to be
 * mounted into any Plannotator server (plan review, code review, annotate).
 *
 * Endpoints:
 *   POST /api/ai/session       — Create or fork an AI session
 *   POST /api/ai/query         — Send a message and stream the response
 *   POST /api/ai/abort         — Abort the current query
 *   GET  /api/ai/sessions      — List active sessions
 *   GET  /api/ai/capabilities  — Check if AI features are available
 */

import { resolveModelChoice } from "@plannotator/core/model-catalog";
import type { AIContext, AIMessage, AIProvider, CreateSessionOptions } from "./types.ts";
import type { ProviderRegistry } from "./provider.ts";
import type { SessionManager } from "./session-manager.ts";

/** Canonical paths handled by the shared AI endpoint runtime. */
export const AI_ENDPOINT_PATHS = [
  "/api/ai/capabilities",
  "/api/ai/session",
  "/api/ai/query",
  "/api/ai/abort",
  "/api/ai/permission",
  "/api/ai/sessions",
] as const;

/** A path handled by the shared AI endpoint runtime. */
export type AIEndpointPath = (typeof AI_ENDPOINT_PATHS)[number];

const AI_ENDPOINT_PATH_SET: ReadonlySet<string> = new Set(AI_ENDPOINT_PATHS);

/** Return whether a request path is a known shared AI endpoint. */
export function isAIEndpointPath(path: string): path is AIEndpointPath {
  return AI_ENDPOINT_PATH_SET.has(path);
}

// ---------------------------------------------------------------------------
// Types for request/response
// ---------------------------------------------------------------------------

export interface CreateSessionRequest {
  /** The context mode and content for the session. */
  context: AIContext;
  /** Instance ID of the provider to use (optional — uses default if omitted). */
  providerId?: string;
  /** Optional model override. */
  model?: string;
  /** Max agentic turns. */
  maxTurns?: number;
  /** Max budget in USD. */
  maxBudgetUsd?: number;
  /** Reasoning effort — one of the selected model's `reasoningEfforts`. */
  reasoningEffort?: string;
}

export interface QueryRequest {
  /** The session ID to query. */
  sessionId: string;
  /** The user's prompt/question. */
  prompt: string;
  /** Optional context update (e.g., new annotations since session was created). */
  contextUpdate?: string;
}

export interface AbortRequest {
  /** The session ID to abort. */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface AIEndpointDeps {
  /** Provider registry (one per server or shared). */
  registry: ProviderRegistry;
  /** Session manager instance (one per server). */
  sessionManager: SessionManager;
  /** Resolve the current working directory for new AI sessions. */
  getCwd?: () => string;
  /** Optional hook to finish lazy provider capability loading before reporting capabilities. */
  beforeCapabilities?: () => Promise<void> | void;
  /**
   * Optional hook to run provider-specific lazy initialization, either before
   * creating a session (`session`) or for an explicit `?activate=` probe
   * (`activate`, which reports the refreshed model list and so must wait).
   */
  beforeProviderSession?: (
    providerId: string,
    reason: "session" | "activate",
    requestedModel?: string,
  ) => Promise<void> | void;
}

const MAX_CLIENT_MAX_TURNS = 99;
const MAX_CLIENT_BUDGET_USD = 5;

/**
 * Run a lazy initializer (model discovery) at most once on success. Callers
 * share one in-flight run and never see its error; a failed run may be retried
 * by a later call once `retryAfterMs` has passed, so a transient failure does
 * not pin the fallback for the life of the process while a persistently
 * broken tool is not re-spawned on every session.
 */
export function createBestEffortOnce(
  initialize: () => Promise<void>,
  retryAfterMs = 60_000,
): () => Promise<void> {
  let result: Promise<void> | null = null;
  let failedAt = 0;
  return () => {
    if (result === null || (failedAt && Date.now() - failedAt >= retryAfterMs)) {
      failedAt = 0;
      result = initialize().catch(() => {
        failedAt = Date.now();
      });
    }
    return result;
  };
}

/**
 * Deferred model discovery shared by both runtimes. Discovery spawns the
 * provider's CLI, so it runs on first explicit activation (?activate= from a
 * model picker) or the first session, never at startup. An `?activate=` probe
 * always waits for it (it reports the refreshed list). A session waits only
 * for providers registered with `blockSession` (the default); the others
 * resolve the model against their current list and let discovery finish in
 * the background — unless that list is still the static fallback and does not
 * offer the requested model (e.g. `opus[1m]`, which the fallback lacks), where
 * resolving now would silently change the pick for the first session only, so
 * the session waits for discovery (bounded by the provider's own timeout).
 */
export function createDeferredModelDiscovery() {
  const initializers = new Map<string, () => Promise<void>>();
  const background = new Map<string, Pick<AIProvider, "models" | "modelsSource">>();
  return {
    defer(providerId: string, provider: object | null | undefined, { blockSession = true }: { blockSession?: boolean } = {}) {
      if (!provider || !("fetchModels" in provider)) return;
      const fetchModels = provider.fetchModels as () => Promise<void>;
      initializers.set(providerId, createBestEffortOnce(() => fetchModels.call(provider)));
      if (!blockSession) background.set(providerId, provider as Pick<AIProvider, "models" | "modelsSource">);
    },
    async beforeProviderSession(providerId: string, reason: "session" | "activate", requestedModel?: string): Promise<void> {
      const initialize = initializers.get(providerId);
      if (!initialize) return;
      const provider = background.get(providerId);
      if (reason === "session" && provider) {
        const pickOnFallbackOnly =
          !!requestedModel &&
          provider.modelsSource === "fallback" &&
          !(provider.models ?? []).some((m) => m.id === requestedModel);
        if (!pickOnFallbackOnly) {
          void initialize();
          return;
        }
      }
      await initialize();
    },
  };
}

function clampPositiveInteger(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function clampPositiveNumber(value: unknown, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(max, value);
}

/**
 * Create the route handler map for AI endpoints.
 *
 * Usage in a Bun server:
 * ```ts
 * const aiHandlers = createAIEndpoints({ registry, sessionManager });
 *
 * // In your request handler:
 * if (url.pathname.startsWith('/api/ai/')) {
 *   const handler = aiHandlers[url.pathname];
 *   if (handler) return handler(req);
 * }
 * ```
 */
export function createAIEndpoints(deps: AIEndpointDeps) {
  const {
    registry,
    sessionManager,
    getCwd,
    beforeCapabilities,
    beforeProviderSession,
  } = deps;

  return {
    "/api/ai/capabilities": async (req: Request) => {
      await beforeCapabilities?.();
      // Explicit provider activation (?activate=<providerId>): run the same
      // deferred initializer the session path uses, then report the refreshed
      // metadata — so the client's model picker can move past a provider's
      // static fallback without creating a session. A plain capabilities
      // probe must never activate anything: the editor calls it automatically
      // on load, and activating there would reintroduce the eager launch this
      // deferral exists to prevent.
      const activateId = new URL(req.url).searchParams.get("activate");
      if (activateId && registry.get(activateId)) {
        await beforeProviderSession?.(activateId, "activate");
      }
      const defaultEntry = registry.getDefault();
      const providerDetails = registry.list().map(id => {
        const p = registry.get(id)!;
        return {
          id,
          name: p.name,
          capabilities: p.capabilities,
          models: p.models ?? [],
          ...(p.modelsSource ? { modelsSource: p.modelsSource } : {}),
          ...(p.toolVersion ? { toolVersion: p.toolVersion } : {}),
        };
      });
      return Response.json({
        available: !!defaultEntry,
        providers: providerDetails,
        defaultProvider: defaultEntry?.id ?? null,
      });
    },

    "/api/ai/session": async (req: Request) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = (await req.json()) as CreateSessionRequest;
      const { context, providerId, model, maxTurns, maxBudgetUsd, reasoningEffort } = body;

      if (!context?.mode) {
        return Response.json(
          { error: "Missing context.mode" },
          { status: 400 }
        );
      }

      // Resolve provider: by ID, or default
      const providerEntry = providerId
        ? { id: providerId, provider: registry.get(providerId) }
        : registry.getDefault();
      const provider = providerEntry?.provider;

      if (!provider) {
        return Response.json(
          { error: providerId ? `Provider "${providerId}" not found` : "No AI provider available" },
          { status: 503 }
        );
      }

      try {
        await beforeProviderSession?.(providerEntry.id, "session", model);
        // Resolve the model against the post-activation list with the shared
        // resolver (exact id → the model an alias covers → same-family alias →
        // the provider's default), so a stale pre-discovery pick lands on the
        // closest current model. Providers that report no models pass the
        // request through verbatim.
        const models = provider.models ?? [];
        const effectiveModel = models.length > 0 ? resolveModelChoice(model ?? "", models) : model;
        // Only forward an effort the resolved model accepts (a model that
        // reports no efforts takes none); unlisted models pass it through.
        const modelInfo = models.find((candidate) => candidate.id === effectiveModel);
        const effectiveEffort =
          reasoningEffort && (!modelInfo || modelInfo.reasoningEfforts?.some((e) => e.id === reasoningEffort))
            ? reasoningEffort
            : undefined;
        const boundedMaxTurns = clampPositiveInteger(maxTurns, MAX_CLIENT_MAX_TURNS);
        const boundedMaxBudgetUsd = clampPositiveNumber(maxBudgetUsd, MAX_CLIENT_BUDGET_USD);
        const options: CreateSessionOptions = {
          context,
          cwd: getCwd?.(),
          model: effectiveModel,
          ...(boundedMaxTurns !== undefined && { maxTurns: boundedMaxTurns }),
          ...(boundedMaxBudgetUsd !== undefined && { maxBudgetUsd: boundedMaxBudgetUsd }),
          reasoningEffort: effectiveEffort,
        };

        // Fork if parent session is provided AND provider supports it.
        // Providers that can't fork (e.g. Codex) fall back to a fresh
        // session with the full system prompt — no fake history.
        const shouldFork = context.parent && provider.capabilities.fork;
        const session = shouldFork
          ? await provider.forkSession(options)
          : await provider.createSession(options);

        const entry = sessionManager.track(session, context.mode);

        return Response.json({
          sessionId: session.id,
          parentSessionId: session.parentSessionId,
          mode: context.mode,
          createdAt: entry.createdAt,
        });
      } catch (err) {
        return Response.json(
          {
            error:
              err instanceof Error ? err.message : "Failed to create session",
          },
          { status: 500 }
        );
      }
    },

    "/api/ai/query": async (req: Request) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = (await req.json()) as QueryRequest;
      const { sessionId, prompt, contextUpdate } = body;

      if (!sessionId || !prompt) {
        return Response.json(
          { error: "Missing sessionId or prompt" },
          { status: 400 }
        );
      }

      const entry = sessionManager.get(sessionId);
      if (!entry) {
        return Response.json(
          { error: "Session not found" },
          { status: 404 }
        );
      }

      sessionManager.touch(sessionId);

      // If context update provided, prepend it to the prompt
      const effectivePrompt = contextUpdate
        ? `[Context update: the user has made changes since this conversation started]\n${contextUpdate}\n\n${prompt}`
        : prompt;

      // Set label from first query if not already set
      if (!entry.label) {
        entry.label = prompt.slice(0, 80);
      }

      // Stream the response using Server-Sent Events (SSE)
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for await (const message of entry.session.query(effectivePrompt)) {
              const data = JSON.stringify(message);
              controller.enqueue(
                encoder.encode(`data: ${data}\n\n`)
              );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch (err) {
            const errorMsg: AIMessage = {
              type: "error",
              error: err instanceof Error ? err.message : String(err),
              code: "stream_error",
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(errorMsg)}\n\n`)
            );
          } finally {
            controller.close();
          }
        },
        cancel() {
          // Client disconnected (Stop fetch abort, superseding question, tab
          // close, navigation). Stop the in-flight turn so it doesn't keep
          // running on the now long-lived provider process.
          entry.session.abort();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },

    "/api/ai/abort": async (req: Request) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = (await req.json()) as AbortRequest;
      const entry = sessionManager.get(body.sessionId);
      if (!entry) {
        return Response.json(
          { error: "Session not found" },
          { status: 404 }
        );
      }

      entry.session.abort();
      return Response.json({ ok: true });
    },

    "/api/ai/permission": async (req: Request) => {
      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = (await req.json()) as {
        sessionId: string;
        requestId: string;
        allow: boolean;
        message?: string;
      };

      if (!body.sessionId || !body.requestId) {
        return Response.json(
          { error: "Missing sessionId or requestId" },
          { status: 400 }
        );
      }

      const entry = sessionManager.get(body.sessionId);
      if (!entry) {
        return Response.json(
          { error: "Session not found" },
          { status: 404 }
        );
      }

      entry.session.respondToPermission?.(
        body.requestId,
        body.allow,
        body.message
      );

      return Response.json({ ok: true });
    },

    "/api/ai/sessions": async (_req: Request) => {
      const entries = sessionManager.list();
      return Response.json(
        entries.map((e) => ({
          sessionId: e.session.id,
          mode: e.mode,
          parentSessionId: e.parentSessionId,
          createdAt: e.createdAt,
          lastActiveAt: e.lastActiveAt,
          isActive: e.session.isActive,
          label: e.label,
        }))
      );
    },
  } as const;
}

export type AIEndpoints = ReturnType<typeof createAIEndpoints>;
