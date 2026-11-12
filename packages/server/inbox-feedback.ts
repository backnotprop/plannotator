import {
  FEEDBACK_UNAVAILABLE,
  feedbackAgentNames,
  feedbackInputError,
  feedbackOsName,
  productFeedbackPayload,
  productFeedbackUrl,
  sendProductFeedback,
  type FeedbackCategory,
  type ProductFeedbackPayload,
  type ProductFeedbackResult,
} from "@plannotator/core/product-feedback";
import { INBOX_AGENT_IDS, INBOX_AGENT_LABELS, INBOX_HOST_NAMES, type InboxAuthor } from "@plannotator/core/inbox-types";
import { AGENT_CONFIG } from "@plannotator/core/agents";

export const INBOX_FEEDBACK_PATH = "/api/inbox/feedback";

const BODY_KEYS = new Set(["message", "category", "contact", "serverSession"]);

export function feedbackAgentNameOfHost(host: string | null | undefined): string | null {
  if (!host) return null;
  if (Object.hasOwn(INBOX_HOST_NAMES, host)) return INBOX_HOST_NAMES[host]!;
  if ((INBOX_AGENT_IDS as readonly string[]).includes(host)) return INBOX_AGENT_LABELS[host as keyof typeof INBOX_AGENT_LABELS];
  if (Object.hasOwn(AGENT_CONFIG, host)) return AGENT_CONFIG[host as keyof typeof AGENT_CONFIG].name;
  return null;
}

export function inboxFeedbackAgents(messages: Iterable<{ author: InboxAuthor; created_at?: string | null }>): string[] {
  const lastUsed = new Map<string, string>();
  for (const message of messages) {
    if (message.author.kind !== "agent" || typeof message.created_at !== "string") continue;
    const name = feedbackAgentNameOfHost(message.author.host);
    if (!name) continue;
    const at = lastUsed.get(name);
    if (at === undefined || message.created_at > at) lastUsed.set(name, message.created_at!);
  }
  const newestFirst = [...lastUsed].sort((a, b) => b[1].localeCompare(a[1]) || a[0].localeCompare(b[0])).map(([name]) => name);
  return feedbackAgentNames(newestFirst);
}

export interface InboxFeedbackStore {
  threadIds(): readonly string[];
  threadMessageIds(threadId: string): readonly string[];
  message(id: string): { author: InboxAuthor; created_at?: string | null } | null;
}

export function inboxStoreFeedbackAgents(store: InboxFeedbackStore): string[] {
  function* messages() {
    for (const threadId of store.threadIds()) {
      for (const id of store.threadMessageIds(threadId)) {
        const message = store.message(id);
        if (message) yield message;
      }
    }
  }
  return inboxFeedbackAgents(messages());
}

export function createInboxFeedback(options: {
  version: string;
  json: (body: unknown, status?: number) => Response;
  url?: () => string;
  send?: (payload: ProductFeedbackPayload, url: string) => Promise<ProductFeedbackResult>;
  platform?: string;
  store: InboxFeedbackStore;
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
    let agents: string[] = [];
    try {
      agents = inboxStoreFeedbackAgents(options.store);
    } catch {
      agents = [];
    }
    const result = await send(productFeedbackPayload(input, { version: options.version, os, surface: "inbox", agents }), url()).catch(
      (): ProductFeedbackResult => ({ ok: false, reason: FEEDBACK_UNAVAILABLE, unavailable: true }),
    );
    if (result.ok) return json({ ok: true });
    return json({ error: result.reason, code: "feedback_not_sent" }, 502);
  };

  return { route };
}
