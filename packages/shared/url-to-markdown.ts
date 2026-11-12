import { htmlToMarkdown } from "./html-to-markdown";

export interface UrlToMarkdownOptions {
  useJina: boolean;
}

export interface UrlToMarkdownResult {
  markdown: string;
  source: "jina" | "fetch+turndown" | "fetch-raw" | "content-negotiation";
}

export const isConvertedSource = (source: UrlToMarkdownResult["source"]): boolean =>
  source === "jina" || source === "fetch+turndown";

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const PRIVATE_IPV4 = /^(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\.\d{1,3}\.\d{1,3}$/;
const PRIVATE_IPV6 = /^\[(::1|::ffff:|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;
function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    if (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      /^127\./.test(hostname) ||
      PRIVATE_IPV4.test(hostname)
    ) {
      return true;
    }
    if (PRIVATE_IPV6.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

export async function urlToMarkdown(
  url: string,
  options: UrlToMarkdownOptions,
): Promise<UrlToMarkdownResult> {
  const urlPath = url.split("?")[0].split("#")[0];
  if (/\.mdx?$/i.test(urlPath)) {
    const text = await fetchRawText(url);
    if (text !== null) {
      return { markdown: text, source: "fetch-raw" };
    }
  }

  const local = isLocalUrl(url);
  if (!local) {
    const negotiated = await fetchViaContentNegotiation(url);
    if (negotiated !== null) {
      return { markdown: negotiated, source: "content-negotiation" };
    }
  }

  if (options.useJina && !local) {
    try {
      const markdown = await fetchViaJina(url);
      return { markdown, source: "jina" };
    } catch (err) {
      process.stderr.write(
        `[plannotator] Warning: Jina Reader failed (${err instanceof Error ? err.message : String(err)}), falling back to direct fetch...\n`,
      );
    }
  }

  const markdown = await fetchViaTurndown(url);
  return { markdown, source: "fetch+turndown" };
}

async function readBodyWithLimit(res: Response): Promise<string> {
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const bytes = parseInt(contentLength, 10);
    if (bytes > MAX_BODY_BYTES) {
      res.body?.cancel();
      throw new Error(`Response too large (${Math.round(bytes / 1024 / 1024)}MB, max 10MB)`);
    }
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new Error(`Response too large (>${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB, max 10MB)`);
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_BODY_BYTES) {
      reader.cancel();
      throw new Error(`Response too large (>${Math.round(MAX_BODY_BYTES / 1024 / 1024)}MB, max 10MB)`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function fetchRawText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; Plannotator/1.0; +https://plannotator.ai)" };
  try {
    let currentUrl = url;
    let res = await fetch(currentUrl, { headers, redirect: "manual", signal: controller.signal });

    for (let i = 0; i < MAX_REDIRECTS && REDIRECT_STATUSES.has(res.status); i++) {
      const location = res.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
      if (isLocalUrl(currentUrl)) {
        throw new Error(`Redirect to private/local URL blocked: ${currentUrl}`);
      }
      res.body?.cancel();
      res = await fetch(currentUrl, { headers, redirect: "manual", signal: controller.signal });
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      res.body?.cancel();
      throw new Error("Too many redirects");
    }
    if (!res.ok) {
      res.body?.cancel();
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) {
      res.body?.cancel();
      return null;
    }
    return await readBodyWithLimit(res);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timed out fetching ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const NEGOTIATION_TIMEOUT_MS = 5_000;

async function fetchViaContentNegotiation(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NEGOTIATION_TIMEOUT_MS);
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; Plannotator/1.0; +https://plannotator.ai)",
    Accept: "text/markdown, text/html;q=0.9",
  };

  try {
    let currentUrl = url;
    let res = await fetch(currentUrl, { headers, redirect: "manual", signal: controller.signal });

    for (let i = 0; i < MAX_REDIRECTS && REDIRECT_STATUSES.has(res.status); i++) {
      const location = res.headers.get("location");
      if (!location) break;
      currentUrl = new URL(location, currentUrl).href;
      if (isLocalUrl(currentUrl)) {
        res.body?.cancel();
        return null;
      }
      res.body?.cancel();
      res = await fetch(currentUrl, { headers, redirect: "manual", signal: controller.signal });
    }

    if (!res.ok) {
      res.body?.cancel();
      return null;
    }

    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/markdown")) {
      res.body?.cancel();
      return null;
    }

    return await readBodyWithLimit(res);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchViaJina(url: string): Promise<string> {
  const cleanUrl = url.split("#")[0];
  const jinaUrl = `https://r.jina.ai/${cleanUrl}`;
  const headers: Record<string, string> = {
    Accept: "text/plain",
  };

  const apiKey = process.env.JINA_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(jinaUrl, { headers, signal: controller.signal });
    if (!res.ok) {
      res.body?.cancel();
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await readBodyWithLimit(res);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchViaTurndown(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (compatible; Plannotator/1.0; +https://plannotator.ai)",
    Accept: "text/html,application/xhtml+xml",
  };

  try {
    let currentUrl = url;
    let res = await fetch(currentUrl, { headers, redirect: "manual", signal: controller.signal });

    for (let i = 0; i < MAX_REDIRECTS && REDIRECT_STATUSES.has(res.status); i++) {
      const location = res.headers.get("location");
      if (!location) break;

      currentUrl = new URL(location, currentUrl).href;
      if (isLocalUrl(currentUrl)) {
        throw new Error(`Redirect to private/local URL blocked: ${currentUrl}`);
      }
      res.body?.cancel();
      res = await fetch(currentUrl, { headers, redirect: "manual", signal: controller.signal });
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      res.body?.cancel();
      throw new Error("Too many redirects");
    }
    if (!res.ok) {
      res.body?.cancel();
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      res.body?.cancel();
      throw new Error(
        `Not an HTML page (content-type: ${contentType})`,
      );
    }
    const html = await readBodyWithLimit(res);
    return htmlToMarkdown(html);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Timed out fetching ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
