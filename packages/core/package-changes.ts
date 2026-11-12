import { npmEcosystem } from "./package-changes-npm";

export type PackageEcosystemId = "npm";
export type PackageFileRole = "manifest" | "lockfile";

export type PackageSpecSource =
  | "registry"
  | "tag"
  | "alias"
  | "workspace"
  | "local"
  | "git"
  | "url";

export interface PackageSpecInfo {
  source: PackageSpecSource;
  registryName: string | null;
  floor: string | null;
}

export interface PackageDepEntry {
  spec: string | null;
  version: string | null;
}

export type PackageDepTable = Map<string, Map<string, PackageDepEntry>>;

export interface PackageLockIndex {
  importers: Map<string, PackageDepTable>;
  packages: Map<string, Set<string>>;
  localNames?: Set<string>;
  resolve?: (name: string, spec: string) => string | null;
  privateNames?: Set<string>;
}

export interface PackageEcosystem {
  id: PackageEcosystemId;
  manifestNames: readonly string[];
  lockfileNames: readonly string[];
  ignoredDirs: readonly string[];
  readManifest(text: string): PackageDepTable | string;
  readLockfile(fileName: string, text: string): PackageLockIndex | string;
  classifySpec(name: string, spec: string): PackageSpecInfo;
  compareVersions(a: string, b: string): number;
  isBreakingStep(a: string, b: string): boolean;
  defaultSection: string;
  sections: readonly string[];
}

export const PACKAGE_ECOSYSTEMS: readonly PackageEcosystem[] = [npmEcosystem];

export type PackageChangeKind = "added" | "removed" | "upgraded" | "downgraded" | "changed" | "moved";

export interface PackageChange {
  name: string;
  registryName: string | null;
  kind: PackageChangeKind;
  section: string;
  previousSection?: string;
  before: string | null;
  after: string | null;
  beforeVersion: string | null;
  afterVersion: string | null;
  major: boolean;
  source: PackageSpecSource;
  workspace?: string;
  privateSource?: true;
}

export interface IndirectPackageChange {
  name: string;
  before: string[];
  after: string[];
}

export interface PackageChangeCard {
  path: string;
  ecosystem: PackageEcosystemId;
  role: PackageFileRole;
  lockfile: string | null;
  changes: PackageChange[];
  indirect: IndirectPackageChange[];
  error?: { side: "old" | "new"; reason: string };
}

export interface PackageUnreadable {
  unreadable: string;
}

export type PackageFileSide = string | null | PackageUnreadable;

export function isUnreadable(side: PackageFileSide | undefined): side is PackageUnreadable {
  return typeof side === "object" && side !== null;
}

export interface PackageSourceFile {
  path: string;
  old: PackageFileSide;
  new: PackageFileSide;
  inDiff: boolean;
}

const MAX_FILE_CHARS = 32 * 1024 * 1024;

function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i), base: path.slice(i + 1) };
}

function joinPath(dir: string, rel: string): string {
  if (!dir) return rel;
  if (!rel) return dir;
  return `${dir}/${rel}`;
}

export function packageFileKind(path: string): { ecosystem: PackageEcosystem; role: PackageFileRole } | null {
  const parts = path.split("/");
  const base = parts[parts.length - 1];
  for (const ecosystem of PACKAGE_ECOSYSTEMS) {
    if (parts.some((p) => ecosystem.ignoredDirs.includes(p))) continue;
    if (ecosystem.manifestNames.includes(base)) return { ecosystem, role: "manifest" };
    if (ecosystem.lockfileNames.includes(base)) return { ecosystem, role: "lockfile" };
  }
  return null;
}

export function isPackageChangePath(path: string): boolean {
  return packageFileKind(path) !== null;
}

export function packageChangeReads(diffPaths: readonly string[]): { path: string; inDiff: boolean }[] {
  const out: { path: string; inDiff: boolean }[] = [];
  const seen = new Set<string>();
  for (const path of diffPaths) {
    if (seen.has(path) || !isPackageChangePath(path)) continue;
    seen.add(path);
    out.push({ path, inDiff: true });
  }
  for (const path of [...seen]) {
    const kind = packageFileKind(path);
    if (kind?.role !== "lockfile") continue;
    const { dir } = splitPath(path);
    for (const name of kind.ecosystem.manifestNames) {
      const companion = joinPath(dir, name);
      if (seen.has(companion)) continue;
      seen.add(companion);
      out.push({ path: companion, inDiff: false });
    }
  }
  return out;
}

function isRegistrySource(source: PackageSpecSource): boolean {
  return source === "registry" || source === "alias";
}

function changeOf(
  eco: PackageEcosystem,
  name: string,
  section: string,
  before: PackageDepEntry | null,
  after: PackageDepEntry | null,
  previousSection?: string,
): PackageChange {
  const beforeInfo = before?.spec != null ? eco.classifySpec(name, before.spec) : null;
  const afterInfo = after?.spec != null ? eco.classifySpec(name, after.spec) : null;
  const info = afterInfo ?? beforeInfo;
  const versionOf = (entry: PackageDepEntry | null, spec: PackageSpecInfo | null) =>
    entry?.version ?? (spec && isRegistrySource(spec.source) ? spec.floor : null);
  const beforeVersion = before ? versionOf(before, beforeInfo) : null;
  const afterVersion = after ? versionOf(after, afterInfo) : null;
  let kind: PackageChangeKind;
  let major = false;
  if (!before) kind = "added";
  else if (!after) kind = "removed";
  else if (beforeVersion && afterVersion && isVersionLike(beforeVersion) && isVersionLike(afterVersion)
    && eco.compareVersions(beforeVersion, afterVersion) !== 0) {
    kind = eco.compareVersions(beforeVersion, afterVersion) < 0 ? "upgraded" : "downgraded";
    major = eco.isBreakingStep(beforeVersion, afterVersion);
  } else if (previousSection) kind = "moved";
  else kind = "changed";
  return {
    name,
    registryName: info?.registryName ?? null,
    kind,
    section,
    ...(previousSection ? { previousSection } : {}),
    before: before?.spec ?? null,
    after: after?.spec ?? null,
    beforeVersion,
    afterVersion,
    major,
    source: info?.source ?? "registry",
  };
}

function isVersionLike(v: string): boolean {
  return /^v?\d/.test(v);
}

function sameEntry(a: PackageDepEntry, b: PackageDepEntry): boolean {
  return a.spec === b.spec && a.version === b.version;
}

export function diffDepTables(eco: PackageEcosystem, oldSide: PackageDepTable, newSide: PackageDepTable): PackageChange[] {
  const changes: PackageChange[] = [];
  const names = new Set([...oldSide.keys(), ...newSide.keys()]);
  for (const name of names) {
    const was = oldSide.get(name) ?? new Map<string, PackageDepEntry>();
    const now = newSide.get(name) ?? new Map<string, PackageDepEntry>();
    const sections = [...new Set([...eco.sections, ...was.keys(), ...now.keys()])];
    const gone: string[] = [];
    const came: string[] = [];
    for (const section of sections) {
      const b = was.get(section);
      const a = now.get(section);
      if (b && a) {
        if (!sameEntry(b, a)) changes.push(changeOf(eco, name, section, b, a));
      } else if (b) gone.push(section);
      else if (a) came.push(section);
    }
    if (gone.length === 1 && came.length === 1) {
      changes.push(changeOf(eco, name, came[0], was.get(gone[0])!, now.get(came[0])!, gone[0]));
      continue;
    }
    for (const section of gone) changes.push(changeOf(eco, name, section, was.get(section)!, null));
    for (const section of came) changes.push(changeOf(eco, name, section, null, now.get(section)!));
  }
  return changes;
}

export type PackageChangeSort = "change" | "name";

const KIND_ORDER: Record<PackageChangeKind, number> = {
  added: 1, removed: 2, upgraded: 3, downgraded: 4, changed: 5, moved: 6,
};

export function sortPackageChanges(changes: readonly PackageChange[], by: PackageChangeSort): PackageChange[] {
  return [...changes].sort((a, b) => {
    if (by === "change") {
      if (a.major !== b.major) return a.major ? -1 : 1;
      const k = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
      if (k !== 0) return k;
    }
    return a.name.localeCompare(b.name)
      || (a.workspace ?? "").localeCompare(b.workspace ?? "")
      || a.section.localeCompare(b.section);
  });
}

interface ParsedSides<T> { old: T | string | null; new: T | string | null }

function readSides<T>(file: PackageSourceFile, read: (text: string) => T | string): ParsedSides<T> {
  const one = (text: PackageFileSide): T | string | null => {
    if (text == null) return null;
    if (isUnreadable(text)) return text.unreadable;
    if (text.length > MAX_FILE_CHARS) return "larger than 32 MB";
    if (text.trim() === "") return null;
    return read(text);
  };
  return { old: one(file.old), new: one(file.new) };
}

const EMPTY_LOCK: PackageLockIndex = { importers: new Map(), packages: new Map() };

interface LockState {
  file: PackageSourceFile;
  eco: PackageEcosystem;
  dir: string;
  old: PackageLockIndex;
  new: PackageLockIndex;
}

function resolveIn(lock: PackageLockIndex, importer: string, name: string, spec: string | null): string | null {
  const table = lock.importers.get(importer)?.get(name);
  if (table) {
    for (const entry of table.values()) if (entry.version) return entry.version;
  }
  if (lock.resolve && spec != null) return lock.resolve(name, spec);
  return null;
}

function withVersions(table: PackageDepTable, lock: PackageLockIndex | null, importer: string): PackageDepTable {
  if (!lock) return table;
  const out: PackageDepTable = new Map();
  for (const [name, sections] of table) {
    const next = new Map<string, PackageDepEntry>();
    for (const [section, entry] of sections) {
      next.set(section, { spec: entry.spec, version: resolveIn(lock, importer, name, entry.spec) ?? entry.version });
    }
    out.set(name, next);
  }
  return out;
}

function markLocal(changes: PackageChange[], lock: LockState): PackageChange[] {
  const local = new Set([...(lock.old.localNames ?? []), ...(lock.new.localNames ?? [])]);
  const hosted = new Set([...(lock.old.privateNames ?? []), ...(lock.new.privateNames ?? [])]);
  if (local.size === 0 && hosted.size === 0) return changes;
  return changes.map((c) => {
    if (local.has(c.name)) return { ...c, registryName: null, source: "workspace" as const };
    if (hosted.has(c.name) || (c.registryName && hosted.has(c.registryName))) return { ...c, privateSource: true as const };
    return c;
  });
}

function relativeDir(from: string, to: string): string | null {
  if (from === to) return "";
  if (from === "") return to;
  return to.startsWith(`${from}/`) ? to.slice(from.length + 1) : null;
}

function versionsOf(lock: PackageLockIndex, name: string): string[] {
  return [...(lock.packages.get(name) ?? [])].sort();
}

export function analyzePackageChanges(files: readonly PackageSourceFile[]): PackageChangeCard[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const locks: LockState[] = [];
  const cards: PackageChangeCard[] = [];
  const errorCard = (file: PackageSourceFile, role: PackageFileRole, eco: PackageEcosystem, side: "old" | "new", reason: string): PackageChangeCard => ({
    path: file.path, ecosystem: eco.id, role, lockfile: role === "lockfile" ? file.path : null, changes: [], indirect: [], error: { side, reason },
  });
  for (const file of files) {
    const kind = packageFileKind(file.path);
    if (!file.inDiff || kind?.role !== "lockfile") continue;
    const { dir, base } = splitPath(file.path);
    const sides = readSides(file, (text) => kind.ecosystem.readLockfile(base, text));
    if (typeof sides.old === "string" || typeof sides.new === "string") {
      const side = typeof sides.old === "string" ? "old" : "new";
      cards.push(errorCard(file, "lockfile", kind.ecosystem, side, (side === "old" ? sides.old : sides.new) as string));
      continue;
    }
    locks.push({ file, eco: kind.ecosystem, dir, old: sides.old ?? EMPTY_LOCK, new: sides.new ?? EMPTY_LOCK });
  }

  const governing = (eco: PackageEcosystem, dir: string): { lock: LockState; importer: string } | null => {
    let best: { lock: LockState; importer: string } | null = null;
    for (const lock of locks) {
      if (lock.eco !== eco) continue;
      const importer = relativeDir(lock.dir, dir);
      if (importer === null) continue;
      const better = !best
        || lock.dir.length > best.lock.dir.length
        || (lock.dir === best.lock.dir
          && eco.lockfileNames.indexOf(splitPath(lock.file.path).base) < eco.lockfileNames.indexOf(splitPath(best.lock.file.path).base));
      if (better) best = { lock, importer };
    }
    return best;
  };

  const claimed = new Map<LockState, { card: PackageChangeCard; importer: string; tables: PackageDepTable[] }[]>();
  for (const file of files) {
    const kind = packageFileKind(file.path);
    if (!file.inDiff || kind?.role !== "manifest") continue;
    const eco = kind.ecosystem;
    const sides = readSides(file, (text) => eco.readManifest(text));
    const card: PackageChangeCard = { path: file.path, ecosystem: eco.id, role: "manifest", lockfile: null, changes: [], indirect: [] };
    if (typeof sides.old === "string" || typeof sides.new === "string") {
      const side = typeof sides.old === "string" ? "old" : "new";
      cards.push(errorCard(file, "manifest", eco, side, (side === "old" ? sides.old : sides.new) as string));
      continue;
    }
    const oldTable = sides.old ?? new Map();
    const newTable = sides.new ?? new Map();
    const gov = governing(eco, splitPath(file.path).dir);
    card.lockfile = gov ? gov.lock.file.path : null;
    card.changes = diffDepTables(
      eco,
      withVersions(oldTable, gov?.lock.old ?? null, gov?.importer ?? ""),
      withVersions(newTable, gov?.lock.new ?? null, gov?.importer ?? ""),
    );
    if (gov) {
      card.changes = markLocal(card.changes, gov.lock);
      const list = claimed.get(gov.lock) ?? [];
      list.push({ card, importer: gov.importer, tables: [oldTable, newTable] });
      claimed.set(gov.lock, list);
    }
    cards.push(card);
  }

  for (const lock of locks) {
    const { eco } = lock;
    const mine = claimed.get(lock) ?? [];
    const claimedImporters = new Set(mine.map((m) => m.importer));
    const direct = new Set<string>();
    for (const m of mine) for (const t of m.tables) for (const name of t.keys()) direct.add(name);

    const importerDirs = new Set([...lock.old.importers.keys(), ...lock.new.importers.keys()]);
    const tables = new Map<string, [PackageDepTable, PackageDepTable]>();
    for (const dir of importerDirs) {
      tables.set(dir, [lock.old.importers.get(dir) ?? new Map(), lock.new.importers.get(dir) ?? new Map()]);
    }
    if (importerDirs.size === 0 && (lock.old.packages.size > 0 || lock.new.packages.size > 0)) {
      const companion = eco.manifestNames.map((n) => byPath.get(joinPath(lock.dir, n))).find((f) => f && (f.old != null || f.new != null));
      const sides = companion ? readSides(companion, (text) => eco.readManifest(text)) : null;
      const bad = !sides ? "no manifest beside it" : typeof sides.old === "string" ? sides.old : typeof sides.new === "string" ? sides.new : null;
      if (bad !== null || !sides) {
        if (mine.length === 0) cards.push(errorCard(lock.file, "lockfile", eco, "new", bad ?? "no manifest beside it"));
        continue;
      }
      const o = (sides.old ?? new Map()) as PackageDepTable;
      const n = (sides.new ?? new Map()) as PackageDepTable;
      tables.set("", [withVersions(o, lock.old, ""), withVersions(n, lock.new, "")]);
    }
    for (const [o, n] of tables.values()) {
      for (const name of o.keys()) direct.add(name);
      for (const name of n.keys()) direct.add(name);
    }

    const unclaimed: PackageChange[] = [];
    for (const [dir, [o, n]] of tables) {
      if (claimedImporters.has(dir)) continue;
      for (const change of markLocal(diffDepTables(eco, o, n), lock)) {
        const where = joinPath(lock.dir, dir);
        unclaimed.push(dir === "" ? change : { ...change, workspace: where });
      }
    }

    const indirect: IndirectPackageChange[] = [];
    const names = new Set([...lock.old.packages.keys(), ...lock.new.packages.keys()]);
    for (const name of names) {
      if (direct.has(name)) continue;
      const before = versionsOf(lock.old, name);
      const after = versionsOf(lock.new, name);
      if (before.join("\n") !== after.join("\n")) indirect.push({ name, before, after });
    }
    indirect.sort((a, b) => a.name.localeCompare(b.name));

    const primary = [...mine].sort((a, b) => a.card.path.length - b.card.path.length || a.card.path.localeCompare(b.card.path))[0]?.card;
    if (primary) {
      primary.changes.push(...unclaimed);
      primary.indirect = indirect;
    } else if (unclaimed.length > 0 || indirect.length > 0) {
      cards.push({
        path: lock.file.path,
        ecosystem: eco.id,
        role: "lockfile",
        lockfile: lock.file.path,
        changes: unclaimed,
        indirect,
      });
    }
  }

  return cards
    .filter((c) => c.error || c.changes.length > 0 || c.indirect.length > 0)
    .map((c) => ({ ...c, changes: sortPackageChanges(c.changes, "change") }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface PackageMetadata {
  name: string;
  version: string | null;
  status: "ok" | "not-found" | "private" | "error";
  license?: string | null;
  publishedAt?: string | null;
  weeklyDownloads?: number | null;
  latest?: string | null;
  deprecated?: string | null;
}
