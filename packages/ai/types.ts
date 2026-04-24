/**
 * Core types for the Plannotator AI provider layer.
 *
 * This module defines the abstract interfaces that any agent runtime
 * (Claude Agent SDK, OpenCode, future providers) must implement to
 * power AI features inside Plannotator's plan review and code review UIs.
 */

// ---------------------------------------------------------------------------
// Context — what the AI session knows about
// ---------------------------------------------------------------------------

/** The surface the user is interacting with when they invoke AI. */
export type AIContextMode = "plan-review" | "code-review" | "annotate";

/**
 * Describes the parent agent session that originally produced the plan or diff.
 * Used to fork conversations with full history.
 */
export interface ParentSession {
  /** Session ID from the host agent (e.g. Claude Code session UUID). */
  sessionId: string;
  /** Working directory the parent session was running in. */
  cwd: string;
}

/**
 * Snapshot of plan-review-specific context.
 * Passed when AIContextMode is "plan-review".
 */
export interface PlanContext {
  /** The full plan markdown as submitted by the agent. */
  plan: string;
  /** Previous plan version (if this is a resubmission). */
  previousPlan?: string;
  /** The version number in the plan's history. */
  version?: number;
  /** Annotations the user has made so far (serialised for the prompt). */
  annotations?: string;
}

/**
 * Snapshot of code-review-specific context.
 * Passed when AIContextMode is "code-review".
 */
export interface CodeReviewContext {
  /** The unified diff patch. */
  patch: string;
  /** The specific file being discussed (if scoped). */
  filePath?: string;
  /** The line range being discussed (if scoped). */
  lineRange?: { start: number; end: number; side: "old" | "new" };
  /** The code snippet being discussed (if scoped). */
  selectedCode?: string;
  /** Summary of annotations the user has made. */
  annotations?: string;
}

/**
 * Snapshot of annotate-mode context.
 * Passed when AIContextMode is "annotate".
 */
export interface AnnotateContext {
  /** The markdown file content being annotated. */
  content: string;
  /** Path to the file on disk. */
  filePath: string;
  /** Summary of annotations the user has made. */
  annotations?: string;
}

/**
 * Union of mode-specific contexts, discriminated by `mode`.
 */
export type AIContext =
  | { mode: "plan-review"; plan: PlanContext; parent?: ParentSession }
  | { mode: "code-review"; review: CodeReviewContext; parent?: ParentSession }
  | { mode: "annotate"; annotate: AnnotateContext; parent?: ParentSession };

// ---------------------------------------------------------------------------
// Messages — what streams back from the AI
// ---------------------------------------------------------------------------

export interface AITextMessage {
  type: "text";
  text: string;
}

export interface AITextDeltaMessage {
  type: "text_delta";
  delta: string;
}

export interface AIToolUseMessage {
  type: "tool_use";
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
}

export interface AIToolResultMessage {
  type: "tool_result";
  toolUseId?: string;
  result: string;
}

export interface AIErrorMessage {
  type: "error";
  error: string;
  code?: string;
}

export interface AIResultMessage {
  type: "result";
  sessionId: string;
  success: boolean;
  /** The final text result (if success). */
  result?: string;
  /** Total cost in USD (if available). */
  costUsd?: number;
  /** Number of agentic turns used. */
  turns?: number;
}

export interface AIPermissionRequestMessage {
  type: "permission_request";
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  toolUseId: string;
}

export interface AIUnknownMessage {
  type: "unknown";
  /** The raw message from the provider, for debugging/transparency. */
  raw: Record<string, unknown>;
}

export type AIMessage =
  | AITextMessage
  | AITextDeltaMessage
  | AIToolUseMessage
  | AIToolResultMessage
  | AIErrorMessage
  | AIResultMessage
  | AIPermissionRequestMessage
  | AIUnknownMessage;

// ---------------------------------------------------------------------------
// Session — a live conversation with the AI
// ---------------------------------------------------------------------------

export interface AISession {
  /** Unique identifier for this session. */
  readonly id: string;

  /**
   * The parent session this was forked from, if any.
   * Null for fresh sessions.
   */
  readonly parentSessionId: string | null;

  /**
   * Send a prompt and stream back messages.
   * The returned async iterable yields messages as they arrive.
   */
  query(prompt: string): AsyncIterable<AIMessage>;

  /**
   * Abort the current in-flight query.
   * Safe to call if no query is running (no-op).
   */
  abort(): void;

  /** Whether a query is currently in progress. */
  readonly isActive: boolean;

  /**
   * Respond to a permission request from the provider.
   * Called when the user approves or denies a tool use in the UI.
   */
  respondToPermission?(requestId: string, allow: boolean, message?: string): void;

  /**
   * Callback invoked when the real session ID is resolved from the provider.
   * Set by the SessionManager to remap its internal tracking key.
   */
  onIdResolved?: (oldId: string, newId: string) => void;
}

// ---------------------------------------------------------------------------
// Provider — the pluggable backend
// ---------------------------------------------------------------------------

export interface AIProviderCapabilities {
  /** Whether the provider supports forking from a parent session. */
  fork: boolean;
  /** Whether the provider supports resuming a prior session by ID. */
  resume: boolean;
  /** Whether the provider streams partial text deltas. */
  streaming: boolean;
  /** Whether the provider can execute tools (read files, search, etc.). */
  tools: boolean;
}

export interface CreateSessionOptions {
  /** The context (plan, diff, file) to seed the session with. */
  context: AIContext;
  /**
   * Working directory override for the agent session.
   * Falls back to the provider's configured cwd if omitted.
   */
  cwd?: string;
  /**
   * Model override. Provider-specific string.
   * Falls back to provider default if omitted.
   */
  model?: string;
  /**
   * Maximum agentic turns for the session.
   * Keeps inline chat cost-bounded.
   */
  maxTurns?: number;
  /**
   * Maximum budget in USD for this session.
   */
  maxBudgetUsd?: number;
  /**
   * Reasoning effort level (Codex only).
   * Controls how much thinking the model does before responding.
   */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}

/**
 * An AI provider implements the bridge between Plannotator and a specific
 * agent runtime. The provider is responsible for:
 *
 * 1. Creating new AI sessions seeded with review context
 * 2. Forking from parent agent sessions to maintain conversation history
 * 3. Streaming responses back as AIMessage events
 *
 * Providers are registered by name and selected at runtime based on the
 * host environment (Claude Code → "claude-agent-sdk", OpenCode → "opencode-sdk").
 */
export interface AIProvider {
  /** Unique name for this provider (e.g. "claude-agent-sdk"). */
  readonly name: string;

  /** What this provider can do. */
  readonly capabilities: AIProviderCapabilities;

  /** Available models for this provider. */
  readonly models?: ReadonlyArray<{ id: string; label: string; default?: boolean }>;

  /**
   * Create a fresh session (no parent history).
   * Context is injected via the system prompt.
   */
  createSession(options: CreateSessionOptions): Promise<AISession>;

  /**
   * Fork from a parent agent session.
   *
   * The new session inherits the parent's full conversation history
   * (files read, analysis performed, decisions made) and additionally
   * receives the Plannotator review context. This enables the user to
   * ask contextual questions like "why did you change this function?"
   * without the AI losing insight.
   *
   * Providers that don't support real forking MUST throw. The endpoint
   * layer checks `capabilities.fork` before calling this, so it should
   * only be reached by providers that genuinely support history inheritance.
   */
  forkSession(options: CreateSessionOptions): Promise<AISession>;

  /**
   * Resume a previously created Plannotator AI session by its ID.
   * Used when the user returns to a conversation they started earlier.
   *
   * If the provider doesn't support resuming, this should throw.
   */
  resumeSession(sessionId: string): Promise<AISession>;

  /**
   * Clean up any resources held by the provider.
   * Called when the server shuts down.
   */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

/**
 * Configuration passed to a provider factory.
 * Each provider type may extend this with its own fields.
 */
export interface AIProviderConfig {
  /** Provider type identifier (matches AIProvider.name). */
  type: string;
  /** Working directory for the agent. */
  cwd?: string;
  /** Default model to use. */
  model?: string;
}

export interface ClaudeAgentSDKConfig extends AIProviderConfig {
  type: "claude-agent-sdk";
  /**
   * Tools the AI session is allowed to use.
   * Defaults to read-only tools for safety in inline chat.
   */
  allowedTools?: string[];
  /**
   * Permission mode for the session.
   * Defaults to "default" (inherits user's existing permission rules).
   */
  permissionMode?: "default" | "plan" | "bypassPermissions";
  /**
   * Explicit path to the claude CLI binary.
   * Required when running inside a compiled binary where PATH resolution
   * doesn't work the same way (e.g., bun build --compile).
   */
  claudeExecutablePath?: string;
  /**
   * Setting sources to load permission rules from.
   * Loads user's existing Claude Code permission rules so inline chat
   * inherits what they've already approved.
   */
  settingSources?: string[];
}

export interface CodexSDKConfig extends AIProviderConfig {
  type: "codex-sdk";
  /**
   * Sandbox mode controls what the Codex agent can do.
   * Defaults to "read-only" for safety in inline chat.
   */
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  /**
   * Explicit path to the codex CLI binary.
   * Required when running inside a compiled binary where PATH resolution
   * doesn't work the same way (e.g., bun build --compile).
   */
  codexExecutablePath?: string;
}

export interface PiSDKConfig extends AIProviderConfig {
  type: "pi-sdk";
  /**
   * Explicit path to the pi CLI binary.
   * Required when running inside a compiled binary where PATH resolution
   * doesn't work the same way (e.g., bun build --compile).
   */
  piExecutablePath?: string;
}

export interface OpenCodeConfig extends AIProviderConfig {
  type: "opencode-sdk";
  /** Hostname for the OpenCode server. Default: "127.0.0.1". */
  hostname?: string;
  /** Port for the OpenCode server. Default: 4096. */
  port?: number;
}
