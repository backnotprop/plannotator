/**
 * npm's side of package changes: `package.json`, and the lockfiles of npm,
 * Bun, pnpm and Yarn. Pure text parsing, no network, no dependencies; each
 * reader returns a short reason string instead of throwing.
 */
import type {
  PackageDepEntry,
  PackageDepTable,
  PackageEcosystem,
  PackageLockIndex,
  PackageSpecInfo,
} from "./package-changes";

export const NPM_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
/** npm's own name rules, enough to refuse anything that is not a package name. */
export function isValidNpmName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && NPM_NAME.test(name);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function addEntry(table: PackageDepTable, name: string, section: string, entry: PackageDepEntry): void {
  let sections = table.get(name);
  if (!sections) table.set(name, (sections = new Map()));
  sections.set(section, entry);
}

/** The dependency sections of a parsed `package.json`-shaped object. */
function depTableOf(json: Record<string, unknown>, versionOf?: (name: string) => string | null): PackageDepTable {
  const table: PackageDepTable = new Map();
  for (const section of NPM_SECTIONS) {
    const deps = json[section];
    if (!isObject(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== "string") continue;
      addEntry(table, name, section, { spec, version: versionOf?.(name) ?? null });
    }
  }
  return table;
}

export function readPackageJson(text: string): PackageDepTable | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (!isObject(json)) return "not a JSON object";
  return depTableOf(json);
}

/** Where a spec points, and the registry name behind an alias. */
export function classifyNpmSpec(name: string, spec: string): PackageSpecInfo {
  const s = spec.trim();
  if (s.startsWith("npm:")) {
    const rest = s.slice(4);
    const at = rest.lastIndexOf("@");
    const target = at > 0 ? rest.slice(0, at) : rest;
    const range = at > 0 ? rest.slice(at + 1) : "";
    return { source: "alias", registryName: isValidNpmName(target) ? target : null, floor: rangeFloor(range) };
  }
  if (s.startsWith("workspace:")) return { source: "workspace", registryName: null, floor: null };
  if (/^(file|link|portal|patch):/.test(s)) return { source: "local", registryName: null, floor: null };
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/.test(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) {
    return { source: "git", registryName: null, floor: null };
  }
  if (/^https?:\/\//.test(s)) return { source: "url", registryName: null, floor: null };
  const registryName = isValidNpmName(name) ? name : null;
  if (s === "" || s === "*" || s === "x" || /^[a-z][\w.-]*$/i.test(s)) return { source: "tag", registryName, floor: null };
  return { source: "registry", registryName, floor: rangeFloor(s) };
}

const VERSION_TOKEN = /(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?/;

/** The floor of a range, as written: `^8.16.3` → `8.16.3`, `>=18 <20` → `18`. */
export function rangeFloor(range: string): string | null {
  const m = VERSION_TOKEN.exec(range);
  if (!m) return null;
  let out = m[1];
  if (m[2] !== undefined && /\d/.test(m[2])) {
    out += `.${m[2]}`;
    if (m[3] !== undefined && /\d/.test(m[3])) out += `.${m[3]}`;
  }
  if (m[4] && m[2] !== undefined && m[3] !== undefined) out += `-${m[4]}`;
  return out;
}

interface Parsed { nums: [number, number, number]; pre: string | null }
function parseVersion(v: string): Parsed {
  const clean = v.replace(/^v/, "").split("+")[0];
  const dash = clean.indexOf("-");
  const core = dash < 0 ? clean : clean.slice(0, dash);
  const pre = dash < 0 ? null : clean.slice(dash + 1);
  const parts = core.split(".").map((p) => Number.parseInt(p, 10));
  return { nums: [parts[0] || 0, parts[1] || 0, parts[2] || 0], pre };
}

function comparePre(a: string, b: string): number {
  const x = a.split(".");
  const y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny) {
      const d = Number(x[i]) - Number(y[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (nx !== ny) return nx ? -1 : 1;
    else if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** -1, 0, 1 under semver precedence. */
export function compareSemver(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePre(pa.pre, pb.pre);
}

/** A breaking step under semver's caret rules: the major, the minor under 0.x, the patch under 0.0.x. */
export function isSemverBreakingStep(a: string, b: string): boolean {
  const x = parseVersion(a).nums;
  const y = parseVersion(b).nums;
  if (x[0] !== y[0]) return true;
  if (x[0] === 0 && x[1] !== y[1]) return true;
  if (x[0] === 0 && x[1] === 0 && x[2] !== y[2]) return true;
  return false;
}

/** `name@version` with a scoped name kept whole. */
function splitNameAtVersion(s: string): { name: string; version: string } | null {
  const at = s.indexOf("@", 1);
  if (at <= 0) return null;
  return { name: s.slice(0, at), version: s.slice(at + 1) };
}

function addPackage(packages: Map<string, Set<string>>, name: string, version: string): void {
  let set = packages.get(name);
  if (!set) packages.set(name, (set = new Set()));
  set.add(version);
}

const NPM_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

/** Whether a lockfile's `resolved` or `tarball` URL is npm's own registry. Anything else (another host, git, a file) is private. */
export function isNpmRegistryUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" && NPM_REGISTRY_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** A version a lockfile records for a registry package (not a link, a path or a workspace). */
function registryVersion(v: string | null | undefined): string | null {
  if (!v) return null;
  if (/^(link|file|workspace|portal):/.test(v)) return null;
  return v;
}

// --- package-lock.json / npm-shrinkwrap.json ---------------------------------

export function readPackageLock(text: string): PackageLockIndex | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "not valid JSON";
  }
  if (!isObject(json)) return "not a JSON object";
  const packages = new Map<string, Set<string>>();
  const importers = new Map<string, PackageDepTable>();
  const localNames = new Set<string>();
  const privateNames = new Set<string>();
  const entries = json.packages;
  if (isObject(entries)) {
    // lockfileVersion 2 and 3: a flat map of install paths.
    for (const [key, raw] of Object.entries(entries)) {
      if (!isObject(raw)) continue;
      const nm = key.lastIndexOf("node_modules/");
      if (nm < 0) {
        if (key !== "" && typeof raw.name === "string") localNames.add(raw.name);
        continue;
      }
      if (raw.link === true) {
        localNames.add(key.slice(nm + "node_modules/".length));
        continue;
      }
      const name = typeof raw.name === "string" ? raw.name : key.slice(nm + "node_modules/".length);
      const version = typeof raw.version === "string" ? raw.version : null;
      if (version) addPackage(packages, name, version);
      if (typeof raw.resolved === "string" && !isNpmRegistryUrl(raw.resolved)) privateNames.add(name);
    }
    const at = (importer: string, dep: string): string | null => {
      const keys = importer ? [`${importer}/node_modules/${dep}`, `node_modules/${dep}`] : [`node_modules/${dep}`];
      for (const k of keys) {
        const e = entries[k];
        if (!isObject(e)) continue;
        if (e.link === true) return null;
        return typeof e.version === "string" ? e.version : null;
      }
      return null;
    };
    for (const [key, raw] of Object.entries(entries)) {
      if (!isObject(raw) || key.includes("node_modules/")) continue;
      importers.set(key, depTableOf(raw, (dep) => at(key, dep)));
    }
    return { importers, packages, localNames, privateNames };
  }
  // lockfileVersion 1: a nested tree, no importer specs.
  const deps = json.dependencies;
  if (!isObject(deps)) return { importers, packages };
  const walk = (tree: Record<string, unknown>) => {
    for (const [name, raw] of Object.entries(tree)) {
      if (!isObject(raw)) continue;
      const version = registryVersion(typeof raw.version === "string" ? raw.version : null);
      if (version) addPackage(packages, name, version);
      if (typeof raw.resolved === "string" && !isNpmRegistryUrl(raw.resolved)) privateNames.add(name);
      if (isObject(raw.dependencies)) walk(raw.dependencies);
    }
  };
  walk(deps);
  return {
    importers,
    packages,
    privateNames,
    resolve: (name) => {
      const e = deps[name];
      return isObject(e) ? registryVersion(typeof e.version === "string" ? e.version : null) : null;
    },
  };
}

// --- bun.lock ------------------------------------------------------------------

/** bun.lock is JSON with trailing commas. Strings are copied whole, so a comma inside one is safe. */
function parseJsonWithTrailingCommas(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return JSON.parse(out);
}

export function readBunLock(text: string): PackageLockIndex | string {
  let json: unknown;
  try {
    json = parseJsonWithTrailingCommas(text);
  } catch {
    return "not valid bun.lock";
  }
  if (!isObject(json)) return "not a JSON object";
  const packages = new Map<string, Set<string>>();
  const entries = isObject(json.packages) ? json.packages : {};
  const versionAt = (key: string): string | null | undefined => {
    const e = entries[key];
    if (!Array.isArray(e) || typeof e[0] !== "string") return undefined;
    const split = splitNameAtVersion(e[0]);
    return split ? registryVersion(split.version) : null;
  };
  const localNames = new Set<string>();
  const privateNames = new Set<string>();
  for (const raw of Object.values(entries)) {
    if (!Array.isArray(raw) || typeof raw[0] !== "string") continue;
    const split = splitNameAtVersion(raw[0]);
    const version = split && registryVersion(split.version);
    if (split && version) addPackage(packages, split.name, version);
    else if (split && /^(workspace|link|file):/.test(split.version)) localNames.add(split.name);
    // The second slot names the registry when it is not the default one; a
    // git or tarball install writes its URL into the version.
    if (split && version) {
      const registry = typeof raw[1] === "string" ? raw[1] : "";
      if ((registry && !isNpmRegistryUrl(registry)) || /^(git|github|https?|ssh):|:\/\//.test(version)) privateNames.add(split.name);
    }
  }
  const importers = new Map<string, PackageDepTable>();
  const workspaces = isObject(json.workspaces) ? json.workspaces : {};
  for (const [dir, raw] of Object.entries(workspaces)) {
    if (!isObject(raw)) continue;
    const wsName = typeof raw.name === "string" ? raw.name : null;
    if (wsName && dir !== "") localNames.add(wsName);
    importers.set(dir, depTableOf(raw, (dep) => {
      // A workspace's own copy is keyed under its name; otherwise the hoisted one.
      const own = wsName && dir !== "" ? versionAt(`${wsName}/${dep}`) : undefined;
      return own !== undefined ? own : versionAt(dep) ?? null;
    }));
  }
  return { importers, packages, localNames, privateNames };
}

// --- pnpm-lock.yaml ---------------------------------------------------------------

function unquoteYaml(s: string): string {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1);
  return t;
}

/** `19.1.0(react@19.1.0)` → `19.1.0`; `link:../x` → null. */
function pnpmVersion(v: string): string | null {
  return registryVersion(unquoteYaml(v).replace(/\(.*$/, ""));
}

const PNPM_SECTIONS = new Set<string>(NPM_SECTIONS);

/**
 * pnpm's lockfile, v6 and later, read line by line: the subset it writes
 * (two-space nesting, one key per line) is all the table needs.
 */
export function readPnpmLock(text: string): PackageLockIndex | string {
  const lines = text.split(/\r?\n/);
  const version = /^lockfileVersion:\s*['"]?(\d+)/m.exec(text);
  if (!version) return "not a pnpm lockfile";
  if (Number(version[1]) < 6) return "pnpm lockfile older than v6";
  const packages = new Map<string, Set<string>>();
  const importers = new Map<string, PackageDepTable>();
  const localNames = new Set<string>();
  const privateNames = new Set<string>();
  let pkgName: string | null = null;
  let top = "";
  let importer = "";
  let section = "";
  let dep = "";
  let entry: { spec: string | null; version: string | null } | null = null;
  const flush = () => {
    if (entry && dep && section) {
      let table = importers.get(importer);
      if (!table) importers.set(importer, (table = new Map()));
      addEntry(table, dep, section, { spec: entry.spec, version: entry.version });
    }
    entry = null;
  };
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      flush();
      top = body.replace(/:.*$/, "");
      importer = "";
      section = "";
      dep = "";
      // v6 single-project lockfiles keep the root's sections at the top level.
      if (PNPM_SECTIONS.has(top)) section = top;
      continue;
    }
    if (top === "packages") {
      if (indent === 2 && body.endsWith(":")) {
        const key = unquoteYaml(body.slice(0, -1)).replace(/^\//, "").replace(/\(.*$/, "");
        const split = splitNameAtVersion(key);
        const v = split && registryVersion(split.version);
        if (split && v) addPackage(packages, split.name, v);
        pkgName = split?.name ?? null;
        // A git or tarball install keys the package by its URL.
        if (split && /^(git|github|https?|ssh|file):|:\/\//.test(split.version)) privateNames.add(split.name);
      } else if (indent > 2 && pkgName) {
        const tarball = /(?:^|[{,\s])tarball:\s*['"]?([^'",}\s]+)/.exec(body);
        if (tarball && !isNpmRegistryUrl(tarball[1])) privateNames.add(pkgName);
        if (/(?:^|[{,\s])(repo|commit|directory):/.test(body)) privateNames.add(pkgName);
      }
      continue;
    }
    const inImporters = top === "importers";
    const rootSections = PNPM_SECTIONS.has(top);
    if (!inImporters && !rootSections) continue;
    const base = inImporters ? 4 : 0;
    if (inImporters && indent === 2) {
      flush();
      const key = unquoteYaml(body.replace(/:$/, ""));
      importer = key === "." ? "" : key;
      section = "";
      continue;
    }
    if (inImporters && indent === 4) {
      flush();
      section = PNPM_SECTIONS.has(body.replace(/:$/, "")) ? body.replace(/:$/, "") : "";
      continue;
    }
    if (!section) continue;
    if (indent === base + 2) {
      flush();
      const colon = body.lastIndexOf(":");
      dep = unquoteYaml(body.slice(0, colon));
      const inline = body.slice(colon + 1).trim();
      // v5-style `name: version` lines carry the version inline.
      entry = inline ? { spec: null, version: pnpmVersion(inline) } : { spec: null, version: null };
      if (inline && /^link:/.test(unquoteYaml(inline))) localNames.add(dep);
      continue;
    }
    if (indent === base + 4 && entry) {
      const m = /^(specifier|version):\s*(.*)$/.exec(body);
      if (m?.[1] === "specifier") entry.spec = unquoteYaml(m[2]);
      else if (m?.[1] === "version") {
        entry.version = pnpmVersion(m[2]);
        if (/^link:/.test(unquoteYaml(m[2]))) localNames.add(dep);
      }
    }
  }
  flush();
  return { importers, packages, localNames, privateNames };
}

// --- yarn.lock (classic and Berry) -----------------------------------------------

export function readYarnLock(text: string): PackageLockIndex | string {
  const lines = text.split(/\r?\n/);
  const packages = new Map<string, Set<string>>();
  const byDescriptor = new Map<string, string>();
  const localNames = new Set<string>();
  const privateNames = new Set<string>();
  let descriptors: string[] = [];
  let entryNames: string[] = [];
  let sawEntry = false;
  for (const line of lines) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      descriptors = [];
      entryNames = [];
      if (!line.endsWith(":")) continue;
      const head = line.slice(0, -1);
      if (head === "__metadata") continue;
      descriptors = head.split(/,\s*/).map((d) => d.trim().replace(/^["']|["']$/g, ""));
      entryNames = descriptors.map((d) => splitNameAtVersion(d)?.name).filter((n): n is string => !!n);
      for (const d of descriptors) {
        const split = splitNameAtVersion(d);
        if (split && /^(git|github|https?|ssh):|:\/\//.test(split.version.replace(/^npm:/, ""))) privateNames.add(split.name);
      }
      continue;
    }
    const resolved = /^\s{2}resolved:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (resolved && !isNpmRegistryUrl(resolved[1])) for (const n of entryNames) privateNames.add(n);
    if (descriptors.length === 0) continue;
    const m = /^\s{2}version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (!m) continue;
    sawEntry = true;
    const version = registryVersion(m[1]);
    for (const d of descriptors) {
      const split = splitNameAtVersion(d);
      if (!split) continue;
      // Berry writes `name@npm:range`; workspaces and patches are not installs from the registry.
      if (/^(workspace|portal|link|file):/.test(split.version) || version === "0.0.0-use.local") {
        localNames.add(split.name);
        continue;
      }
      if (/^patch:/.test(split.version)) continue;
      byDescriptor.set(d, version ?? "");
      if (version) addPackage(packages, split.name, version);
    }
    descriptors = [];
  }
  if (!sawEntry && !/yarn lockfile|__metadata/.test(text)) return "not a yarn lockfile";
  return {
    importers: new Map(),
    packages,
    localNames,
    privateNames,
    resolve: (name, spec) => {
      const hit = byDescriptor.get(`${name}@${spec}`) ?? byDescriptor.get(`${name}@npm:${spec}`);
      return hit ? hit : null;
    },
  };
}

export const npmEcosystem: PackageEcosystem = {
  id: "npm",
  manifestNames: ["package.json"],
  lockfileNames: ["bun.lock", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"],
  ignoredDirs: ["node_modules"],
  readManifest: readPackageJson,
  readLockfile(fileName, text) {
    switch (fileName) {
      case "bun.lock": return readBunLock(text);
      case "package-lock.json":
      case "npm-shrinkwrap.json": return readPackageLock(text);
      case "pnpm-lock.yaml": return readPnpmLock(text);
      case "yarn.lock": return readYarnLock(text);
      default: return "not a lockfile";
    }
  },
  classifySpec: classifyNpmSpec,
  compareVersions: compareSemver,
  isBreakingStep: isSemverBreakingStep,
  defaultSection: "dependencies",
  sections: NPM_SECTIONS,
};
