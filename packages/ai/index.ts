/**
 * @plannotator/ai — AI provider layer for Plannotator.
 *
 * This package provides the backbone for AI-powered features (inline chat,
 * plan Q&A, code review assistance) across all Plannotator surfaces.
 *
 * Architecture:
 *
 *   ┌─────────────────┐     ┌──────────────┐
 *   │  Plan Review UI  │────▶│              │
 *   ├─────────────────┤     │  AI Endpoints │──▶ SSE stream
 *   │  Code Review UI  │────▶│  (HTTP)      │
 *   ├─────────────────┤     │              │
 *   │  Annotate UI     │────▶└──────┬───────┘
 *   └─────────────────┘            │
 *                                  ▼
 *                         ┌────────────────┐
 *                         │ Session Manager │
 *                         └────────┬───────┘
 *                                  │
 *                         ┌────────▼───────┐
 *                         │  AIProvider     │ (abstract)
 *                         └────────┬───────┘
 *                                  │
 *                    ┌─────────────┼──────────────┐
 *                    ▼             ▼               ▼
 *           ┌──────────────┐ ┌──────────┐  ┌───────────┐
 *           │ Claude Agent │ │ OpenCode │  │  Future   │
 *           │ SDK Provider │ │ Provider │  │ Providers │
 *           └──────────────┘ └──────────┘  └───────────┘
 *
 * Quick start:
 *
 * ```ts
 * import "@plannotator/ai/providers/claude-agent-sdk";
 * import { ProviderRegistry, createProvider, createAIEndpoints, SessionManager } from "@plannotator/ai";
 *
 * // 1. Create a registry and provider
 * const registry = new ProviderRegistry();
 * const provider = await createProvider({ type: "claude-agent-sdk", cwd: process.cwd() });
 * registry.register(provider);
 *
 * // 2. Create endpoints and session manager
 * const sessionManager = new SessionManager();
 * const aiEndpoints = createAIEndpoints({ registry, sessionManager });
 *
 * // 3. Mount endpoints in your Bun server
 * // aiEndpoints["/api/ai/query"](request) → SSE Response
 * ```
 */

// Types
export type {
  AIProvider,
  AIProviderCapabilities,
  AIProviderConfig,
  AISession,
  AIMessage,
  AITextMessage,
  AITextDeltaMessage,
  AIToolUseMessage,
  AIToolResultMessage,
  AIErrorMessage,
  AIResultMessage,
  AIPermissionRequestMessage,
  AIUnknownMessage,
  AIContext,
  AIContextMode,
  PlanContext,
  CodeReviewContext,
  AnnotateContext,
  ParentSession,
  CreateSessionOptions,
  ClaudeAgentSDKConfig,
  CodexSDKConfig,
  PiSDKConfig,
  OpenCodeConfig,
} from "./types.ts";

// Provider registry
export {
  ProviderRegistry,
  registerProviderFactory,
  createProvider,
} from "./provider.ts";

// Context builders
export { buildSystemPrompt, buildForkPreamble, buildEffectivePrompt } from "./context.ts";

// Base session
export { BaseSession } from "./base-session.ts";

// Session manager
export { SessionManager } from "./session-manager.ts";
export type { SessionEntry, SessionManagerOptions } from "./session-manager.ts";

// HTTP endpoints
export { createAIEndpoints, isAIEndpointPath } from "./endpoints.ts";
export type {
  AIEndpoints,
  AIEndpointDeps,
  CreateSessionRequest,
  QueryRequest,
  AbortRequest,
} from "./endpoints.ts";
