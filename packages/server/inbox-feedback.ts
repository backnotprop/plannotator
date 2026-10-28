/**
 * Plannotator Inbox: the Feedback dialog's send (sidebar → Feedback,
 * packages/inbox/components/FeedbackDialog.tsx).
 *
 *   POST /api/inbox/feedback   `{ message, category?, contact? }` → `{ ok: true }`
 *
 * The window cannot reach the feedback Worker itself (its CSP allows
 * `connect-src 'self'` only), so this server forwards the person's words,
 * adding the Plannotator version and this computer's OS name and nothing
 * else, through the one client (`sendProductFeedback`, packages/core/
 * product-feedback.ts) the CLI's `plannotator feedback` also uses. A window
 * write like any other (same origin; the owner's page over the tailnet too).
 * Nothing is stored here and nothing is sent unless the person pressed Send.
 */

import {
  FEEDBACK_UNAVAILABLE,
  feedbackInputError,
  feedbackOsName,
  productFeedbackPayload,
  productFeedbackUrl,
  sendProductFeedback,
  type FeedbackCategory,
  type ProductFeedbackPayload,
  type ProductFeedbackResult,
} from "@plannotator/core/product-feedback";

export const INBOX_FEEDBACK_PATH = "/api/inbox/feedback";

// `serverSession`: every window POST carries it (packages/inbox/api.ts); it is not forwarded.
const BODY_KEYS = new Set(["message", "category", "contact", "serverSession"]);

export function createInboxFeedback(options: {
  version: string;
  json: (body: unknown, status?: number) => Response;
  /** Tests: where to send (default: `PLANNOTATOR_FEEDBACK_URL`, else the constant), and how. */
  url?: () => string;
  send?: (payload: ProductFeedbackPayload, url: string) => Promise<ProductFeedbackResult>;
  platform?: string;
}) {
  const { json } = options;
  const url = options.url ?? (() => productFeedbackUrl(process.env));
  const send = options.send ?? ((payload, to) => sendProductFeedback(payload, { url: to }));
  const os = feedbackOsName(options.platform ?? process.platform);

  const route = async (req: Request, path: string): Promise<Response | null> => {
    if (path !== INBOX_FEEDBACK_PATH) return null;
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "body: expected a JSON object.", code: "validation_error" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "body: expected a JSON object.", code: "validation_error" }, 400);
    }
    const fields = body as Record<string, unknown>;
    const unknown = Object.keys(fields).find((key) => !BODY_KEYS.has(key));
    if (unknown) return json({ error: `Unknown field: ${unknown.slice(0, 40)}`, code: "validation_error" }, 400);
    if (typeof fields.message !== "string") return json({ error: "Write your feedback first.", code: "validation_error" }, 400);
    if (fields.category != null && typeof fields.category !== "string") return json({ error: "category: a string.", code: "validation_error" }, 400);
    if (fields.contact != null && typeof fields.contact !== "string") return json({ error: "contact: a string.", code: "validation_error" }, 400);
    const input = { message: fields.message, category: (fields.category ?? null) as FeedbackCategory | null, contact: (fields.contact ?? null) as string | null };
    const invalid = feedbackInputError(input);
    if (invalid) return json({ error: invalid, code: "validation_error" }, 400);
    // sendProductFeedback answers within FEEDBACK_TIMEOUT_MS (8 s) and never throws; the catch keeps a thrown seam plain too.
    const result = await send(productFeedbackPayload(input, { version: options.version, os, surface: "inbox" }), url()).catch(
      (): ProductFeedbackResult => ({ ok: false, reason: FEEDBACK_UNAVAILABLE, unavailable: true }),
    );
    if (result.ok) return json({ ok: true });
    return json({ error: result.reason, code: "feedback_not_sent" }, 502);
  };

  return { route };
}
