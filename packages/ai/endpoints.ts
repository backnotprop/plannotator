import { resolveModelChoice } from "@plannotator/core/model-catalog";
import type { AIContext, AIMessage, AIProvider, CreateSessionOptions } from "./types.ts";
import type { ProviderRegistry } from "./provider.ts";
import type { SessionManager } from "./session-manager.ts";
import { SessionBridgeProvider, SessionBridgeSession } from "./session-bridge.ts";
import { SESSION_BRIDGE_EVENT_PATH, SESSION_BRIDGE_POLL_PATH } from "./session-bridge-pull.ts";

export const AI_ENDPOINT_PATHS = [
  "/api/ai/capabilities",
  "/api/ai/session",
  "/api/ai/query",
  "/api/ai/abort",
  "/api/ai/permission",
  "/api/ai/sessions",
  "/api/ai/bridge/poll",
  "/api/ai/bridge/event",
] as const;

export function isLongLivedAIEndpointPath(path: string): boolean {
  return path === "/api/ai/query" || path === SESSION_BRIDGE_POLL_PATH;
}

export type AIEndpointPath = (typeof AI_ENDPOINT_PATHS)[number];

const AI_ENDPOINT_PATH_SET: ReadonlySet<string> = new Set(AI_ENDPOINT_PATHS);

export function isAIEndpointPath(path: string): path is AIEndpointPath {
  return AI_ENDPOINT_PATH_SET.has(path);
}

export interface CreateSessionRequest {
  context: AIContext;
  providerId?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  reasoningEffort?: string;
}

export interface QueryRequest {
  sessionId: string;
  prompt: string;
  contextUpdate?: string;
  busyPolicy?: "wait" | "interrupt";
  draftAnnotations?: string;
}

export interface AbortRequest {
  sessionId: string;
  reason?: "supersede";
}

export interface AIEndpointDeps {
  registry: ProviderRegistry;
  catalogRegistry?: ProviderRegistry;
  sessionManager: SessionManager;
  getCwd?: () => string;
  beforeCapabilities?: () => Promise<void> | void;
  beforeProviderSession?: (
    providerId: string,
    reason: "session" | "activate",
    requestedModel?: string,
  ) => Promise<void> | void;
  authorizeSessionBridgeRequest?: (req: Request) => boolean;
  pullBridge?: { handle(req: Request): Promise<Response> | null };
  keepRunningOnDisconnect?: boolean;
}

export const SESSION_BRIDGE_FORBIDDEN_HOST = "session_bridge_forbidden_host";

function sessionBridgeForbidden(): Response {
  return Response.json(
    {
      error:
        "Ask this session only answers pages opened on this machine (localhost, 127.0.0.1 or [::1] with this server's port).",
      code: SESSION_BRIDGE_FORBIDDEN_HOST,
    },
    { status: 403 },
  );
}

const MAX_CLIENT_MAX_TURNS = 99;
const MAX_CLIENT_BUDGET_USD = 5;

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

export function createAIEndpoints(deps: AIEndpointDeps) {
  const {
    registry,
    catalogRegistry,
    sessionManager,
    getCwd,
    beforeCapabilities,
    beforeProviderSession,
    authorizeSessionBridgeRequest,
    pullBridge,
    keepRunningOnDisconnect = false,
  } = deps;

  const liveStreams = new Map<string, Set<{ handled: boolean }>>();

  const handlePullBridge = async (req: Request): Promise<Response> => {
    if (!pullBridge) {
      return Response.json({ error: "No session bridge on this server.", code: "session_bridge_unavailable" }, { status: 404 });
    }
    if (!authorizeSessionBridgeRequest?.(req)) return sessionBridgeForbidden();
    return (await pullBridge.handle(req)) ?? Response.json({ error: "Not found" }, { status: 404 });
  };

  return {
    "/api/ai/capabilities": async (req: Request) => {
      await beforeCapabilities?.();
      const activateId = new URL(req.url).searchParams.get("activate");
      const catalogOnly = activateId && !registry.get(activateId) ? catalogRegistry?.get(activateId) : undefined;
      if (activateId && (registry.get(activateId) || catalogOnly)) {
        await beforeProviderSession?.(activateId, "activate");
      }
      const defaultEntry = registry.getDefault();
      const describe = (id: string, p: AIProvider) => ({
        id,
        name: p.name,
        capabilities: p.capabilities,
        models: p.models ?? [],
        ...(p.modelsSource ? { modelsSource: p.modelsSource } : {}),
        ...(p.toolVersion ? { toolVersion: p.toolVersion } : {}),
        ...(p.label ? { label: p.label } : {}),
        ...(p.sessionBridge ? { sessionBridge: p.sessionBridge } : {}),
      });
      const providerDetails = registry.list().map(id => describe(id, registry.get(id)!));
      return Response.json({
        available: !!defaultEntry,
        providers: providerDetails,
        defaultProvider: defaultEntry?.id ?? null,
        ...(activateId && catalogOnly ? { catalogProviders: [describe(activateId, catalogOnly)] } : {}),
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

      if (provider instanceof SessionBridgeProvider && !authorizeSessionBridgeRequest?.(req)) {
        return sessionBridgeForbidden();
      }

      try {
        await beforeProviderSession?.(providerEntry.id, "session", model);
        const models = provider.models ?? [];
        const effectiveModel = models.length > 0 ? resolveModelChoice(model ?? "", models) : model;
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
      const busyPolicy =
        body.busyPolicy === "wait" || body.busyPolicy === "interrupt" ? body.busyPolicy : undefined;
      const draftAnnotations = typeof body.draftAnnotations === "string" ? body.draftAnnotations : undefined;

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

      if (entry.session instanceof SessionBridgeSession && !authorizeSessionBridgeRequest?.(req)) {
        return sessionBridgeForbidden();
      }

      sessionManager.touch(sessionId);

      const isSessionBridge = entry.session instanceof SessionBridgeSession;

      const effectivePrompt = contextUpdate && !isSessionBridge
        ? `[Context update: the user has made changes since this conversation started]\n${contextUpdate}\n\n${prompt}`
        : prompt;
      const queryOptions = {
        ...(busyPolicy && { busyPolicy }),
        ...(isSessionBridge && draftAnnotations !== undefined && { draftAnnotations }),
      };

      if (!entry.label) {
        entry.label = prompt.slice(0, 80);
      }

      const encoder = new TextEncoder();
      const marker = { handled: false };
      let markers = liveStreams.get(sessionId);
      if (!markers) liveStreams.set(sessionId, (markers = new Set()));
      markers.add(marker);
      const forget = () => {
        markers!.delete(marker);
        if (markers!.size === 0 && liveStreams.get(sessionId) === markers) liveStreams.delete(sessionId);
      };
      let draining = false;
      const stream = new ReadableStream({
        async start(controller) {
          const send = (text: string) => {
            if (!draining) controller.enqueue(encoder.encode(text));
          };
          try {
            const messages = Object.keys(queryOptions).length > 0
              ? entry.session.query(effectivePrompt, queryOptions)
              : entry.session.query(effectivePrompt);
            for await (const message of messages) {
              send(`data: ${JSON.stringify(message)}\n\n`);
            }
            send("data: [DONE]\n\n");
          } catch (err) {
            const errorMsg: AIMessage = {
              type: "error",
              error: err instanceof Error ? err.message : String(err),
              code: "stream_error",
            };
            send(`data: ${JSON.stringify(errorMsg)}\n\n`);
          } finally {
            forget();
            if (!draining) controller.close();
          }
        },
        cancel() {
          draining = keepRunningOnDisconnect;
          forget();
          if (marker.handled || draining) return;
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

      for (const marker of liveStreams.get(body.sessionId) ?? []) marker.handled = true;
      if (body.reason === "supersede" && entry.session instanceof SessionBridgeSession) {
        entry.session.supersede();
      } else {
        entry.session.abort();
      }
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

    [SESSION_BRIDGE_POLL_PATH]: handlePullBridge,
    [SESSION_BRIDGE_EVENT_PATH]: handlePullBridge,
  } as const;
}

export type AIEndpoints = ReturnType<typeof createAIEndpoints>;
