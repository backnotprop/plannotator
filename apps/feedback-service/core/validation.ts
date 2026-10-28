// Validation for one piece of product feedback. Pure functions: the handler
// and the tests share them, and nothing here touches storage.
//
// The client copy of these limits is packages/core/product-feedback.ts;
// test/limits.test.ts keeps the two in step.

export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CONTACT_MAX = 200;
export const FEEDBACK_VERSION_MAX = 40;
export const FEEDBACK_OS_MAX = 40;

export const FEEDBACK_CATEGORIES = ["bug", "idea", "other"] as const;
export const FEEDBACK_SURFACES = [
  "inbox",
  "plan-review",
  "code-review",
  "annotate",
  "cli",
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export type FeedbackSurface = (typeof FEEDBACK_SURFACES)[number];

/** The only keys a body may carry. Anything else is refused, never ignored. */
const ALLOWED_KEYS = new Set([
  "message",
  "category",
  "contact",
  "version",
  "os",
  "surface",
]);

export interface NormalizedFeedback {
  message: string;
  category: FeedbackCategory | null;
  contact: string | null;
  version: string | null;
  os: string | null;
  surface: FeedbackSurface | null;
}

export class ValidationError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
  }
}

// A version or OS name is a short label: letters, digits and a few separators.
const LABEL_RE = /^[0-9A-Za-z][0-9A-Za-z .+_()-]*$/;
// C0 controls except tab and newline, and DEL. Stripped from free text.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Length in code points, so an emoji counts once. */
function lengthOf(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

function optionalText(raw: unknown, field: string, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new ValidationError(`${field} must be a string`);
  const value = raw.replace(CONTROL_RE, "").trim();
  if (!value) return null;
  if (lengthOf(value) > max) throw new ValidationError(`${field} is longer than ${max} characters`);
  return value;
}

function optionalLabel(raw: unknown, field: string, max: number): string | null {
  const value = optionalText(raw, field, max);
  if (value !== null && !LABEL_RE.test(value)) throw new ValidationError(`${field} has characters it may not have`);
  return value;
}

function optionalChoice<T extends string>(raw: unknown, field: string, choices: readonly T[]): T | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !(choices as readonly string[]).includes(raw)) {
    throw new ValidationError(`${field} must be one of: ${choices.join(", ")}`);
  }
  return raw as T;
}

export function normalizeFeedback(raw: unknown): NormalizedFeedback {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError("Body must be a JSON object");
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) throw new ValidationError(`Unknown field: ${key.slice(0, 40)}`);
  }

  if (typeof body.message !== "string") throw new ValidationError("message is required");
  const message = body.message.replace(CONTROL_RE, "").trim();
  if (!message) throw new ValidationError("message is required");
  if (lengthOf(message) > FEEDBACK_MESSAGE_MAX) {
    throw new ValidationError(`message is longer than ${FEEDBACK_MESSAGE_MAX} characters`);
  }

  return {
    message,
    category: optionalChoice(body.category, "category", FEEDBACK_CATEGORIES),
    contact: optionalText(body.contact, "contact", FEEDBACK_CONTACT_MAX),
    version: optionalLabel(body.version, "version", FEEDBACK_VERSION_MAX),
    os: optionalLabel(body.os, "os", FEEDBACK_OS_MAX),
    surface: optionalChoice(body.surface, "surface", FEEDBACK_SURFACES),
  };
}
