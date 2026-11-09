/**
 * Folder reads outside home, off the Inbox's own process (approval "inbox-launch-any-folder"). A network drive that
 * stopped answering, or a macOS permission prompt on a removable drive, can hold a file call for 30 s or more; a call
 * like that in the Inbox would freeze every window. So a read of a folder outside home (the folder browser's listing,
 * a Send's folder, a project on a network drive) runs the folder rules (`inbox-home-folders.ts`, its own source) in a
 * child process of this same binary, and is given up after `FOLDER_READ_TIMEOUT_MS`: the answer is then "<drive>
 * isn't responding", and the same drive answers that at once for a few seconds, so typing on starts no more children.
 * Folders in home are read in process, as always.
 */
import { homeFoldersSource } from "./inbox-home-folders-source.ts" with { type: "macro" };
import type { FolderPlaces, HomeFolder, HomeFolderListing, HomeFolderRefusal } from "./inbox-home-folders";
import { folderPlacesFor } from "./inbox-home-folders";
import { realpathSync } from "node:fs";
import { envPathOf } from "./env-path";

/** The env a Windows child needs for Windows' folder rules (`refusedOutside`): where Windows and programs live. */
const WINDOWS_PLACES_ENV = ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"] as const;

/** The rules' own source, carried in the build (a Bun macro). */
const RULES_SOURCE: string = homeFoldersSource();

/** How long one read outside home may take before it is given up. */
export const FOLDER_READ_TIMEOUT_MS = 3000;
/** After a read was given up, that drive answers "isn't responding" at once for this long. */
const SLOW_KEEP_MS = 10_000;

/** A read's answer, or the drive that didn't answer in time (its name, as the window says it). */
export type FolderReadOff<T> = { ok: true; value: T } | { ok: false; slow: string };

/** A path is outside home: a full path that is neither home nor under it, as typed or by home's real path. */
export function outsideHome(home: string, typed: string): boolean {
  const text = typed.trim();
  if (!text.startsWith("/")) return false;
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // Home as given.
  }
  return ![home, realHome].some((h) => text === h || text.startsWith(`${h.replace(/\/+$/, "")}/`));
}

/**
 * The drive a path is on, for the words and the slow memory: the longest mounted drive it is under, else the folder
 * right under the drives folder it is in (`/Volumes/Backup`), else its first folder. Its name is that folder's own name.
 */
export function driveOf(path: string, drives: readonly string[] = [], containers: readonly string[] = ["/Volumes", "/mnt", "/media"]): { root: string; name: string } {
  const clean = `/${path.split("/").filter(Boolean).join("/")}`;
  const within = (root: string) => clean === root || clean.startsWith(`${root}/`);
  const mounted = drives.filter(within).sort((a, b) => b.length - a.length)[0];
  const container = containers.filter((c) => c !== "/" && clean.startsWith(`${c}/`)).sort((a, b) => b.length - a.length)[0] ?? "";
  const next = clean.slice(container.length).split("/").filter(Boolean)[0];
  const root = mounted ?? (next ? `${container}/${next}` : clean);
  return { root, name: root.split("/").filter(Boolean).pop() ?? "/" };
}

/** The test sandbox's stand-in drives (`PLANNOTATOR_TEST_DRIVES`, sandbox only): which are network drives, which never answer. */
export function testDrives(env: Readonly<Record<string, string | undefined>>): { drives?: { path: string; network?: boolean }[]; network: string[]; slow: string[] } | null {
  if (!env.PLANNOTATOR_TEST_SANDBOX || !env.PLANNOTATOR_TEST_DRIVES) return null;
  try {
    const parsed = JSON.parse(env.PLANNOTATOR_TEST_DRIVES) as { drives?: { path: string; network?: boolean }[]; network?: string[]; slow?: string[] };
    return { ...(Array.isArray(parsed.drives) ? { drives: parsed.drives } : {}), network: parsed.network ?? [], slow: parsed.slow ?? [] };
  } catch {
    return null;
  }
}

export function createFolderReader(options: {
  home: string;
  platform: string;
  /** The binary that runs the child (this one: Bun itself, or the compiled Plannotator acting as Bun). */
  execPath?: string;
  timeoutMs?: number;
  /** The machine's system and drive folders (tests name their own). */
  places?: FolderPlaces;
  /** The drives mounted now (their paths), so a slow path is said by its drive. */
  drives?: () => readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}) {
  const execPath = options.execPath ?? process.execPath;
  const timeoutMs = options.timeoutMs ?? FOLDER_READ_TIMEOUT_MS;
  const places = options.places ?? folderPlacesFor(options.platform);
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  /** Drives that didn't answer, by root: until when they answer "isn't responding" without a read. */
  const slowUntil = new Map<string, number>();

  async function run<T>(call: "list" | "resolve", typed: string, fresh: boolean): Promise<FolderReadOff<T>> {
    const drive = driveOf(typed, options.drives?.() ?? [], places.containers);
    if (!fresh && (slowUntil.get(drive.root) ?? 0) > now()) return { ok: false, slow: drive.name };
    // The sandbox's never-answering drive: the child waits longer than the read may take, as a dead mount would.
    const stub = testDrives(env);
    const hang = stub?.slow.some((root) => typed === root || typed.startsWith(`${root}/`)) ? timeoutMs + 10_000 : 0;
    const args = JSON.stringify({ call, home: options.home, typed, places, hang });
    const code = `${RULES_SOURCE}\n;{const a=${args};if(a.hang)Bun.sleepSync(a.hang);const r=a.call==="list"?listHomeFolders(a.home,a.typed,a.places):resolveHomeFolder(a.home,a.typed,a.places);process.stdout.write(JSON.stringify(r));}`;
    // The compiled binary acts as Bun with BUN_BE_BUN; nothing of the Inbox's env goes to the child, and it runs at `/`
    // so no config file of the folder it was started in is read. On Windows it gets the system folders' places too
    // (Windows' folder rules refuse them) and its PATH by any spelling (`Path`).
    const childEnv: Record<string, string> = { BUN_BE_BUN: "1", PATH: envPathOf(env, options.platform as NodeJS.Platform) ?? "/usr/bin:/bin" };
    if (options.platform === "win32") {
      for (const name of WINDOWS_PLACES_ENV) if (env[name]) childEnv[name] = env[name]!;
    }
    const child = Bun.spawn([execPath, "-e", code], { cwd: "/", env: childEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [out, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (timedOut) {
        slowUntil.set(drive.root, now() + SLOW_KEEP_MS);
        return { ok: false, slow: drive.name };
      }
      if (exit !== 0) throw new Error(`The folder read ended with ${exit}.`);
      slowUntil.delete(drive.root);
      return { ok: true, value: JSON.parse(out) as T };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** `listHomeFolders` for a path outside home, off this process. `fresh`: Try again, asked of the drive even if it just didn't answer. */
    list: (typed: string, fresh = false) => run<HomeFolderListing | { refused: HomeFolderRefusal }>("list", typed, fresh),
    /** `resolveHomeFolder` for a path outside home, off this process. */
    resolve: (typed: string) => run<HomeFolder>("resolve", typed, false),
    places,
  };
}
