import {
  TOOL_NAME_PATTERN,
  type ModelContextExecuteContext,
  type ModelContextLike,
  type ModelContextToolAnnotations,
  type ModelContextToolDescriptor,
} from './modelContext';
import { validateAgainstSchema, type JsonSchema } from './schema';
import { recordToolCall } from './activity';

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
  code: NudgeCode;
  message: string;
  ids?: string[];
  path?: string;
  section?: string;
  action?: { tool: string; args: Record<string, unknown> };
}

export type ToolResult<T> =
  | { ok: true; data: T; cursor?: string }
  | { ok: false; error: ToolError };

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

export interface ToolSpec<I = unknown, T = unknown> {
  name: string;
  title?: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: ModelContextToolAnnotations;
  execute: (input: I, context: ModelContextExecuteContext) => ToolResult<T> | Promise<ToolResult<T>>;
}

export const TOOL_DESCRIPTION_MAX_CHARS = 500;
export const TOOL_PARAM_DESCRIPTION_MAX_CHARS = 150;

export function defineTool<I, T>(spec: ToolSpec<I, T>): ToolSpec<I, T> {
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new Error(`webmcp: invalid tool name "${spec.name}"`);
  }
  if (!spec.description || !spec.description.trim()) {
    throw new Error(`webmcp: tool "${spec.name}" needs a description`);
  }
  return spec;
}

export interface ToolsetHooks {
  buildNudges: (info: { tool: string; result: ToolResult<unknown> }) => Nudge[];
  afterResponse?: (response: ToolResponse) => void;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  return 'unexpected failure';
}

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

  let response: ToolResponse;
  if (result.ok === false) {
    response = { ok: false, error: result.error, nudges };
  } else {
    response = { ok: true, data: result.data === undefined ? null : result.data, nudges };
    if (result.cursor !== undefined) response.cursor = result.cursor;
  }

  try {
    response = JSON.parse(JSON.stringify(response)) as ToolResponse;
  } catch (error) {
    response = { ok: false, error: { code: 'failed', message: `unserializable result: ${describeError(error)}` }, nudges: [] };
  }

  try {
    hooks.afterResponse?.(response);
  } catch {
  }
  if (response.ok) recordToolCall(spec.name);
  return response;
}

export interface ToolRegistry {
  attach(setId: string, tools: ToolSpec<never, unknown>[], hooks: ToolsetHooks): () => void;
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

export function getRegistryFor(ctx: ModelContextLike, options: CreateToolRegistryOptions): ToolRegistry {
  let registry = registries.get(ctx);
  if (!registry) {
    registry = createToolRegistry(ctx, options);
    registries.set(ctx, registry);
  }
  return registry;
}
