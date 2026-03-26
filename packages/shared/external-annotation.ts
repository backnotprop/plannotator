/**
 * External Annotations — shared types, store logic, and SSE helpers.
 *
 * Runtime-agnostic: no node:fs, no node:http, no Bun APIs.
 * Both the Bun server handler and Pi server handler import this module
 * and wrap it with their respective HTTP transport layers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExternalAnnotationKind =
  | "comment"
  | "warning"
  | "error"
  | "suggestion"
  | "info";

export interface ExternalAnnotation {
  /** Server-assigned UUID */
  id: string;
  /** Tool identifier (e.g., "vscode", "eslint", "clippy") */
  source: string;
  /** Workspace-relative file path */
  filePath?: string;
  /** The annotated text */
  selectedText?: string;
  /** 1-based line start */
  lineStart?: number;
  /** 1-based line end */
  lineEnd?: number;
  /** Human-readable message */
  comment?: string;
  /** Annotation kind / severity */
  kind: ExternalAnnotationKind;
  /** Replacement code for suggestion-type annotations */
  suggestedCode?: string;
  /** Rule identifier (e.g., "no-unused-vars", "E0308") */
  ruleId?: string;
  /** Link to rule documentation */
  url?: string;
  /** Tool-specific escape hatch */
  metadata?: Record<string, unknown>;
  /** Server-assigned epoch ms */
  createdAt: number;
}

export type ExternalAnnotationEvent =
  | { type: "snapshot"; annotations: ExternalAnnotation[] }
  | { type: "add"; annotations: ExternalAnnotation[] }
  | { type: "remove"; ids: string[] }
  | { type: "clear"; source?: string };

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

/** Heartbeat comment to keep SSE connections alive (sent every 30s). */
export const HEARTBEAT_COMMENT = ":\n\n";

/** Interval in ms between heartbeat comments. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Encode an event as an SSE `data:` line. */
export function serializeSSEEvent(event: ExternalAnnotationEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/** Fields accepted from external callers (id and createdAt are server-assigned). */
export type AnnotationInput = Omit<ExternalAnnotation, "id" | "createdAt"> &
  Partial<Pick<ExternalAnnotation, "kind">>;

export interface ParsedInput {
  annotations: AnnotationInput[];
}

export interface ParseError {
  error: string;
}

/**
 * Validate and normalize a POST body into an array of annotation inputs.
 *
 * Accepts either:
 *   - A single annotation object: `{ source: "...", ... }`
 *   - A batch wrapper: `{ annotations: [{ source: "...", ... }, ...] }`
 */
export function parseAnnotationInput(
  body: unknown,
): ParsedInput | ParseError {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

  // Batch format: { annotations: [...] }
  if (Array.isArray(obj.annotations)) {
    if (obj.annotations.length === 0) {
      return { error: "annotations array must not be empty" };
    }
    const validated: AnnotationInput[] = [];
    for (let i = 0; i < obj.annotations.length; i++) {
      const result = validateSingleInput(obj.annotations[i], i);
      if ("error" in result) return result;
      validated.push(result);
    }
    return { annotations: validated };
  }

  // Single format: { source: "...", ... }
  if (typeof obj.source === "string") {
    const result = validateSingleInput(obj, 0);
    if ("error" in result) return result;
    return { annotations: [result] };
  }

  return { error: 'Missing required "source" field or "annotations" array' };
}

function validateSingleInput(
  input: unknown,
  index: number,
): AnnotationInput | ParseError {
  if (!input || typeof input !== "object") {
    return { error: `annotations[${index}] must be an object` };
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.source !== "string" || obj.source.length === 0) {
    return { error: `annotations[${index}] missing required "source" field` };
  }

  // At least one content field should be present
  const hasContent =
    typeof obj.comment === "string" ||
    typeof obj.selectedText === "string" ||
    typeof obj.suggestedCode === "string" ||
    typeof obj.filePath === "string";

  if (!hasContent) {
    return {
      error: `annotations[${index}] must have at least one of: comment, selectedText, suggestedCode, filePath`,
    };
  }

  const kind = typeof obj.kind === "string" ? obj.kind : "comment";
  const validKinds: ExternalAnnotationKind[] = [
    "comment",
    "warning",
    "error",
    "suggestion",
    "info",
  ];
  if (!validKinds.includes(kind as ExternalAnnotationKind)) {
    return {
      error: `annotations[${index}] invalid kind "${kind}". Must be one of: ${validKinds.join(", ")}`,
    };
  }

  return {
    source: String(obj.source),
    kind: kind as ExternalAnnotationKind,
    ...(typeof obj.filePath === "string" && { filePath: obj.filePath }),
    ...(typeof obj.selectedText === "string" && {
      selectedText: obj.selectedText,
    }),
    ...(typeof obj.lineStart === "number" && { lineStart: obj.lineStart }),
    ...(typeof obj.lineEnd === "number" && { lineEnd: obj.lineEnd }),
    ...(typeof obj.comment === "string" && { comment: obj.comment }),
    ...(typeof obj.suggestedCode === "string" && {
      suggestedCode: obj.suggestedCode,
    }),
    ...(typeof obj.ruleId === "string" && { ruleId: obj.ruleId }),
    ...(typeof obj.url === "string" && { url: obj.url }),
    ...(obj.metadata &&
      typeof obj.metadata === "object" && {
        metadata: obj.metadata as Record<string, unknown>,
      }),
  };
}

// ---------------------------------------------------------------------------
// Annotation Store
// ---------------------------------------------------------------------------

type MutationListener = (event: ExternalAnnotationEvent) => void;

export interface AnnotationStore {
  /** Add annotations from validated input. Returns the created annotations. */
  add(inputs: AnnotationInput[]): ExternalAnnotation[];
  /** Remove an annotation by ID. Returns true if found. */
  remove(id: string): boolean;
  /** Remove all annotations from a specific source. Returns count removed. */
  clearBySource(source: string): number;
  /** Remove all annotations. Returns count removed. */
  clearAll(): number;
  /** Get all annotations (snapshot). */
  getAll(): ExternalAnnotation[];
  /** Monotonic version counter — incremented on every mutation. */
  readonly version: number;
  /** Register a listener for mutation events. Returns unsubscribe function. */
  onMutation(listener: MutationListener): () => void;
}

/**
 * Create an in-memory annotation store.
 *
 * The store is runtime-agnostic — it holds data and emits events.
 * HTTP transport (SSE broadcasting, request parsing) is handled by
 * the server-specific adapter (Bun or Pi).
 */
export function createAnnotationStore(): AnnotationStore {
  const annotations: ExternalAnnotation[] = [];
  const listeners = new Set<MutationListener>();
  let version = 0;

  function emit(event: ExternalAnnotationEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Don't let a failing listener break the store
      }
    }
  }

  function generateId(): string {
    // crypto.randomUUID is available in both Bun and Node 19+
    return crypto.randomUUID();
  }

  return {
    add(inputs) {
      const created: ExternalAnnotation[] = [];
      for (const input of inputs) {
        const annotation: ExternalAnnotation = {
          ...input,
          kind: input.kind ?? "comment",
          id: generateId(),
          createdAt: Date.now(),
        };
        annotations.push(annotation);
        created.push(annotation);
      }
      if (created.length > 0) {
        version++;
        emit({ type: "add", annotations: created });
      }
      return created;
    },

    remove(id) {
      const idx = annotations.findIndex((a) => a.id === id);
      if (idx === -1) return false;
      annotations.splice(idx, 1);
      version++;
      emit({ type: "remove", ids: [id] });
      return true;
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
