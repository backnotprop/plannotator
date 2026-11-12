export interface DiffPathPair {
  oldPath?: string;
  newPath?: string;
}

const C_ESCAPES: Record<string, number> = {
  '"': 0x22, "\\": 0x5c, a: 0x07, b: 0x08, f: 0x0c,
  n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b,
};

export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  const decoder = new TextDecoder();
  let out = "";
  let pendingBytes: number[] = [];
  const flush = (): void => {
    if (pendingBytes.length > 0) {
      out += decoder.decode(new Uint8Array(pendingBytes));
      pendingBytes = [];
    }
  };
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] !== "\\") {
      flush();
      out += inner[i];
      continue;
    }
    const next = inner[i + 1];
    if (next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && inner[j] >= "0" && inner[j] <= "7") {
        oct += inner[j];
        j++;
      }
      pendingBytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
    } else if (next !== undefined && next in C_ESCAPES) {
      flush();
      out += String.fromCharCode(C_ESCAPES[next]);
      i++;
    } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(inner.slice(i + 2, i + 6))) {
      flush();
      out += String.fromCharCode(parseInt(inner.slice(i + 2, i + 6), 16));
      i += 5;
    } else {
      flush();
      out += "\\";
    }
  }
  flush();
  return out;
}

export function quoteGitPath(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return JSON.stringify(value);
}

function stripUnquotedPathMetadata(token: string): string {
  if (token.startsWith('"')) return token;
  const tabIndex = token.indexOf("\t");
  return tabIndex === -1 ? token : token.slice(0, tabIndex);
}

export function parsePatchPathToken(token: string, side: "a" | "b"): string | null {
  const pathToken = stripUnquotedPathMetadata(token);
  if (pathToken === "/dev/null") return "/dev/null";
  const unquoted = unquoteGitPath(pathToken);
  const prefix = `${side}/`;
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : null;
}

function scanHeaderToken(input: string): { token: string; rest: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed) return null;

  if (trimmed.startsWith('"')) {
    let escaped = false;
    for (let i = 1; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return { token: trimmed.slice(0, i + 1), rest: trimmed.slice(i + 1) };
      }
    }
    return null;
  }

  const space = trimmed.indexOf(" ");
  if (space === -1) return { token: trimmed, rest: "" };
  return { token: trimmed.slice(0, space), rest: trimmed.slice(space + 1) };
}

export function parseDiffGitHeader(header: string): DiffPathPair {
  const prefix = "diff --git ";
  if (!header.startsWith(prefix)) return {};

  const rest = header.slice(prefix.length);
  if (rest.trimStart().startsWith('"')) {
    const first = scanHeaderToken(rest);
    const second = first ? scanHeaderToken(first.rest) : null;
    if (first && second) {
      const oldPath = parsePatchPathToken(first.token, "a");
      const newPath = parsePatchPathToken(second.token, "b");
      return {
        oldPath: oldPath && oldPath !== "/dev/null" ? oldPath : undefined,
        newPath: newPath && newPath !== "/dev/null" ? newPath : undefined,
      };
    }
  }

  const match = header.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) return {};
  return { oldPath: match[1], newPath: match[2] };
}

export function formatPatchPathToken(side: "a" | "b", filePath: string): string {
  if (filePath === "/dev/null") return filePath;
  return quoteGitPath(`${side}/${filePath}`);
}

export function parseDiffMetadataPathToken(token: string): string {
  if (token === "/dev/null") return token;
  return unquoteGitPath(token);
}

export function formatDiffMetadataPathToken(filePath: string): string {
  if (filePath === "/dev/null") return filePath;
  return quoteGitPath(filePath);
}

export function parseDiffFilePathLines(lines: string[]): DiffPathPair {
  let oldPath: string | undefined;
  let newPath: string | undefined;

  for (const line of lines) {
    if (line.startsWith("@@ ") || line === "GIT binary patch") break;
    if (line.startsWith("--- ")) {
      const parsed = parsePatchPathToken(line.slice(4), "a");
      if (parsed && parsed !== "/dev/null") oldPath = parsed;
    } else if (line.startsWith("+++ ")) {
      const parsed = parsePatchPathToken(line.slice(4), "b");
      if (parsed && parsed !== "/dev/null") newPath = parsed;
    }
  }

  return { oldPath, newPath };
}

export const OVERSIZED_REVIEW_STUB_MARKER = "#plannotator-oversized-file";

export const OVERSIZED_REVIEW_STUB_LIMIT_LABEL = "5 MB";

export function isOversizedReviewStubPatch(patch: string): boolean {
  return patch.split("\n").some((line) => line === OVERSIZED_REVIEW_STUB_MARKER);
}

export function isContentlessBinaryPatch(patch: string): boolean {
  let hasBinaryMarker = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) return false;
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      hasBinaryMarker = true;
    }
  }
  return hasBinaryMarker;
}

export const REVIEW_IMAGE_PREVIEW_EXTENSIONS: readonly string[] = [
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "apng",
];

export const MAX_REVIEW_IMAGE_PREVIEW_BYTES = 10 * 1024 * 1024;
export const MAX_REVIEW_IMAGE_PREVIEW_LABEL = "10 MB";
export const MAX_REVIEW_IMAGE_PREVIEW_PIXELS = 50_000_000;

export function isReviewImagePath(path: string | undefined | null): boolean {
  if (!path) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return REVIEW_IMAGE_PREVIEW_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

export function isImagePreviewCandidate(
  patch: string,
  path: string,
  oldPath?: string,
): boolean {
  if (!isReviewImagePath(path) && !isReviewImagePath(oldPath)) return false;
  return !patch.split("\n").some((line) => line.startsWith("@@ "));
}

export function parseDiffMetadataPathLines(lines: string[]): DiffPathPair {
  let oldPath: string | undefined;
  let newPath: string | undefined;

  for (const line of lines) {
    if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      const parsed = parseDiffMetadataPathToken(line.slice(line.indexOf(" from ") + " from ".length));
      if (parsed !== "/dev/null") oldPath = parsed;
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      const parsed = parseDiffMetadataPathToken(line.slice(line.indexOf(" to ") + " to ".length));
      if (parsed !== "/dev/null") newPath = parsed;
    }
  }

  return { oldPath, newPath };
}
