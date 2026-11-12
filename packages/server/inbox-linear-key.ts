/**
 * The Linear key for the Inbox's Linear hover cards (inbox-linear-cards.ts), set in Settings → Accounts the way
 * Voice's OpenAI key is (inbox-voice.ts): a pasted key is kept in `<data dir>/inbox/linear-key` (0600, never in
 * config.json), and wins over `LINEAR_API_KEY` in the Inbox's environment. A page never gets the key: the last 4 of
 * a saved one at most (`state`).
 *
 * `POST /api/inbox/linear/key` `{ key: string | null }` saves or removes it; the caller (inbox.ts) refuses another
 * site and anyone but the owner, as for voice.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxLinearKeyState } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { InboxError } from "@plannotator/shared/inbox/schema";

export const LINEAR_KEY_FILE = join("inbox", "linear-key");

export interface LinearKey {
  /** The key the cards send to Linear: the saved one, else `LINEAR_API_KEY`; null when neither. */
  apiKey(): string | null;
  /** What Settings shows. Never the key. */
  state(): InboxLinearKeyState;
  /** `POST /api/inbox/linear/key`; null for any other path. */
  route(req: Request, path: string, via: string): Promise<Response | null>;
}

export function createLinearKey(options: {
  dataDir: string;
  serverSession: string;
  json: (body: unknown, status?: number) => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  env?: Record<string, string | undefined>;
  /** After a save or a removal (the cards forget what the old key saw). */
  changed?: () => void;
}): LinearKey {
  const { json } = options;
  const keyPath = join(options.dataDir, LINEAR_KEY_FILE);
  const env = options.env ?? process.env;
  const savedKey = (): string | null => {
    try {
      return readFileSync(keyPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  const envKey = (): string | null => env.LINEAR_API_KEY?.trim() || null;
  const writeKey = (key: string) => {
    mkdirSync(join(options.dataDir, "inbox"), { recursive: true, mode: 0o700 });
    const temp = `${keyPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${key}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, keyPath);
  };
  const state = (): InboxLinearKeyState => {
    const key = savedKey();
    if (key) return { source: "saved", last4: key.slice(-4) };
    return { source: envKey() ? "env" : null, last4: null };
  };
  return {
    // A key pasted here wins: it is what the page offers to replace or remove.
    apiKey: () => savedKey() ?? envKey(),
    state,
    async route(req, path, via) {
      if (path !== "/api/inbox/linear/key") return null;
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      // Over the tailnet a key travels only what `tailscale serve` took in over TLS, as voice's key.
      if (via !== "local" && req.headers.get("x-forwarded-proto") !== "https") {
        return json({ error: "An API key is accepted only over HTTPS.", code: "https_required" }, 403);
      }
      const body = await options.readBody(req);
      if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      if (body.key === null) rmSync(keyPath, { force: true });
      else if (typeof body.key === "string" && /^[\x21-\x7e]{8,512}$/.test(body.key.trim())) writeKey(body.key.trim());
      else throw new InboxError("validation_error", "key: that doesn't look like a Linear API key.", { field: "key" });
      options.changed?.();
      return json({ key: state() });
    },
  };
}
