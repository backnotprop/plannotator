/**
 * External Annotations — shared types, store logic, and SSE helpers.
 *
 * Runtime-agnostic: no node:fs, no node:http, no Bun APIs.
 * Both the Bun server handler and Pi server handler import this module
 * and wrap it with their respective HTTP transport layers.
 *
 * The store is generic — plan servers store Annotation objects,
 * review servers store CodeAnnotation objects. The mode-specific
 * input transformers handle validation and field assignment.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Constraint for any annotation type the store can hold. */
export type StorableAnnotation = { id: string; source?: string };

export type ExternalAnnotationEvent<T = unknown> =
  | { type: "snapshot"; annotations: T[] }
  | { type: "add"; annotations: T[] }
  | { type: "remove"; ids: string[] }
  | { type: "clear"; source?: string }
  | { type: "update"; id: string; annotation: T };

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/** Heartbeat comment to keep SSE connections alive (sent every 30s). */
export const HEARTBEAT_COMMENT = ":\n\n";

/** Interval in ms between heartbeat comments. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Encode an event as an SSE `data:` line. */
export function serializeSSEEvent<T>(event: ExternalAnnotationEvent<T>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Input validation — shared helpers
// ---------------------------------------------------------------------------

export interface ParseError {
  error: string;
}

/**
 * Unwrap a POST body into an array of raw input objects.
 *
 * Accepts either:
 *   - A single annotation object: `{ source: "...", ... }`
 *   - A batch wrapper: `{ annotations: [{ source: "...", ... }, ...] }`
 */
function unwrapBody(body: unknown): Record<string, unknown>[] | ParseError {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  // Batch format: { annotations: [...] }
  if (Array.isArray(obj.annotations)) {
    if (obj.annotations.length === 0) {
      return { error: "annotations array must not be empty" };
    }
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < obj.annotations.length; i++) {
      const item = obj.annotations[i];
      if (!item || typeof item !== "object") {
        return { error: `annotations[${i}] must be an object` };
      }
      items.push(item as Record<string, unknown>);
    }
    return items;
  }

  // Single format: { source: "...", ... }
  if (typeof obj.source === "string") {
    return [obj as Record<string, unknown>];
  }

  return { error: 'Missing required "source" field or "annotations" array' };
}

function requireString(obj: Record<string, unknown>, field: string, index: number): string | ParseError {
  const val = obj[field];
  if (typeof val !== "string" || val.length === 0) {
    return { error: `annotations[${index}] missing required "${field}" field` };
  }
  return val;
}

// ---------------------------------------------------------------------------
// Plan mode transformer — produces Annotation objects
// ---------------------------------------------------------------------------

/** The Annotation type shape for plan mode (mirrors packages/ui/types.ts). */
interface PlanAnnotation {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  type: string; // AnnotationType value
  text?: string;
  originalText: string;
  createdA: number;
  author?: string;
  source?: string;
}

const VALID_PLAN_TYPES = ["DELETION", "COMMENT", "GLOBAL_COMMENT"];

export function transformPlanInput(
  body: unknown,
): { annotations: PlanAnnotation[] } | ParseError {
  const items = unwrapBody(body);
  if ("error" in items) return items;

  const annotations: PlanAnnotation[] = [];
  for (let i = 0; i < items.length; i++) {
    const obj = items[i];

    const source = requireString(obj, "source", i);
    if (typeof source !== "string") return source;

    // Must have text content
    if (typeof obj.text !== "string" || obj.text.length === 0) {
      return { error: `annotations[${i}] missing required "text" field` };
    }

    // Validate type if provided, default to GLOBAL_COMMENT
    const type = typeof obj.type === "string" ? obj.type : "GLOBAL_COMMENT";
    if (!VALID_PLAN_TYPES.includes(type)) {
      return {
        error: `annotations[${i}] invalid type "${type}". Must be one of: ${VALID_PLAN_TYPES.join(", ")}`,
      };
    }

    // DELETION requires originalText (the text to remove)
    if (type === "DELETION" && (typeof obj.originalText !== "string" || obj.originalText.length === 0)) {
      return { error: `annotations[${i}] DELETION type requires non-empty "originalText" field` };
    }

    // COMMENT requires originalText so the renderer can pin it to a phrase.
    // External agents that want sidebar-only feedback should use GLOBAL_COMMENT
    // instead — without a phrase to anchor to, a COMMENT renders as an empty
    // quote bubble in the sidebar and exports as `Feedback on: ""`.
    if (type === "COMMENT" && (typeof obj.originalText !== "string" || obj.originalText.length === 0)) {
      return {
        error: `annotations[${i}] COMMENT requires non-empty "originalText" field. Use GLOBAL_COMMENT for sidebar-only feedback.`,
      };
    }

    annotations.push({
      id: crypto.randomUUID(),
      blockId: "external",
      startOffset: 0,
      endOffset: 0,
      type,
      text: String(obj.text),
      originalText: typeof obj.originalText === "string" ? obj.originalText : "",
      createdA: Date.now(),
      author: typeof obj.author === "string" ? obj.author : undefined,
      source,
    });
  }

  return { annotations };
}

// ---------------------------------------------------------------------------
// Review mode transformer — produces CodeAnnotation objects
// ---------------------------------------------------------------------------

/** The CodeAnnotation type shape for review mode (mirrors packages/ui/types.ts). */
interface ReviewAnnotation {
  id: string;
  type: string; // CodeAnnotationType value
  scope?: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: string;
  text?: string;
  suggestedCode?: string;
  originalCode?: string;
  createdAt: number;
  author?: string;
  source?: string;
  // Agent review metadata (optional — only set by Claude review findings)
  severity?: string; // "important" | "nit" | "pre_existing"
  reasoning?: string; // Validation chain explaining how the issue was confirmed
}

const VALID_REVIEW_TYPES = ["comment", "suggestion", "concern"];
const VALID_SIDES = ["old", "new"];
const VALID_SCOPES = ["line", "file"];

export function transformReviewInput(
  body: unknown,
): { annotations: ReviewAnnotation[] } | ParseError {
  const items = unwrapBody(body);
  if ("error" in items) return items;

  const annotations: ReviewAnnotation[] = [];
  for (let i = 0; i < items.length; i++) {
    const obj = items[i];

    const source = requireString(obj, "source", i);
    if (typeof source !== "string") return source;

    const filePath = requireString(obj, "filePath", i);
    if (typeof filePath !== "string") return filePath;

    if (typeof obj.lineStart !== "number") {
      return { error: `annotations[${i}] missing required "lineStart" field` };
    }
    if (typeof obj.lineEnd !== "number") {
      return { error: `annotations[${i}] missing required "lineEnd" field` };
    }

    // side: optional, defaults to "new"
    const side = typeof obj.side === "string" ? obj.side : "new";
    if (!VALID_SIDES.includes(side)) {
      return {
        error: `annotations[${i}] invalid side "${side}". Must be one of: ${VALID_SIDES.join(", ")}`,
      };
    }

    // type: optional, defaults to "comment"
    const type = typeof obj.type === "string" ? obj.type : "comment";
    if (!VALID_REVIEW_TYPES.includes(type)) {
      return {
        error: `annotations[${i}] invalid type "${type}". Must be one of: ${VALID_REVIEW_TYPES.join(", ")}`,
      };
    }

    // scope: optional, defaults to "line"
    const scope = typeof obj.scope === "string" ? obj.scope : "line";
    if (!VALID_SCOPES.includes(scope)) {
      return {
        error: `annotations[${i}] invalid scope "${scope}". Must be one of: ${VALID_SCOPES.join(", ")}`,
      };
    }

    // Must have at least text or suggestedCode
    if (typeof obj.text !== "string" && typeof obj.suggestedCode !== "string") {
      return {
        error: `annotations[${i}] must have at least one of: text, suggestedCode`,
      };
    }

    annotations.push({
      id: crypto.randomUUID(),
      type,
      scope,
      filePath,
      lineStart: obj.lineStart,
      lineEnd: obj.lineEnd,
      side,
      text: typeof obj.text === "string" ? obj.text : undefined,
      suggestedCode: typeof obj.suggestedCode === "string" ? obj.suggestedCode : undefined,
      originalCode: typeof obj.originalCode === "string" ? obj.originalCode : undefined,
      createdAt: Date.now(),
      author: typeof obj.author === "string" ? obj.author : undefined,
      source,
      // Agent review metadata (optional — only set by Claude review findings)
      ...(typeof obj.severity === "string" && { severity: obj.severity }),
      ...(typeof obj.reasoning === "string" && { reasoning: obj.reasoning }),
    });
  }

  return { annotations };
}

// ---------------------------------------------------------------------------
// Annotation Store (generic)
// ---------------------------------------------------------------------------

type MutationListener<T> = (event: ExternalAnnotationEvent<T>) => void;

export interface AnnotationStore<T extends StorableAnnotation> {
  /** Add fully-formed annotations. Returns the added annotations. */
  add(items: T[]): T[];
  /** Remove an annotation by ID. Returns true if found. */
  remove(id: string): boolean;
  /** Remove all annotations from a specific source. Returns count removed. */
  clearBySource(source: string): number;
  /** Update an annotation by ID. Returns the updated annotation, or null if not found. */
  update(id: string, fields: Partial<T>): T | null;
  /** Remove all annotations. Returns count removed. */
  clearAll(): number;
  /** Get all annotations (snapshot). */
  getAll(): T[];
  /** Monotonic version counter — incremented on every mutation. */
  readonly version: number;
  /** Register a listener for mutation events. Returns unsubscribe function. */
  onMutation(listener: MutationListener<T>): () => void;
}

/**
 * Create an in-memory annotation store.
 *
 * The store is runtime-agnostic — it holds data and emits events.
 * HTTP transport (SSE broadcasting, request parsing) is handled by
 * the server-specific adapter (Bun or Pi).
 */
export function createAnnotationStore<T extends StorableAnnotation>(): AnnotationStore<T> {
  const annotations: T[] = [];
  const listeners = new Set<MutationListener<T>>();
  let version = 0;

  function emit(event: ExternalAnnotationEvent<T>): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Don't let a failing listener break the store
      }
    }
  }

  return {
    add(items) {
      if (items.length > 0) {
        for (const item of items) {
          annotations.push(item);
        }
        version++;
        emit({ type: "add", annotations: items });
      }
      return items;
    },

    remove(id) {
      const idx = annotations.findIndex((a) => a.id === id);
      if (idx === -1) return false;
      annotations.splice(idx, 1);
      version++;
      emit({ type: "remove", ids: [id] });
      return true;
    },

    update(id, fields) {
      const idx = annotations.findIndex((a) => a.id === id);
      if (idx === -1) return null;
      const merged = { ...annotations[idx], ...fields, id } as T;
      annotations[idx] = merged;
      version++;
      emit({ type: "update", id, annotation: merged });
      return merged;
    },

    clearBySource(source) {
      const before = annotations.length;
      for (let i = annotations.length - 1; i >= 0; i--) {
        if (annotations[i].source === source) {
          annotations.splice(i, 1);
        }
      }
      const removed = before - annotations.length;
      if (removed > 0) {
        version++;
        emit({ type: "clear", source });
      }
      return removed;
    },

    clearAll() {
      const count = annotations.length;
      if (count > 0) {
        annotations.length = 0;
        version++;
        emit({ type: "clear" });
      }
      return count;
    },

    getAll() {
      return [...annotations];
    },

    get version() {
      return version;
    },

    onMutation(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
