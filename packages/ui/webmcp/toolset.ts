/**
 * Tool definitions, the response envelope, the execute wrapper, and the
 * per-document registry.
 *
 * Spec-agnostic: the only WebMCP names live in ./modelContext.ts. Everything
 * here works against `ModelContextLike`, so a fake can be injected in tests
 * and the whole engine runs under plain `bun test`.
 */

import {
  TOOL_NAME_PATTERN,
  type ModelContextExecuteContext,
  type ModelContextLike,
  type ModelContextToolAnnotations,
  type ModelContextToolDescriptor,
} from './modelContext';
import { validateAgainstSchema, type JsonSchema } from './schema';
import { recordToolCall } from './activity';

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type ToolErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'ambiguous'
  | 'forbidden'
  | 'not_available'
  | 'conflict'
  | 'failed';

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  hint?: string;
  /** For `ambiguous`: the contexts the caller can choose between. */
  candidates?: string[];
}

export type NudgeCode =
  | 'annotations_new'
  | 'annotations_removed'
  | 'replies_new'
  | 'composer_open'
  | 'source_stale'
  | 'document_edited'
  | 'comment_only_surface'
  | 'page_changed'
  | 'other_document_active'
  | 'pending_unsent'
  | 'session_decided'
  | 'truncated';

export interface Nudge {
  /** Machine-readable, stable. */
  code: NudgeCode;
  /** One sentence for the model. Static text we own; never document or comment text. */
  message: string;
  /** Annotation ids this is about. */
  ids?: string[];
  /** Document this is about (folder / linked-doc sessions) or page (live app). */
  path?: string;
  /** Heading slug this is about. */
  section?: string;
  /** The one call that acts on it. */
  action?: { tool: string; args: Record<string, unknown> };
}

/** What a handler returns; the engine appends nudges. */
export type ToolResult<T> =
  | { ok: true; data: T; cursor?: string }
  | { ok: false; error: ToolError };

/** What the browser agent receives, identical for every tool. */
export type ToolResponse<T = unknown> =
  | { ok: true; data: T; nudges: Nudge[]; cursor?: string }
  | { ok: false; error: ToolError; nudges: Nudge[] };

export function ok<T>(data: T, cursor?: string): ToolResult<T> {
  return cursor === undefined ? { ok: true, data } : { ok: true, data, cursor };
}

export function fail(code: ToolErrorCode, message: string, extra?: { hint?: string; candidates?: string[] }): ToolResult<never> {
  const error: ToolError = { code, message };
  if (extra?.hint) error.hint = extra.hint;
  if (extra?.candidates) error.candidates = extra.candidates;
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Tool specs
// ---------------------------------------------------------------------------

export interface ToolSpec<I = unknown, T = unknown> {
  /** Bare name; the registry applies the policy prefix. */
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: ModelContextToolAnnotations;
  execute: (input: I, context: ModelContextExecuteContext) => ToolResult<T> | Promise<ToolResult<T>>;
}

/** Spec-level limits the catalog tests pin. */
export const TOOL_DESCRIPTION_MAX_CHARS = 500;
export const TOOL_PARAM_DESCRIPTION_MAX_CHARS = 150;

/**
 * Identity function with definition-time validation. A bad name or an empty
 * description is a programming error, so it throws here (never at register
 * time, where the browser would reject silently).
 */
export function defineTool<I, T>(spec: ToolSpec<I, T>): ToolSpec<I, T> {
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new Error(`webmcp: invalid tool name "${spec.name}"`);
  }
  if (!spec.description || !spec.description.trim()) {
    throw new Error(`webmcp: tool "${spec.name}" needs a description`);
  }
  return spec;
}

// ---------------------------------------------------------------------------
// Execute wrapper
// ---------------------------------------------------------------------------

export interface ToolsetHooks {
  /** Runs AFTER the handler, so a mutation's nudges reflect the mutation. */
  buildNudges: (info: { tool: string; result: ToolResult<unknown> }) => Nudge[];
  /** Runs after the envelope is built (the watermark advances here). */
  afterResponse?: (response: ToolResponse) => void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'unexpected failure';
}

/**
 * Run one tool call end to end: validate the input against the declared
 * schema, invoke the handler, coerce the result into the envelope, attach
 * nudges (error responses included), notify hooks, and record activity.
 *
 * The promise NEVER rejects and the value is always JSON-serializable: a
 * rejection or an unserializable value would reach the agent as a bare
 * `UnknownError` with no message.
 */
export async function runTool(
  spec: ToolSpec<unknown, unknown>,
  hooks: ToolsetHooks,
  rawInput: unknown,
  context: ModelContextExecuteContext,
): Promise<ToolResponse> {
  let result: ToolResult<unknown>;
  try {
    const input = rawInput === undefined || rawInput === null ? {} : rawInput;
    const problem = validateAgainstSchema(spec.inputSchema, input);
    if (problem) {
      result = fail('invalid_input', problem);
    } else {
      const returned = await spec.execute(input, context);
      result =
        returned && typeof returned === 'object' && typeof (returned as ToolResult<unknown>).ok === 'boolean'
          ? returned
          : fail('failed', 'the tool produced no result');
    }
  } catch (error) {
    result = fail('failed', describeError(error));
  }

  let nudges: Nudge[] = [];
  try {
    nudges = hooks.buildNudges({ tool: spec.name, result }) ?? [];
  } catch {
    nudges = [];
  }

  // Equality (not truthiness) narrowing: the ui tsconfig runs without
  // strictNullChecks, where `if (result.ok)` does not narrow the union.
  let response: ToolResponse;
  if (result.ok === false) {
    response = { ok: false, error: result.error, nudges };
  } else {
    response = { ok: true, data: result.data === undefined ? null : result.data, nudges };
    if (result.cursor !== undefined) response.cursor = result.cursor;
  }

  try {
    // Strip `undefined` members and prove serializability in one pass.
    response = JSON.parse(JSON.stringify(response)) as ToolResponse;
  } catch (error) {
    response = { ok: false, error: { code: 'failed', message: `unserializable result: ${describeError(error)}` }, nudges: [] };
  }

  try {
    hooks.afterResponse?.(response);
  } catch {
    // Hook failures never reach the agent.
  }
  if (response.ok) recordToolCall(spec.name);
  return response;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  /**
   * Register the set's tools (reconciled by prefixed name) and return a
   * detach function that aborts every controller the set owns. Re-attaching
   * the same set with the same names and unchanged descriptors only swaps the
   * handlers in place, so a React re-render never touches `registerTool`.
   */
  attach(setId: string, tools: ToolSpec<never, unknown>[], hooks: ToolsetHooks): () => void;
  /** Prefixed names currently registered through this registry. */
  names(): string[];
}

interface LiveEntry {
  setId: string;
  controller: AbortController;
  signature: string;
  current: { spec: ToolSpec<unknown, unknown>; hooks: ToolsetHooks };
}

function signatureOf(spec: ToolSpec<unknown, unknown>): string {
  return JSON.stringify([spec.title ?? null, spec.description, spec.inputSchema ?? null, spec.annotations ?? null]);
}

export interface CreateToolRegistryOptions {
  /** Read at attach time so a late policy override is honored. */
  prefix: () => string;
  warn?: (message: string) => void;
}

export function createToolRegistry(ctx: ModelContextLike, options: CreateToolRegistryOptions): ToolRegistry {
  const live = new Map<string, LiveEntry>();
  const warnedNames = new Set<string>();
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const warnOnce = (name: string, message: string) => {
    if (warnedNames.has(name)) return;
    warnedNames.add(name);
    warn(message);
  };

  const register = (name: string, setId: string, spec: ToolSpec<unknown, unknown>, hooks: ToolsetHooks) => {
    const controller = new AbortController();
    const entry: LiveEntry = { setId, controller, signature: signatureOf(spec), current: { spec, hooks } };
    live.set(name, entry);
    const descriptor: ModelContextToolDescriptor = {
      name,
      description: spec.description,
      ...(spec.title ? { title: spec.title } : {}),
      ...(spec.inputSchema ? { inputSchema: spec.inputSchema } : {}),
      ...(spec.annotations ? { annotations: spec.annotations } : {}),
      execute: (input, context) => runTool(entry.current.spec, entry.current.hooks, input, context),
    };
    let registration: Promise<unknown>;
    try {
      registration = Promise.resolve(ctx.registerTool(descriptor, { signal: controller.signal }));
    } catch (error) {
      registration = Promise.reject(error);
    }
    registration.catch((error: unknown) => {
      // An abort rejects the registration promise by design; only a genuine
      // registration failure is worth one line.
      if (controller.signal.aborted) return;
      warnOnce(name, `webmcp: could not register "${name}": ${describeError(error)}`);
    });
  };

  const unregister = (name: string) => {
    const entry = live.get(name);
    if (!entry) return;
    live.delete(name);
    entry.controller.abort();
  };

  return {
    attach(setId, tools, hooks) {
      const prefix = options.prefix();
      const wanted = new Set<string>();
      for (const bare of tools) {
        const spec = bare as ToolSpec<unknown, unknown>;
        const name = `${prefix}${spec.name}`;
        if (!TOOL_NAME_PATTERN.test(name)) {
          warnOnce(name, `webmcp: skipping tool with invalid name "${name}"`);
          continue;
        }
        wanted.add(name);
        const existing = live.get(name);
        if (existing && existing.setId !== setId) {
          warnOnce(name, `webmcp: tool "${name}" is already registered by "${existing.setId}"; skipping the copy from "${setId}"`);
          continue;
        }
        if (existing) {
          if (existing.signature === signatureOf(spec)) {
            existing.current = { spec, hooks };
            continue;
          }
          unregister(name);
        }
        register(name, setId, spec, hooks);
      }
      for (const [name, entry] of live) {
        if (entry.setId === setId && !wanted.has(name)) unregister(name);
      }
      return () => {
        for (const [name, entry] of live) {
          if (entry.setId === setId) unregister(name);
        }
      };
    },
    names() {
      return [...live.keys()].sort();
    },
  };
}

const registries = new WeakMap<object, ToolRegistry>();

/**
 * One registry per ModelContext (which is one per Document): registration is
 * document-scoped and the name space is flat.
 */
export function getRegistryFor(ctx: ModelContextLike, options: CreateToolRegistryOptions): ToolRegistry {
  let registry = registries.get(ctx);
  if (!registry) {
    registry = createToolRegistry(ctx, options);
    registries.set(ctx, registry);
  }
  return registry;
}
