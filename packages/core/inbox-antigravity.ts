/**
 * Google Antigravity's pure parts for the Inbox: how a conversation is named,
 * how an MCP call says which conversation it comes from, and what a
 * hand-over from inside a conversation holds. Browser-safe, no I/O (the wake
 * is packages/server/inbox-antigravity-wake.ts).
 *
 * Antigravity (the `agy` CLI, the Antigravity App and the Antigravity IDE)
 * reaches the Inbox through MCP: the stdio shim, which the connect step adds
 * to `~/.gemini/config/mcp_config.json`, the file all three read. Its MCP
 * client names the conversation on every `tools/call`
 * (`_meta["antigravity.google/conversation_id"]`, beside its root
 * conversation and its artifacts folder, which names the product's data
 * folder: `~/.gemini/antigravity-cli`, `~/.gemini/antigravity` or
 * `~/.gemini/antigravity-ide`). It puts no Antigravity variable in its MCP
 * servers' environment, and its hooks get only the conversation id.
 *
 * The Inbox puts a reply in with `agentapi send-message <conversation id>
 * <text>`, which needs the conversation's language server
 * (`ANTIGRAVITY_LS_ADDRESS`) and its token (`ANTIGRAVITY_CSRF_TOKEN`). The App
 * and the IDE publish both in `<data folder>/daemon/hub_<port>.json`. The CLI
 * does not: they exist only in the environment of a command the agent runs,
 * so the agent hands them over once per agy launch with
 * `plannotator inbox antigravity` (INBOX_ANTIGRAVITY_LINK_COMMAND).
 */

/** The host id an Antigravity conversation is recorded under. */
export const INBOX_ANTIGRAVITY_HOST = "antigravity";

/** How the person sees an Antigravity conversation. */
export const INBOX_ANTIGRAVITY_NAME = "Antigravity";

/** The `_meta` keys Antigravity's MCP client puts on every `tools/call` (agy 1.5.9, App 2.32.1). */
export const INBOX_ANTIGRAVITY_CONVERSATION_META_KEY = "antigravity.google/conversation_id";
export const INBOX_ANTIGRAVITY_ROOT_META_KEY = "antigravity.google/root_conversation_id";
export const INBOX_ANTIGRAVITY_ARTIFACTS_META_KEY = "antigravity.google/artifacts_dir";

/** The command the agent runs in its own shell to hand its conversation's agent API to the Inbox. */
export const INBOX_ANTIGRAVITY_LINK_COMMAND = "plannotator inbox antigravity";

/** Antigravity's products, by their data folder under `~/.gemini`. */
export type InboxAntigravityProduct = "cli" | "app" | "ide";
export const INBOX_ANTIGRAVITY_DATA_DIRS: Readonly<Record<InboxAntigravityProduct, string>> = {
  cli: "antigravity-cli",
  app: "antigravity",
  ide: "antigravity-ide",
};

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An Antigravity conversation id: a UUID. Nothing else is taken as one: it names a claim folder and an argument. */
export function isAntigravityConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}

/** The product whose data folder holds `path` (`…/.gemini/<data folder>/brain/<id>`), or null. */
export function antigravityProductOfPath(path: unknown): InboxAntigravityProduct | null {
  if (typeof path !== "string") return null;
  const parts = path.split(/[\\/]+/);
  const brain = parts.lastIndexOf("brain");
  if (brain < 2 || parts[brain - 2] !== ".gemini") return null;
  const dir = parts[brain - 1];
  for (const [product, name] of Object.entries(INBOX_ANTIGRAVITY_DATA_DIRS)) if (dir === name) return product as InboxAntigravityProduct;
  return null;
}

/**
 * The conversation an MCP call comes from, as Antigravity names it in the
 * call's `_meta`, or null. A subagent's call (its conversation is not its
 * root's) is null too: a subagent ends with its task, so nothing is woken for
 * it, and the call is filed as the shim's own session.
 */
export function antigravityConversationOfCall(meta: unknown): { conversation: string; product: InboxAntigravityProduct | null } | null {
  if (!meta || typeof meta !== "object") return null;
  const record = meta as Record<string, unknown>;
  const conversation = record[INBOX_ANTIGRAVITY_CONVERSATION_META_KEY];
  if (!isAntigravityConversationId(conversation)) return null;
  const root = record[INBOX_ANTIGRAVITY_ROOT_META_KEY];
  if (root !== undefined && (typeof root !== "string" || root.toLowerCase() !== conversation.toLowerCase())) return null;
  return { conversation, product: antigravityProductOfPath(record[INBOX_ANTIGRAVITY_ARTIFACTS_META_KEY]) };
}

/**
 * A language server address as Antigravity gives it (`localhost:56548`), or
 * null. Only this computer's loopback: the token goes nowhere else.
 */
export function antigravityLoopbackAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(?:https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})\/?$/.exec(value.trim());
  if (!match) return null;
  const port = Number(match[2]);
  return port > 0 && port < 65536 ? `${match[1]}:${port}` : null;
}

/** A CSRF token as Antigravity gives it: printable, no spaces, bounded. */
export function isAntigravityToken(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);
}

/** Where under `inbox/` a CLI conversation's hand-over is kept (`<conversation id>.json`, 0600). */
export const INBOX_ANTIGRAVITY_LINKS_FOLDER = ["antigravity", "links"] as const;

/** What a CLI conversation hands over (`plannotator inbox antigravity`). The token is a secret. */
export interface InboxAntigravityLink {
  conversation: string;
  address: string;
  token: string;
  at: string;
  /** The agy process the conversation runs in, when it was found: the hand-over ends with it. */
  pid?: number;
}
