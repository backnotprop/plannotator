/**
 * The ONLY file in the repo that spells the WebMCP surface.
 *
 * Everything here mirrors the W3C WebML CG draft of WebMCP as of 2026-08-25
 * (spec `index.bs`, entry point `document.modelContext`; the same shape
 * `webmcp-types@0.1.5` publishes). The types are deliberately local and
 * structural: no `declare global`, no dependency. `packages/ui/globals.d.ts`
 * is a published ambient file and must not augment `Document` for every
 * consumer, and the entry point has been renamed three times in a year, so a
 * rename is a one-file change plus its test.
 *
 * Spec facts the engine relies on:
 *   - `registerTool(tool, { signal })` returns a promise; unregistration is
 *     ONLY via aborting the signal (the abort steps unregister synchronously).
 *   - `execute(input, { signal })` runs in our realm; its return value is
 *     JSON-serialized by the browser and a rejection or an unserializable value
 *     surfaces to the caller as a bare `UnknownError` with no message, so tools
 *     must always return a JSON value and report errors as data.
 *   - Tool names are 1..128 chars of `[A-Za-z0-9_.-]`.
 *   - `annotations` carries `readOnlyHint` and `untrustedContentHint`. The
 *     dictionary ignores unknown members, which is why `destructiveHint` (an
 *     MCP hint the WebMCP draft does not have yet, issue #176) can be set
 *     honestly today at no cost.
 */

/** Property on `Document` that holds the per-document ModelContext. */
export const MODEL_CONTEXT_PROPERTY = 'modelContext';

/** Event fired at a document whenever its visible tool set changes. */
export const TOOL_CHANGE_EVENT = 'toolchange';

/** Spec name rule (`index.bs`: 1..128 chars of `[A-Za-z0-9_.-]`). */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export interface ModelContextToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  /** Forward-compatible (MCP hint, WebMCP issue #176). Ignored by today's dictionary. */
  destructiveHint?: boolean;
}

export interface ModelContextExecuteContext {
  signal: AbortSignal;
}

export type ModelContextExecute = (
  input: unknown,
  context: ModelContextExecuteContext,
) => unknown | Promise<unknown>;

/** `ModelContextTool` dictionary, structural subset. */
export interface ModelContextToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: ModelContextExecute;
  annotations?: ModelContextToolAnnotations;
}

export interface ModelContextRegisterOptions {
  signal?: AbortSignal;
}

/** `RegisteredTool` dictionary, the part `getTools()` callers read. */
export interface ModelContextRegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ModelContextToolAnnotations;
}

/** The nine lines of the API the engine actually uses. */
export interface ModelContextLike {
  registerTool(tool: ModelContextToolDescriptor, options?: ModelContextRegisterOptions): Promise<unknown>;
  getTools?(options?: Record<string, unknown>): Promise<ModelContextRegisteredTool[]>;
  executeTool?(tool: ModelContextRegisteredTool, input?: object, options?: Record<string, unknown>): Promise<string>;
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

/**
 * Feature detection: the one `typeof` check the module contributes to a
 * browser without WebMCP. `null` means "no provider", and every layer above
 * treats `null` as "do nothing" (no effects, no DOM, no settings row).
 *
 * House pattern (`utils/clipboard.ts`): `typeof` for the environment, `?.`
 * for the capability, `try/catch` for restricted contexts that throw on
 * property access.
 */
export function resolveModelContext(doc?: Document | null): ModelContextLike | null {
  try {
    const target = doc ?? (typeof document === 'undefined' ? null : document);
    if (!target) return null;
    const ctx = (target as unknown as Record<string, unknown>)[MODEL_CONTEXT_PROPERTY];
    if (!ctx || typeof ctx !== 'object') return null;
    if (typeof (ctx as ModelContextLike).registerTool !== 'function') return null;
    return ctx as ModelContextLike;
  } catch {
    return null;
  }
}
