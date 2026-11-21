import { basename, isAbsolute } from "node:path";
import { simpleShellCommandWords } from "@plannotator/shared/plannotator-tool";
import { parseT3HookCommand } from "@plannotator/shared/t3-hook-command";

type HookSuffix = "" | "improve-context" | "t3-hook";
export type ManagedHookSpec = { readonly event: string; readonly matcher?: string; readonly suffix: HookSuffix };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameCommand(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = left.replace(/\\/g, "/");
  const normalizedRight = right.replace(/\\/g, "/");
  return platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** Read a literal executable, never shell wrappers or commands that merely mention it. */
function commandParts(command: string) {
  const match = /^(?:"([^"$`]+)"|'([^']+)'|([^\s"';&|<>()$`*?\[{}]+))(?=\s|[;&|<>()]|$)([\s\S]*)$/.exec(command.trim());
  if (!match) return null;
  const executable = match[1] ?? match[2] ?? match[3];
  if (!executable) return null;
  const tail = match[4] ?? "";
  // Trimming the tail must not turn a shell command separator into whitespace.
  return { executable, args: /[\r\n]/.test(tail) ? null : simpleShellCommandWords(tail) };
}

function isPlannotatorExecutable(
  executable: string,
  binaryPaths: readonly string[],
  platform: NodeJS.Platform,
  allowRelocatedBinary: boolean,
): boolean {
  if (executable === "plannotator") return true;
  if (platform === "win32" && /^(?:plannotator|plannotator\.exe)$/i.test(executable)) return true;
  if (binaryPaths.some((path) => sameCommand(executable, path, platform))) return true;
  if (!allowRelocatedBinary || !isAbsolute(executable)) return false;
  const name = basename(executable).toLowerCase();
  return name === "plannotator" || name === "plannotator.exe";
}

/** The whole command is an install path, as written: install.sh writes the Codex hook unquoted, so a path with spaces is one word there. */
function isBinaryPathCommand(command: string, binaryPaths: readonly string[], tail: string, platform: NodeJS.Platform): boolean {
  const trimmed = command.trim();
  return binaryPaths.some((path) => sameCommand(trimmed, `${path}${tail}`, platform));
}

/** Only supported hook arguments are safe to remove automatically. */
export function isManagedHook(
  value: unknown,
  binaryPaths: readonly string[],
  suffix: HookSuffix,
  platform: NodeJS.Platform,
  allowRelocatedBinary = false,
): boolean {
  const hook = asRecord(value);
  if (!hook || hook.type !== "command" || typeof hook.command !== "string") return false;
  if (suffix === "t3-hook") {
    const parsed = parseT3HookCommand(hook.command);
    return parsed !== undefined && isPlannotatorExecutable(parsed.executable, binaryPaths, platform, false);
  }
  if (isBinaryPathCommand(hook.command, binaryPaths, suffix ? ` ${suffix}` : "", platform)) return true;
  const parsed = commandParts(hook.command);
  if (!parsed || !parsed.args || !isPlannotatorExecutable(parsed.executable, binaryPaths, platform, allowRelocatedBinary)) return false;

  const remaining: string[] = [];
  let browserSeen = false;
  for (let index = 0; index < parsed.args.length; index++) {
    const arg = parsed.args[index];
    if (arg !== "--browser") {
      if (arg !== undefined) remaining.push(arg);
      continue;
    }
    const browser = parsed.args[++index];
    if (browserSeen || !browser || browser.startsWith("-")) return false;
    browserSeen = true;
  }
  return suffix === ""
    ? remaining.length === 0
    : remaining.length === 1 && remaining[0] === suffix;
}

/** Split only outside quotes/comments. These segments are inspected, never executed or auto-removed. */
function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let comment = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (comment) {
      if (char !== "\n" && char !== "\r") continue;
      comment = false;
      start = index + 1;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      index++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#" && (index === start || /\s/.test(command[index - 1] ?? ""))) {
      segments.push(command.slice(start, index));
      comment = true;
      continue;
    }
    if (char && ";&|()\r\n".includes(char)) {
      segments.push(command.slice(start, index));
      start = index + 1;
    }
  }
  if (!comment) segments.push(command.slice(start));
  return segments;
}

/** Skip literal shell assignments, keeping quoted values intact. */
function withoutAssignments(segment: string): string {
  let rest = segment.trimStart();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest)) {
    let quote: "'" | '"' | null = null;
    let index = 0;
    for (; index < rest.length; index++) {
      const char = rest[index];
      if (char === "\\" && quote !== "'") { index++; continue; }
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === "'" || char === '"') { quote = char; continue; }
      if (char && /\s/.test(char)) break;
    }
    rest = rest.slice(index).trimStart();
  }
  return rest;
}

/** Find surviving invocations in any event/matcher, including commands we must not edit. */
export function remainingHookReferences(
  config: unknown,
  binaryPaths: readonly string[],
  platform: NodeJS.Platform,
  allowRelocatedBinary: boolean,
  projectedRemovals: readonly ManagedHookSpec[] = [],
  removedVibeIndices: ReadonlySet<number> = new Set(),
): string[] {
  const root = asRecord(config);
  const invokesPlannotator = (command: unknown): boolean => {
    if (typeof command !== "string") return false;
    // An install path written unquoted, spaces and all, as its first word.
    const trimmed = command.trim();
    if (binaryPaths.some((path) => sameCommand(trimmed.slice(0, path.length), path, platform) && /^(?:\s|$)/.test(trimmed.slice(path.length)))) return true;
    const gated = parseT3HookCommand(command)?.executable;
    if (gated && isPlannotatorExecutable(gated, binaryPaths, platform, allowRelocatedBinary)) return true;
    return commandSegments(command).some((segment) => {
      const executable = commandParts(withoutAssignments(segment))?.executable;
      return executable !== undefined && isPlannotatorExecutable(executable, binaryPaths, platform, allowRelocatedBinary);
    });
  };
  // Vibe stores commands directly in [[hooks]], rather than nested event entries.
  if (Array.isArray(root?.hooks)) {
    return root.hooks.flatMap((value: unknown, index) =>
      !removedVibeIndices.has(index) && invokesPlannotator(asRecord(value)?.command) ? [`hooks[${index}].command`] : [],
    );
  }
  const hooks = root ? asRecord(root.hooks) : null;
  if (!hooks) return [];
  const references: string[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    entries.forEach((value: unknown, entryIndex) => {
      const entry = asRecord(value);
      if (!entry || !Array.isArray(entry.hooks)) return;
      entry.hooks.forEach((value: unknown, hookIndex: number) => {
        const hook = asRecord(value);
        if (!hook || hook.type !== "command" || typeof hook.command !== "string") return;
        const willRemove = projectedRemovals.some((spec) => spec.event === event
          && (spec.matcher === undefined || spec.matcher === entry.matcher)
          && isManagedHook(hook, binaryPaths, spec.suffix, platform, allowRelocatedBinary));
        if (!willRemove && invokesPlannotator(hook.command)) {
          references.push(`hooks.${event}[${entryIndex}].hooks[${hookIndex}].command`);
        }
      });
    });
  }
  return references;
}
