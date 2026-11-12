export { validateReplyTarget } from "./annotation-threads";

import {
  parseDiagramAdditionalTargets,
  parseDiagramAnchor,
  type DiagramAnchor,
} from "./diagram-anchor";
import { parseImageRegion, type ImageRegion } from "./image-region";
import {
  MAX_PAGE_URL_LENGTH,
  parseHtmlAdditionalTargets,
  parseHtmlElementAnchor,
  parseHtmlElementContext,
} from "./html-anchor";

/** Constraint for any annotation type the store can hold. */
export type StorableAnnotation = { id: string; source?: string };

export type ExternalAnnotationEvent<T = unknown> =
  | { type: "snapshot"; annotations: T[] }
  | { type: "add"; annotations: T[] }
  | { type: "remove"; ids: string[] }
  | { type: "clear"; source?: string }
  | { type: "update"; id: string; annotation: T }
  | { type: "session-closed"; by: "agent" | "session"; unsentAnnotations: number };

/** Heartbeat comment to keep SSE connections alive (sent every 30s). */
export const HEARTBEAT_COMMENT = ":\n\n";

/** Interval in ms between heartbeat comments. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Encode an event as an SSE `data:` line. */
export function serializeSSEEvent<T>(event: ExternalAnnotationEvent<T>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export interface ParseError {
  error: string;
}

function unwrapBody(body: unknown): Record<string, unknown>[] | ParseError {
  if (!body || typeof body !== "object") {
    return { error: "Request body must be a JSON object" };
  }

  const obj = body as Record<string, unknown>;

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

interface PlanAnnotation {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  type: string;
  text?: string;
  originalText: string;
  createdA: number;
  author?: string;
  source?: string;
  diagramAnchor?: DiagramAnchor;
  imageRegion?: ImageRegion;
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

    const type = typeof obj.type === "string" ? obj.type : "GLOBAL_COMMENT";
    if (!VALID_PLAN_TYPES.includes(type)) {
      return {
        error: `annotations[${i}] invalid type "${type}". Must be one of: ${VALID_PLAN_TYPES.join(", ")}`,
      };
    }

    if (type === "DELETION" && (typeof obj.originalText !== "string" || obj.originalText.length === 0)) {
      return { error: `annotations[${i}] DELETION type requires non-empty "originalText" field` };
    }

    // External agents that want sidebar-only feedback should use GLOBAL_COMMENT instead — without a
    // phrase to anchor to, a COMMENT renders as an empty quote bubble in the sidebar and exports as
    // `Feedback on: ""`.
    if (type === "COMMENT" && (typeof obj.originalText !== "string" || obj.originalText.length === 0)) {
      return {
        error: `annotations[${i}] COMMENT requires non-empty "originalText" field. Use GLOBAL_COMMENT for sidebar-only feedback.`,
      };
    }

    let diagramAnchor: DiagramAnchor | undefined;
    if (obj.diagramAnchor !== undefined) {
      const parsed = parseDiagramAnchor(obj.diagramAnchor);
      if (parsed === null) {
        return { error: `annotations[${i}] invalid "diagramAnchor" (expected { v: 1, family, kind, id | from + to, label, sourceLine })` };
      }
      diagramAnchor = parsed;
    }

    // An image region goes through the same fail-closed parser the export
    // and the feedback archive run: a malformed one is refused, never stored.
    let imageRegion: ImageRegion | undefined;
    if (obj.imageRegion !== undefined) {
      const parsed = parseImageRegion(obj.imageRegion);
      if (parsed === null) {
        return { error: `annotations[${i}] invalid "imageRegion" (expected { v: 1, src, sourceLine, box: { x, y, w, h }, naturalWidth, naturalHeight } with the box inside the image)` };
      }
      imageRegion = parsed;
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
      ...(diagramAnchor !== undefined && { diagramAnchor }),
      ...(imageRegion !== undefined && { imageRegion }),
    });
  }

  return { annotations };
}

interface ReviewAnnotation {
  id: string;
  type: string;
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
  severity?: string;
  reasoning?: string;
  reviewProfileLabel?: string;
  prUrl?: string;
  prNumber?: number;
  prTitle?: string;
  prRepo?: string;
  diffScope?: "layer" | "full-stack";
  commitSha?: string;
  commitSubject?: string;
  gitButlerDiffType?: string;
  gitButlerDiffLabel?: string;
  gitButlerBase?: string;
  gitButlerSnapshotId?: string;
}

const VALID_REVIEW_TYPES = ["comment", "suggestion", "concern"];
const VALID_SIDES = ["old", "new"];
const VALID_SCOPES = ["line", "file", "general"];

/** A review finding's placement, derived from what it carries. */
export type FindingPlacement = {
  scope: "line" | "file" | "general";
  filePath: string;
  lineStart: number;
  lineEnd: number;
};

export function classifyFindingPlacement(
  filePath: string,
  lineStart: number | null | undefined,
  lineEnd: number | null | undefined,
): FindingPlacement {
  const hasFile = filePath.length > 0;
  const hasLine = typeof lineStart === "number";
  if (hasFile && hasLine) {
    return {
      scope: "line",
      filePath,
      lineStart,
      lineEnd: typeof lineEnd === "number" ? lineEnd : lineStart,
    };
  }
  if (hasFile) {
    return { scope: "file", filePath, lineStart: 0, lineEnd: 0 };
  }
  return { scope: "general", filePath: "", lineStart: 0, lineEnd: 0 };
}

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

    const scope = typeof obj.scope === "string" ? obj.scope : "line";
    if (!VALID_SCOPES.includes(scope)) {
      return {
        error: `annotations[${i}] invalid scope "${scope}". Must be one of: ${VALID_SCOPES.join(", ")}`,
      };
    }

    let filePath = "";
    let lineStart = 0;
    let lineEnd = 0;
    if (scope !== "general") {
      const fp = requireString(obj, "filePath", i);
      if (typeof fp !== "string") return fp;
      filePath = fp;
      if (scope === "line") {
        if (typeof obj.lineStart !== "number") {
          return { error: `annotations[${i}] missing required "lineStart" field` };
        }
        if (typeof obj.lineEnd !== "number") {
          return { error: `annotations[${i}] missing required "lineEnd" field` };
        }
        lineStart = obj.lineStart;
        lineEnd = obj.lineEnd;
      } else {
        lineStart = typeof obj.lineStart === "number" ? obj.lineStart : 0;
        lineEnd = typeof obj.lineEnd === "number" ? obj.lineEnd : 0;
      }
    }

    const side = typeof obj.side === "string" ? obj.side : "new";
    if (!VALID_SIDES.includes(side)) {
      return {
        error: `annotations[${i}] invalid side "${side}". Must be one of: ${VALID_SIDES.join(", ")}`,
      };
    }

    const type = typeof obj.type === "string" ? obj.type : "comment";
    if (!VALID_REVIEW_TYPES.includes(type)) {
      return {
        error: `annotations[${i}] invalid type "${type}". Must be one of: ${VALID_REVIEW_TYPES.join(", ")}`,
      };
    }

    // Must have at least text or suggestedCode
    if (typeof obj.text !== "string" && typeof obj.suggestedCode !== "string") {
      return {
        error: `annotations[${i}] must have at least one of: text, suggestedCode`,
      };
    }

    if (
      obj.prNumber !== undefined &&
      (typeof obj.prNumber !== "number" || !Number.isSafeInteger(obj.prNumber) || obj.prNumber <= 0)
    ) {
      return { error: `annotations[${i}] invalid prNumber. Must be a positive integer` };
    }
    if (
      obj.diffScope !== undefined &&
      obj.diffScope !== "layer" &&
      obj.diffScope !== "full-stack"
    ) {
      return { error: `annotations[${i}] invalid diffScope. Must be one of: layer, full-stack` };
    }

    annotations.push({
      id: crypto.randomUUID(),
      type,
      scope,
      filePath,
      lineStart,
      lineEnd,
      side,
      text: typeof obj.text === "string" ? obj.text : undefined,
      suggestedCode: typeof obj.suggestedCode === "string" ? obj.suggestedCode : undefined,
      originalCode: typeof obj.originalCode === "string" ? obj.originalCode : undefined,
      createdAt: Date.now(),
      author: typeof obj.author === "string" ? obj.author : undefined,
      source,
      ...(typeof obj.severity === "string" && { severity: obj.severity }),
      ...(typeof obj.reasoning === "string" && { reasoning: obj.reasoning }),
      ...(typeof obj.reviewProfileLabel === "string" && { reviewProfileLabel: obj.reviewProfileLabel }),
      ...(typeof obj.prUrl === "string" && { prUrl: obj.prUrl }),
      ...(typeof obj.prNumber === "number" && { prNumber: obj.prNumber }),
      ...(typeof obj.prTitle === "string" && { prTitle: obj.prTitle }),
      ...(typeof obj.prRepo === "string" && { prRepo: obj.prRepo }),
      ...((obj.diffScope === "layer" || obj.diffScope === "full-stack") && { diffScope: obj.diffScope }),
      ...(typeof obj.commitSha === "string" && { commitSha: obj.commitSha }),
      ...(typeof obj.commitSubject === "string" && { commitSubject: obj.commitSubject }),
      ...(typeof obj.gitButlerDiffType === "string" && { gitButlerDiffType: obj.gitButlerDiffType }),
      ...(typeof obj.gitButlerDiffLabel === "string" && { gitButlerDiffLabel: obj.gitButlerDiffLabel }),
      ...(typeof obj.gitButlerBase === "string" && { gitButlerBase: obj.gitButlerBase }),
      ...(typeof obj.gitButlerSnapshotId === "string" && { gitButlerSnapshotId: obj.gitButlerSnapshotId }),
    });
  }

  return { annotations };
}

type MutationListener<T> = (event: ExternalAnnotationEvent<T>) => void;

export interface AnnotationStore<T extends StorableAnnotation> {
  add(items: T[]): T[];
  remove(id: string): boolean;
  clearBySource(source: string): number;
  // `id` and `source` are pinned: `source` gates skill-instruction injection in exports, so PATCH must not clear it.
  update(id: string, fields: Partial<T>): T | null;
  clearAll(): number;
  getAll(): T[];
  readonly version: number;
  onMutation(listener: MutationListener<T>): () => void;
}

/** Create an in-memory annotation store. */
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
      const patch = { ...fields } as Record<string, unknown>;
      delete patch.id;
      delete patch.source;
      const merged = { ...annotations[idx], ...(patch as Partial<T>) } as T;
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

export type AnnotationPatchMode = "plan" | "review";

type FieldValidator = (value: unknown) => { value: unknown } | ParseError;

const MAX_DIAGRAM_ADDITIONAL_TARGETS = 16;
const MAX_PATCH_IMAGES = 50;
const MAX_PATCH_IMAGE_STRING = 4096;

const ok = (value: unknown): { value: unknown } => ({ value });

const str: FieldValidator = (value) =>
  typeof value === "string" ? ok(value) : { error: "must be a string" };

const bool: FieldValidator = (value) =>
  typeof value === "boolean" ? ok(value) : { error: "must be a boolean" };

const finiteNumber: FieldValidator = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? ok(value)
    : { error: "must be a finite number" };

const positiveInt: FieldValidator = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? ok(value)
    : { error: "must be a positive integer" };

const oneOf =
  (values: readonly string[]): FieldValidator =>
  (value) =>
    typeof value === "string" && values.includes(value)
      ? ok(value)
      : { error: `must be one of: ${values.join(", ")}` };

const cappedStr =
  (max: number): FieldValidator =>
  (value) =>
    typeof value === "string" && value.length <= max
      ? ok(value)
      : { error: `must be a string of at most ${max} characters` };

const imageList: FieldValidator = (value) => {
  if (!Array.isArray(value)) return { error: "must be an array" };
  if (value.length > MAX_PATCH_IMAGES) {
    return { error: `must have at most ${MAX_PATCH_IMAGES} entries` };
  }
  const out: Array<{ path: string; name: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: "entries must be { path, name } objects" };
    }
    const { path, name } = entry as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATCH_IMAGE_STRING) {
      return { error: 'entries need a non-empty string "path"' };
    }
    if (typeof name !== "string" || name.length > MAX_PATCH_IMAGE_STRING) {
      return { error: 'entries need a string "name"' };
    }
    out.push({ path, name });
  }
  return ok(out);
};

const viaParser =
  <T>(parse: (value: unknown) => T | null | undefined, hint: string): FieldValidator =>
  (value) => {
    const parsed = parse(value);
    if (parsed === null || parsed === undefined) return { error: hint };
    return ok(parsed);
  };

/** Lenient array parsers (junk entries are dropped, never fatal) still
 *  require an array: a scalar is a caller error worth reporting. */
const viaArrayParser =
  <T>(parse: (value: unknown) => T[]): FieldValidator =>
  (value) =>
    Array.isArray(value) ? ok(parse(value)) : { error: "must be an array" };

const PLAN_PATCH_FIELDS: Record<string, FieldValidator> = {
  type: oneOf(VALID_PLAN_TYPES),
  text: str,
  originalText: str,
  author: str,
  images: imageList,
  isQuickLabel: bool,
  quickLabelTip: str,
  diffContext: oneOf(["added", "removed", "modified"]),
  pageUrl: cappedStr(MAX_PAGE_URL_LENGTH),
  prUrl: str,
  inReplyTo: str,
  blockId: str,
  startOffset: finiteNumber,
  endOffset: finiteNumber,
  diagramAnchor: viaParser(
    parseDiagramAnchor,
    'expected { v: 1, family, kind, id | from + to, label, sourceLine }',
  ),
  diagramAdditionalTargets: viaArrayParser((value) =>
    parseDiagramAdditionalTargets(value, MAX_DIAGRAM_ADDITIONAL_TARGETS),
  ),
  imageRegion: viaParser(
    parseImageRegion,
    'expected { v: 1, src, sourceLine, box: { x, y, w, h }, naturalWidth, naturalHeight } with the box inside the image',
  ),
  htmlAnchor: viaParser(
    parseHtmlElementAnchor,
    'expected { selector, tagName, text?, point? }',
  ),
  htmlAdditionalTargets: viaArrayParser((value) => parseHtmlAdditionalTargets(value)),
  elementContext: viaParser(
    parseHtmlElementContext,
    'expected a bounded element description carrying a "tag"',
  ),
};

const REVIEW_PATCH_FIELDS: Record<string, FieldValidator> = {
  type: oneOf(VALID_REVIEW_TYPES),
  scope: oneOf(VALID_SCOPES),
  side: oneOf(VALID_SIDES),
  filePath: str,
  lineStart: finiteNumber,
  lineEnd: finiteNumber,
  charStart: finiteNumber,
  charEnd: finiteNumber,
  tokenText: str,
  selectedText: str,
  selectedTextFromEdits: bool,
  text: str,
  suggestedCode: str,
  originalCode: str,
  images: imageList,
  author: str,
  severity: oneOf(["important", "nit", "pre_existing"]),
  reasoning: str,
  reviewProfileLabel: str,
  conventionalLabel: str,
  decorations: (value) => {
    if (!Array.isArray(value)) return { error: "must be an array" };
    const allowed = ["blocking", "non-blocking", "if-minor"];
    for (const entry of value) {
      if (typeof entry !== "string" || !allowed.includes(entry)) {
        return { error: `entries must be one of: ${allowed.join(", ")}` };
      }
    }
    return ok([...value]);
  },
  inReplyTo: str,
  prUrl: str,
  prNumber: positiveInt,
  prTitle: str,
  prRepo: str,
  diffScope: oneOf(["layer", "full-stack"]),
  commitSha: str,
  commitSubject: str,
  gitButlerDiffType: str,
  gitButlerDiffLabel: str,
  gitButlerBase: str,
  gitButlerSnapshotId: str,
};

const NON_CLEARABLE_FIELDS = new Set([
  "type",
  "originalText",
  "blockId",
  "startOffset",
  "endOffset",
  "scope",
  "side",
  "filePath",
  "lineStart",
  "lineEnd",
  "diagramAnchor",
  "diagramAdditionalTargets",
  "imageRegion",
  "htmlAnchor",
  "htmlAdditionalTargets",
  "elementContext",
]);

/** Validate and narrow a PATCH body for `mode`. */
export function validateAnnotationPatch(
  mode: AnnotationPatchMode,
  body: unknown,
): { fields: Record<string, unknown> } | ParseError {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "Request body must be a JSON object" };
  }
  const fieldsByName = mode === "plan" ? PLAN_PATCH_FIELDS : REVIEW_PATCH_FIELDS;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "id" || key === "source" || key === "__proto__") continue;
    const validator = fieldsByName[key];
    if (!validator) continue;
    if (value === undefined) continue;
    if (value === null) {
      if (NON_CLEARABLE_FIELDS.has(key)) {
        return { error: `invalid "${key}": must not be null` };
      }
      fields[key] = undefined;
      continue;
    }
    const result = validator(value);
    if ("error" in result) return { error: `invalid "${key}": ${result.error}` };
    fields[key] = result.value;
  }
  return { fields };
}
