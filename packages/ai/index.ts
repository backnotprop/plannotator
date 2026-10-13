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
  AIStatusMessage,
  AIQueryOptions,
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

// "Ask this session" bridge
export {
  SessionBridgeProvider,
  SessionBridgeSession,
  SESSION_BRIDGE_PROVIDER_NAME,
  SESSION_BRIDGE_ERROR,
  SESSION_ASK_HEADER,
  SESSION_ASK_TRANSIENT_NOTE,
  SESSION_ASK_TAKEN_OVER_TEXT,
  SESSION_ASK_TAKEN_OVER_BY_PERSON_TEXT,
  SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT,
  formatSessionAskText,
  sessionBridgeLabel,
} from "./session-bridge.ts";
export type {
  SessionBridge,
  SessionBridgeAskMode,
  SessionBridgeAskRequest,
  SessionBridgeErrorCode,
  SessionBridgeHost,
  SessionBridgeInfo,
  SessionBridgeSink,
  SessionBridgeStatus,
} from "./session-bridge.ts";

// "Ask this session" pull bridge (hosts that run the server as a separate process)
export {
  createPullSessionBridge,
  takePullSessionBridgeConfig,
  parseSessionBridgeModes,
  SESSION_BRIDGE_POLL_PATH,
  SESSION_BRIDGE_EVENT_PATH,
  SESSION_BRIDGE_TOKEN_ENV,
  SESSION_BRIDGE_HOST_ENV,
  SESSION_BRIDGE_MODES_ENV,
  SESSION_BRIDGE_MAX_POLL_MS,
  SESSION_BRIDGE_POLL_FEATURES,
} from "./session-bridge-pull.ts";
export type {
  BridgeCommand,
  BridgeHostEvent,
  PullSessionBridge,
  PullSessionBridgeConfig,
  PullSessionBridgeOptions,
} from "./session-bridge-pull.ts";

// Session manager
export { SessionManager } from "./session-manager.ts";
export type { SessionEntry, SessionManagerOptions } from "./session-manager.ts";

// HTTP endpoints
export {
  createAIEndpoints,
  createBestEffortOnce,
  createDeferredModelDiscovery,
  isAIEndpointPath,
  isLongLivedAIEndpointPath,
  SESSION_BRIDGE_FORBIDDEN_HOST,
} from "./endpoints.ts";
export type {
  AIEndpoints,
  AIEndpointDeps,
  CreateSessionRequest,
  QueryRequest,
  AbortRequest,
} from "./endpoints.ts";
