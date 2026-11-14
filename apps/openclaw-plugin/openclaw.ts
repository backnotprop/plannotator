import { createHash } from "node:crypto";

export const OPENCLAW_PLUGIN_ID = "plannotator";
export const OPENCLAW_PLUGIN_PACKAGE = "@plannotator/openclaw";
export const OPENCLAW_INBOX_HOST = "openclaw";
export const OPENCLAW_INBOX_AGENT_NAME = "OpenClaw";
export const OPENCLAW_SOURCE_COMMIT = "00ac159ff5d603512de55455eb277815b2263cca";

export interface OpenClawLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface OpenClawDeliveryContext {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}

export interface OpenClawInputProvenance {
  kind: "external_user" | "inter_session" | "internal_system";
  sourceTool?: string;
}

export interface OpenClawToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageChannel?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  deliveryContext?: OpenClawDeliveryContext;
  inputProvenance?: OpenClawInputProvenance;
  backgroundRun?: { sourceSessionKey: string; ownerPluginId?: string };
}

export interface OpenClawToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
}

export interface OpenClawTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: unknown, signal?: AbortSignal): Promise<OpenClawToolResult>;
}

export type OpenClawToolFactory = (ctx: OpenClawToolContext) => OpenClawTool | null | undefined;

export interface OpenClawSessionEventReceipt {
  id: string;
  cancel: () => boolean;
  accepted: Promise<{ ok: true } | { ok: false; error: string }>;
  settled: Promise<{ status: "completed" | "failed" | "cancelled"; error?: string }>;
}

export interface OpenClawSessionEventOptions {
  agentId: string;
  sessionKey: string;
  contextKey?: string;
  deliveryContext?: OpenClawDeliveryContext;
  expectedTarget?: unknown;
}

export interface OpenClawSystemRuntime {
  captureSessionEventTarget(agentId: string, sessionKey: string): Promise<unknown>;
  enqueueSessionEvent(text: string, options: OpenClawSessionEventOptions): OpenClawSessionEventReceipt;
}

export interface OpenClawService {
  id: string;
  start: (ctx: unknown) => void | Promise<void>;
  stop?: (ctx: unknown) => void | Promise<void>;
}

export interface OpenClawAgentEvent {
  runId: string;
  stream: string;
  data: Record<string, unknown>;
  sessionKey?: string;
  agentId?: string;
}

export interface OpenClawAgentEventSubscription {
  id: string;
  streams?: string[];
  phases?: string[];
  payload?: "full" | "metadata";
  handle: (event: OpenClawAgentEvent) => void | Promise<void>;
}

export interface OpenClawPluginApi {
  id: string;
  logger: OpenClawLogger;
  runtime: { system: OpenClawSystemRuntime };
  agent?: { events?: { registerAgentEventSubscription?: (subscription: OpenClawAgentEventSubscription) => void } };
  registerTool(tool: OpenClawToolFactory, opts?: { name?: string; names?: string[] }): void;
  registerService(service: OpenClawService): void;
}

export const RUN_PHASES = { started: "start", ended: ["end", "error"] } as const;

export function watchRuns(api: OpenClawPluginApi, onRun: (sessionKey: string, runId: string, running: boolean) => void): boolean {
  const events = api.agent?.events;
  if (typeof events?.registerAgentEventSubscription !== "function") return false;
  events.registerAgentEventSubscription({
    id: "plannotator-inbox-runs",
    streams: ["lifecycle"],
    phases: [RUN_PHASES.started, ...RUN_PHASES.ended],
    payload: "metadata",
    handle: (event) => {
      const phase = event.data?.phase;
      if (typeof event.sessionKey !== "string" || typeof event.runId !== "string" || typeof phase !== "string") return;
      onRun(event.sessionKey, event.runId, phase === RUN_PHASES.started);
    },
  });
  return true;
}

export interface OpenClawSession {
  agentId: string;
  sessionKey: string;
}

const COMMAND_LINE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function inboxSessionOf(session: OpenClawSession): string {
  const key = session.sessionKey.startsWith(`agent:${session.agentId}:`) ? session.sessionKey : `agent:${session.agentId}:${session.sessionKey}`;
  const readable = key.replaceAll(":", ".");
  if (!key.includes(".") && COMMAND_LINE_SESSION.test(readable)) return readable;
  return `openclaw-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

const SHARED_CHAT_PARTS = new Set(["group", "channel"]);

export function isSharedChat(sessionKey: string): boolean {
  const parts = sessionKey.toLowerCase().split(":");
  if (parts.some((part) => SHARED_CHAT_PARTS.has(part) || part.startsWith("guild-") || part.endsWith("@g.us"))) return true;
  return parts.includes("subagent") || parts.includes("cron");
}

export function isOwnerTurn(ctx: OpenClawToolContext): boolean {
  if (ctx.senderIsOwner !== true || ctx.backgroundRun) return false;
  return typeof ctx.agentId === "string" && !!ctx.agentId && typeof ctx.sessionKey === "string" && !!ctx.sessionKey && !isSharedChat(ctx.sessionKey);
}

export function isPluginEventTurn(ctx: OpenClawToolContext): boolean {
  return ctx.inputProvenance?.kind === "internal_system" && ctx.inputProvenance.sourceTool === "plugin" && !ctx.backgroundRun;
}

export async function startTurn(system: OpenClawSystemRuntime, session: OpenClawSession, text: string, route: OpenClawDeliveryContext | undefined): Promise<void> {
  const expectedTarget = await system.captureSessionEventTarget(session.agentId, session.sessionKey);
  const receipt = system.enqueueSessionEvent(text, {
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    expectedTarget,
    ...(route ? { deliveryContext: route } : {}),
  });
  const admission = await receipt.accepted;
  if (!admission.ok) throw new Error(admission.error);
}
