export interface DiffPathPair {
  oldPath?: string;
  newPath?: string;
}

export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\t/g, "\t")
      .replace(/\\n/g, "\n");
  }
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
