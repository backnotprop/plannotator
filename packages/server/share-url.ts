import { compress } from "@plannotator/shared/compress";
import { encrypt } from "@plannotator/shared/crypto";

const DEFAULT_SHARE_BASE = "https://share.plannotator.ai";
const DEFAULT_PASTE_API = "https://plannotator-paste.plannotator.workers.dev";

export interface RemoteShareOptions {
  rawHtml?: string;
  pasteApiUrl?: string;
  fetchImpl?: typeof fetch;
}

export async function generateRemoteShareUrl(
  plan: string,
  shareBaseUrl?: string,
  options: RemoteShareOptions = {},
): Promise<string> {
  const base = shareBaseUrl || DEFAULT_SHARE_BASE;
  if (options.rawHtml) {
    // Callers starting from a local file should pass self-contained HTML so sibling assets survive leaving the machine.
    return generateRemotePasteShareUrl(
      { p: plan, a: [], h: options.rawHtml, r: "html" },
      base,
      options.pasteApiUrl,
      options.fetchImpl,
    );
  }
  const hash = await compress({ p: plan, a: [] });
  return `${base}/#${hash}`;
}

async function generateRemotePasteShareUrl(
  payload: unknown,
  shareBaseUrl: string,
  pasteApiUrl = DEFAULT_PASTE_API,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const compressed = await compress(payload);
  const { ciphertext, key } = await encrypt(compressed);

  const response = await fetchImpl(`${pasteApiUrl}/api/paste`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: ciphertext }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    throw new Error(await readPasteError(response, `Paste service returned ${response.status}`));
  }

  const result = (await response.json()) as { id?: unknown };
  if (typeof result.id !== "string" || !result.id) {
    throw new Error("Paste service response missing id");
  }

  const pasteParam =
    pasteApiUrl !== DEFAULT_PASTE_API
      ? `&paste=${base64UrlEncode(pasteApiUrl)}`
      : "";
  return `${shareBaseUrl}/p/${result.id}#key=${key}${pasteParam}`;
}

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function readPasteError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error.trim() ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 100 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
}

export async function writeRemoteShareLink(
  content: string,
  shareBaseUrl: string | undefined,
  verb: string,
  noun: string,
  options: RemoteShareOptions = {},
): Promise<void> {
  try {
    const shareUrl = await generateRemoteShareUrl(content, shareBaseUrl, options);
    const size = formatSize(new TextEncoder().encode(shareUrl).length);
    process.stderr.write(
      `\n  Open this link on your local machine to ${verb}:\n` +
      `  ${shareUrl}\n\n` +
      `  (${size} — ${noun}, annotations added in browser)\n\n`
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const pasteHint = options.rawHtml
      ? " HTML sharing uses the paste service; check PLANNOTATOR_PASTE_URL or try a smaller/self-contained HTML file."
      : "";
    process.stderr.write(
      `\n  Warning: could not create remote share link for ${noun}.\n` +
      `  ${reason}.${pasteHint}\n\n`
    );
  }
}
