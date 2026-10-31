import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describeFsError } from "./agent-files";

/** A file uninstall must read to finish, and why it could not. Nothing is written to it. */
export type Unreadable = { file: string; reason: string };

export type HostReferences = {
  /** What the host's own remove command takes away. While any is left, the CLI stays. */
  references: string[];
  /** Installs in another scope (a project's), which that command leaves. Named in a warning only. */
  otherScopes: OtherScope[];
  unreadable: Unreadable[];
};

export type OtherScope = { field: string; scope: string; project: string | null };

type JsonRead =
  | { kind: "missing" }
  | { kind: "value"; value: unknown }
  | { kind: "unreadable"; unreadable: Unreadable };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function readJson(file: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (missing(error)) return { kind: "missing" };
    return { kind: "unreadable", unreadable: { file, reason: describeFsError(error) } };
  }
  // An empty file holds nothing; a BOM (Windows editors) is not part of the JSON.
  if (!text.trim()) return { kind: "missing" };
  try {
    return { kind: "value", value: JSON.parse(text.replace(/^﻿/, "")) };
  } catch {
    return { kind: "unreadable", unreadable: { file, reason: "it is not valid JSON" } };
  }
}

function objectFile(file: string): { value: Record<string, unknown> | null; unreadable: Unreadable[] } {
  const read = readJson(file);
  if (read.kind === "missing") return { value: null, unreadable: [] };
  if (read.kind === "unreadable") return { value: null, unreadable: [read.unreadable] };
  const value = record(read.value);
  return { value, unreadable: value ? [] : [{ file, reason: "it is not a JSON object" }] };
}

export function enabledPluginReferences(file: string, id: string): HostReferences {
  const field = `enabledPlugins[${JSON.stringify(id)}]`;
  const read = objectFile(file);
  const enabled = record(read.value?.enabledPlugins);
  return { references: enabled?.[id] === true ? [`${file}, ${field}`] : [], otherScopes: [], unreadable: read.unreadable };
}

/**
 * Claude Code's and Droid's plugin records: `enabledPlugins` in the user's
 * settings.json, and one `installed_plugins.json` entry per scope. `--scope
 * user` removes only the user's; a project's or a managed one stays, so it
 * is named, never waited for. An entry with no scope predates scopes: the user's.
 */
export function pluginReferences(directory: string, id: string): HostReferences {
  const enabled = enabledPluginReferences(join(directory, "settings.json"), id);
  const file = join(directory, "plugins", "installed_plugins.json");
  const installed = objectFile(file);
  const entries = record(installed.value?.plugins)?.[id];
  const installs: string[] = [];
  const otherScopes: OtherScope[] = [];
  if (Array.isArray(entries)) {
    entries.forEach((entry: unknown, index) => {
      const field = `${file}, plugins[${JSON.stringify(id)}][${index}]`;
      const scope = record(entry)?.scope;
      if (typeof scope !== "string" || scope === "user") {
        installs.push(field);
        return;
      }
      const project = record(entry)?.projectPath;
      otherScopes.push({ field, scope, project: typeof project === "string" ? project : null });
    });
  }
  // A user enabledPlugins key counts even with no user install: Claude Code installs (or rescopes) the plugin
  // for the user from it at its next start.
  return { references: [...enabled.references, ...installs], otherScopes, unreadable: [...enabled.unreadable, ...installed.unreadable] };
}

export function piPackageReferences(file: string): HostReferences {
  const read = objectFile(file);
  const packages = read.value?.packages;
  return {
    otherScopes: [],
    unreadable: read.unreadable,
    references: Array.isArray(packages) ? packages.flatMap((entry: unknown, index) => {
      const source = typeof entry === "string" ? entry : record(entry)?.source;
      return typeof source === "string" && /^npm:@plannotator\/pi-extension(?:@|$)/.test(source)
        ? [`${file}, packages[${index}]${typeof entry === "string" ? "" : ".source"}`]
        : [];
    }) : [],
  };
}

export function directoryReferences(directory: string, prefix: string): HostReferences {
  try {
    return {
      references: readdirSync(directory).filter((entry) => entry.startsWith(prefix)).map((entry) => join(directory, entry)),
      otherScopes: [],
      unreadable: [],
    };
  } catch (error) {
    return { references: [], otherScopes: [], unreadable: missing(error) ? [] : [{ file: directory, reason: describeFsError(error) }] };
  }
}

/** VS Code can unregister an extension while leaving its files for later cleanup. */
export function vscodeReferences(directory: string): HostReferences {
  const id = "backnotprop.plannotator-webview";
  const file = join(directory, "extensions.json");
  const registry = readJson(file);
  if (registry.kind === "unreadable") return { references: [], otherScopes: [], unreadable: [registry.unreadable] };
  if (registry.kind === "value") {
    if (!Array.isArray(registry.value)) {
      return { references: [], otherScopes: [], unreadable: [{ file, reason: "it is not a JSON array" }] };
    }
    return {
      references: registry.value.flatMap((entry: unknown, index) => {
        const identifier = record(record(entry)?.identifier)?.id;
        return typeof identifier === "string" && identifier.toLowerCase() === id
          ? [`${file}, [${index}].identifier.id (${id})`]
          : [];
      }),
      otherScopes: [],
      unreadable: [],
    };
  }
  // Older installations may not have a registration index. Honor their removal markers.
  const directories = directoryReferences(directory, `${id}-`);
  if (directories.references.length === 0) return directories;
  const obsolete = objectFile(join(directory, ".obsolete"));
  return {
    references: directories.references.filter((path) => obsolete.value?.[path.slice(directory.length + 1)] !== true),
    otherScopes: [],
    unreadable: [...directories.unreadable, ...obsolete.unreadable],
  };
}
