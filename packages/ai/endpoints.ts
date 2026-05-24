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

import type { AIContext, AIMessage, CreateSessionOptions } from "./types.ts";
import type { ProviderRegistry } from "./provider.ts";
import type { SessionManager } from "./session-manager.ts";

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
  /** Reasoning effort (Codex only). */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
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
}

const MAX_CLIENT_MAX_TURNS = 99;
const MAX_CLIENT_BUDGET_USD = 5;

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
  const { registry, sessionManager, getCwd, beforeCapabilities } = deps;

  return {
    "/api/ai/capabilities": async (_req: Request) => {
      await beforeCapabilities?.();
      const defaultEntry = registry.getDefault();
      const providerDetails = registry.list().map(id => {
        const p = registry.get(id)!;
        return {
          id,
          name: p.name,
          capabilities: p.capabilities,
          models: p.models ?? [],
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
      const provider = providerId
        ? registry.get(providerId)
        : registry.getDefault()?.provider;

      if (!provider) {
        return Response.json(
          { error: providerId ? `Provider "${providerId}" not found` : "No AI provider available" },
          { status: 503 }
        );
      }

      try {
        const boundedMaxTurns = clampPositiveInteger(maxTurns, MAX_CLIENT_MAX_TURNS);
        const boundedMaxBudgetUsd = clampPositiveNumber(maxBudgetUsd, MAX_CLIENT_BUDGET_USD);
        const options: CreateSessionOptions = {
          context,
          cwd: getCwd?.(),
          model,
          ...(boundedMaxTurns !== undefined && { maxTurns: boundedMaxTurns }),
          ...(boundedMaxBudgetUsd !== undefined && { maxBudgetUsd: boundedMaxBudgetUsd }),
          reasoningEffort,
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
