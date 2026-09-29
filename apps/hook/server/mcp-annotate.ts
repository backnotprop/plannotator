/**
 * The `annotate` MCP tool behind `plannotator mcp` (the Codex plugin).
 *
 * One call = one annotate session: resolve the target exactly like
 * `plannotator annotate` does, start the annotate server, open the browser,
 * block until the human decides, and return the decision as the tool result.
 * The text content is byte-for-byte what the plaintext CLI prints; the
 * structured content is the `--json` record. Blocking is the baseline that
 * works in every Codex surface (CLI, TUI, desktop), because the tool result
 * is the one channel every MCP host delivers to the model.
 *
 * Everything with side effects (resolution, server start, the post-decision
 * settle) is injected through `AnnotateToolDeps`, so the handler is unit
 * tested without ports, browsers, or the network.
 */

import path from "path";
import { statSync } from "fs";
import type { AnnotateResolutionResult, AnnotateResolutionSuccess } from "./annotate-resolution";
import { formatAnnotateOutcome, type AnnotateOutcome } from "./annotate-output";
import {
  McpCallCancelledError,
  type McpCallToolResult,
  type McpResourceDefinition,
  type McpToolContext,
  type McpToolDefinition,
} from "./mcp-protocol";
import { ANNOTATE_APP_HTML } from "./mcp-annotate-app";

export const ANNOTATE_TOOL_NAME = "annotate";
export const ANNOTATE_STATUS_TOOL_NAME = "annotate_session_status";
export const ANNOTATE_APP_RESOURCE_URI = "ui://plannotator/annotate";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

/** Text returned when the reviewer closes the session without sending anything. */
export const ANNOTATE_DISMISSED_TEXT =
  "The user closed Plannotator without sending feedback.";
/** Text returned when the reviewer finished with an empty submission. */
export const ANNOTATE_EMPTY_FEEDBACK_TEXT =
  "The user finished in Plannotator without leaving any feedback.";

export interface AnnotateToolInput {
  target: string;
  cwd?: string;
  markdown: boolean;
  noJina: boolean;
  gate: boolean;
}

export interface AnnotateSessionHandle {
  url: string;
  isRemote: boolean;
  waitForDecision: () => Promise<AnnotateOutcome>;
  stop: () => void;
}

export interface AnnotateToolDeps {
  /** Resolve a target string the way `plannotator annotate` does. */
  resolveTarget: (options: {
    rawFilePath: string;
    projectRoot: string;
    noJina: boolean;
    renderMarkdown: boolean;
    log: (line: string) => void;
  }) => Promise<AnnotateResolutionResult>;
  /** Start the annotate server for a resolved target. `onReady` fires once the URL is known. */
  startSession: (
    resolution: AnnotateResolutionSuccess,
    options: {
      gate: boolean;
      /** `--markdown`: HTML targets were converted rather than rendered raw. */
      markdown: boolean;
      projectRoot: string;
      onReady: (url: string, isRemote: boolean) => void;
    },
  ) => Promise<AnnotateSessionHandle>;
  /** Pause after a decision so the browser receives its response before the server stops. */
  settleAfterDecision: () => Promise<void>;
  /** Default directory relative targets resolve against. */
  defaultCwd: () => string;
  /** True when the session will be served in remote mode. */
  isRemote: () => boolean;
  /** Message for the remote hard-off on live app sessions. */
  liveAppRemoteMessage: string;
  now?: () => number;
}

// --- Session registry (feeds the app-only status tool and the ui:// view) ---

export type AnnotateSessionState = "starting" | "open" | "decided" | "failed" | "cancelled";

export interface AnnotateSessionRecord {
  id: string;
  target: string;
  state: AnnotateSessionState;
  url?: string;
  isRemote?: boolean;
  decision?: "approved" | "annotated" | "dismissed";
  /** The text returned to the model, so the view can post it if the tool result never arrived. */
  resultText?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
}

export class AnnotateSessionRegistry {
  private readonly sessions = new Map<string, AnnotateSessionRecord>();
  private counter = 0;
  constructor(
    private readonly now: () => number = Date.now,
    private readonly limit = 20,
  ) {}

  create(target: string): AnnotateSessionRecord {
    this.counter += 1;
    const at = this.now();
    const record: AnnotateSessionRecord = {
      id: `s${this.counter}`,
      target,
      state: "starting",
      startedAt: at,
      updatedAt: at,
    };
    this.sessions.set(record.id, record);
    // Keep finished records around for the view to read, but bounded.
    while (this.sessions.size > this.limit) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    return record;
  }

  update(id: string, patch: Partial<Omit<AnnotateSessionRecord, "id" | "startedAt">>): void {
    const record = this.sessions.get(id);
    if (!record) return;
    Object.assign(record, patch, { updatedAt: this.now() });
  }

  /** Newest first. */
  list(): AnnotateSessionRecord[] {
    return [...this.sessions.values()].reverse().map((record) => ({ ...record }));
  }
}

// --- Input parsing ---

export function parseAnnotateToolInput(
  args: Record<string, unknown>,
): { ok: true; input: AnnotateToolInput } | { ok: false; message: string } {
  const target = typeof args.target === "string" ? args.target.trim() : "";
  if (!target) {
    return {
      ok: false,
      message:
        "annotate needs a `target`: a file path, a folder path, or an http(s) URL.",
    };
  }
  for (const flag of ["markdown", "noJina", "gate"] as const) {
    if (args[flag] !== undefined && typeof args[flag] !== "boolean") {
      return { ok: false, message: `\`${flag}\` must be a boolean.` };
    }
  }
  if (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd.trim())) {
    return { ok: false, message: "`cwd` must be a non-empty directory path." };
  }
  return {
    ok: true,
    input: {
      target,
      cwd: typeof args.cwd === "string" ? args.cwd.trim() : undefined,
      markdown: args.markdown === true,
      noJina: args.noJina === true,
      gate: args.gate === true,
    },
  };
}

/** The directory relative targets resolve against: explicit cwd (relative cwd resolves against the default), else the server's cwd. */
export function resolveProjectRoot(cwd: string | undefined, defaultCwd: string): string {
  if (!cwd) return defaultCwd;
  return path.resolve(defaultCwd, cwd);
}

// --- Result shaping ---

export type AnnotateJsonRecord =
  | { decision: "approved"; feedback?: string }
  | { decision: "annotated"; feedback: string }
  | { decision: "dismissed" };

/**
 * Shape a decision into the tool result: `content` carries the plaintext CLI
 * output (or an explicit sentence where the CLI prints nothing), and
 * `structuredContent` is the `--json` record.
 */
export function buildAnnotateToolResult(outcome: AnnotateOutcome): McpCallToolResult {
  const plaintext = formatAnnotateOutcome(outcome, { hook: false, json: false });
  const record = JSON.parse(
    formatAnnotateOutcome(outcome, { hook: false, json: true }) as string,
  ) as AnnotateJsonRecord;
  const text =
    plaintext ??
    (record.decision === "dismissed" ? ANNOTATE_DISMISSED_TEXT : ANNOTATE_EMPTY_FEEDBACK_TEXT);
  return {
    content: [{ type: "text", text }],
    structuredContent: record as unknown as Record<string, unknown>,
  };
}

function errorResult(message: string): McpCallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

// --- The handler ---

export async function runAnnotateTool(
  args: Record<string, unknown>,
  ctx: McpToolContext,
  deps: AnnotateToolDeps,
  registry: AnnotateSessionRegistry,
): Promise<McpCallToolResult> {
  const parsed = parseAnnotateToolInput(args);
  if (!parsed.ok) return errorResult(parsed.message);
  const input = parsed.input;

  const projectRoot = resolveProjectRoot(input.cwd, deps.defaultCwd());
  if (input.cwd) {
    let isDir = false;
    try {
      isDir = statSync(projectRoot).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) return errorResult(`cwd is not a directory: ${projectRoot}`);
  }

  const record = registry.create(input.target);
  const log = (line: string) => {
    process.stderr.write(`${line}\n`);
    ctx.log("info", line);
  };

  const resolution = await deps.resolveTarget({
    rawFilePath: input.target,
    projectRoot,
    noJina: input.noJina,
    renderMarkdown: input.markdown,
    log,
  });
  if (ctx.signal.aborted) {
    registry.update(record.id, { state: "cancelled" });
    throw new McpCallCancelledError();
  }
  if (!resolution.ok) {
    registry.update(record.id, { state: "failed", error: resolution.message });
    const hint = resolution.notFound
      ? `\n(Relative paths resolve against ${projectRoot}. Pass an absolute path, or set \`cwd\`.)`
      : "";
    return errorResult(`${resolution.message}${hint}`);
  }
  if (resolution.liveApp && deps.isRemote()) {
    registry.update(record.id, { state: "failed", error: deps.liveAppRemoteMessage });
    return errorResult(deps.liveAppRemoteMessage);
  }

  let session: AnnotateSessionHandle;
  try {
    session = await deps.startSession(resolution, {
      gate: input.gate,
      markdown: input.markdown,
      projectRoot,
      onReady: (url, isRemote) => {
        registry.update(record.id, { state: "open", url, isRemote });
        // stdout is the protocol, so the URL goes to stderr (already printed
        // by the ready handler), a log notification, and a progress
        // notification when the client asked for progress.
        const line = isRemote
          ? `Plannotator session ready (remote) — open on your local machine: ${url}`
          : `Plannotator session ready: ${url}`;
        ctx.log("notice", line);
        ctx.progress(line);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    registry.update(record.id, { state: "failed", error: message });
    return errorResult(`Failed to start Plannotator: ${message}`);
  }
  // onReady may not have fired for a host whose start resolves first.
  if (record.state === "starting") {
    registry.update(record.id, { state: "open", url: session.url, isRemote: session.isRemote });
  }

  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<"cancelled">((resolve) => {
    if (ctx.signal.aborted) return resolve("cancelled");
    onAbort = () => resolve("cancelled");
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });

  let outcome: AnnotateOutcome | "cancelled";
  try {
    outcome = await Promise.race([session.waitForDecision(), cancelled]);
  } finally {
    if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
  }

  if (outcome === "cancelled") {
    // The client gave up on the call (user interrupt, tool timeout, or the
    // transport closed): nobody can receive a decision anymore, so close the
    // session instead of leaving a live server behind.
    session.stop();
    registry.update(record.id, { state: "cancelled" });
    process.stderr.write("Plannotator annotate call cancelled; session closed.\n");
    throw new McpCallCancelledError();
  }

  const result = buildAnnotateToolResult(outcome);
  registry.update(record.id, {
    state: "decided",
    decision: (result.structuredContent as AnnotateJsonRecord).decision,
    resultText: result.content[0].text,
  });
  await deps.settleAfterDecision();
  session.stop();
  return result;
}

// --- Tool + resource definitions ---

export const ANNOTATE_TOOL_DESCRIPTION = [
  "Open a document in Plannotator so the user can annotate it in their browser, then return the user's feedback.",
  "Targets: a markdown/text/HTML file, a folder of documents, or an http(s) URL.",
  "This call blocks until the user sends feedback, approves, or closes the session; that can take many minutes.",
  "The result text is the user's feedback (address it), \"The user approved.\", or a sentence saying they closed without feedback.",
  "Prefer an absolute path for `target`.",
].join(" ");

export function createAnnotateTools(
  deps: AnnotateToolDeps,
  registry: AnnotateSessionRegistry,
): McpToolDefinition[] {
  return [
    {
      name: ANNOTATE_TOOL_NAME,
      title: "Annotate with Plannotator",
      description: ANNOTATE_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "What to annotate: an absolute (preferred) or relative file path (.md, .mdx, .txt, .html, and other plain-text formats), a folder path, or an http(s) URL.",
          },
          cwd: {
            type: "string",
            description:
              "Directory that a relative target resolves against. Defaults to the Plannotator MCP server's working directory. Pass your current working directory when using a relative target.",
          },
          markdown: {
            type: "boolean",
            description: "Convert an HTML target to markdown instead of rendering it as raw HTML.",
          },
          noJina: {
            type: "boolean",
            description: "Fetch URL targets with fetch+Turndown instead of Jina Reader.",
          },
          gate: {
            type: "boolean",
            description:
              "Show an Approve button, for when the user should explicitly approve or request changes.",
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["approved", "annotated", "dismissed"] },
          feedback: { type: "string" },
        },
        required: ["decision"],
      },
      annotations: {
        title: "Annotate with Plannotator",
        // It never modifies the user's files: it reads the target and opens a
        // local review page. (It does keep its own history under the
        // Plannotator data dir, like the CLI.)
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        // URL targets are fetched from the web.
        openWorldHint: true,
      },
      _meta: {
        ui: { resourceUri: ANNOTATE_APP_RESOURCE_URI },
        "openai/ui": { preferredModelDisplayMode: "inline" },
      },
      handler: (args, ctx) => runAnnotateTool(args, ctx, deps, registry),
    },
    {
      name: ANNOTATE_STATUS_TOOL_NAME,
      title: "Plannotator session status",
      description:
        "App-only: report the state of this server's annotate sessions (URL, state, decision) for the Plannotator view.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      // Hidden from the model; callable by the ui:// view through tools/call.
      _meta: { ui: { visibility: ["app"] } },
      handler: async () => {
        const sessions = registry.list();
        return {
          content: [{ type: "text", text: JSON.stringify({ sessions }) }],
          structuredContent: { sessions: sessions as unknown as Record<string, unknown>[] },
        } as McpCallToolResult;
      },
    },
  ];
}

export function createAnnotateResources(): McpResourceDefinition[] {
  return [
    {
      uri: ANNOTATE_APP_RESOURCE_URI,
      name: "plannotator-annotate",
      title: "Plannotator annotate session",
      description: "Shows the Plannotator session link and state while the annotate tool waits for the user.",
      mimeType: MCP_APP_MIME_TYPE,
      // No network access is needed: the view talks to the server only
      // through host-proxied tools/call, and opens the session with
      // ui/open-link (the local page cannot load inside the webview).
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
      read: () => ANNOTATE_APP_HTML,
    },
  ];
}

export const MCP_SERVER_INSTRUCTIONS = [
  "Plannotator lets the user review documents in a browser UI and send annotated feedback back to you.",
  "Call the `annotate` tool with a file, folder, or URL when the user asks to annotate, review, or mark up a document in Plannotator.",
  "The call blocks until the user finishes. When it returns feedback, address every annotation; when it returns \"The user approved.\", continue; when the user closed without feedback, do not guess at changes.",
].join(" ");
