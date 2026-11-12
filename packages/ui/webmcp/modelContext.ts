export const MODEL_CONTEXT_PROPERTY = 'modelContext';

export const TOOL_CHANGE_EVENT = 'toolchange';

export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export interface ModelContextToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  destructiveHint?: boolean;
}

export interface ModelContextExecuteContext {
  signal: AbortSignal;
}

export type ModelContextExecute = (
  input: unknown,
  context: ModelContextExecuteContext,
) => unknown | Promise<unknown>;

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

export interface ModelContextRegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ModelContextToolAnnotations;
}

export interface ModelContextLike {
  registerTool(tool: ModelContextToolDescriptor, options?: ModelContextRegisterOptions): Promise<unknown>;
  getTools?(options?: Record<string, unknown>): Promise<ModelContextRegisteredTool[]>;
  executeTool?(tool: ModelContextRegisteredTool, input?: object, options?: Record<string, unknown>): Promise<string>;
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
}

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
