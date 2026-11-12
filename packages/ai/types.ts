import type { AIContext, AIContextMode, PlanContext, CodeReviewContext, AnnotateContext, ParentSession } from '@plannotator/core/ai-context';
import type { CatalogModel } from '@plannotator/core/model-catalog';
export type { AIContext, AIContextMode, PlanContext, CodeReviewContext, AnnotateContext, ParentSession, CatalogModel };

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

export const AI_ERROR_CONTEXT_WINDOW_EXCEEDED = "context_window_exceeded";

export interface AIResultMessage {
  type: "result";
  sessionId: string;
  success: boolean;
  result?: string;
  costUsd?: number;
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

export interface AIStatusMessage {
  type: "status";
  status: "waiting" | "interrupting" | "running";
}

export interface AIUnknownMessage {
  type: "unknown";
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
  | AIStatusMessage
  | AIUnknownMessage;

export interface AIQueryOptions {
  busyPolicy?: "wait" | "interrupt";
  draftAnnotations?: string;
}

export interface AISession {
  readonly id: string;

  readonly parentSessionId: string | null;

  query(prompt: string, options?: AIQueryOptions): AsyncIterable<AIMessage>;

  abort(): void;

  readonly isActive: boolean;

  respondToPermission?(requestId: string, allow: boolean, message?: string): void;

  dispose?(): void;

  onIdResolved?: (oldId: string, newId: string) => void;
}

export interface AIProviderCapabilities {
  fork: boolean;
  resume: boolean;
  streaming: boolean;
  tools: boolean;
}

export interface CreateSessionOptions {
  context: AIContext;
  cwd?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  reasoningEffort?: string;
  oneShot?: { systemPrompt: string };
}

export interface AIProvider {
  readonly name: string;

  readonly capabilities: AIProviderCapabilities;

  readonly models?: ReadonlyArray<CatalogModel>;

  readonly modelsSource?: 'fallback' | 'discovered';

  readonly toolVersion?: string;

  readonly label?: string;

  readonly sessionBridge?: {
    host: string;
    status: "ready" | "busy" | "blocked" | "gone";
    modes: { turn: boolean; transient: boolean };
    interruptible?: false;
  };

  createSession(options: CreateSessionOptions): Promise<AISession>;

  forkSession(options: CreateSessionOptions): Promise<AISession>;

  resumeSession(sessionId: string): Promise<AISession>;

  dispose(): void;
}

export interface AIProviderConfig {
  type: string;
  cwd?: string;
  model?: string;
}

export interface ClaudeAgentSDKConfig extends AIProviderConfig {
  type: "claude-agent-sdk";
  allowedTools?: string[];
  permissionMode?: "default" | "plan" | "bypassPermissions";
  claudeExecutablePath?: string;
  settingSources?: string[];
}

export interface CodexSDKConfig extends AIProviderConfig {
  type: "codex-sdk";
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  codexExecutablePath?: string;
}

export interface PiSDKConfig extends AIProviderConfig {
  type: "pi-sdk";
  piExecutablePath?: string;
}

export interface QwenSDKConfig extends AIProviderConfig {
  type: "qwen-sdk";
  qwenExecutablePath?: string;
}

export interface OpenCodeConfig extends AIProviderConfig {
  type: "opencode-sdk";
  hostname?: string;
  port?: number;
  firstEventTimeoutMs?: number;
}
