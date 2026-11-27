/**
 * Where a path an agent's message names may be on this computer: the message's places and candidates, its PR paths, and
 * the credential rule a hover keeps. Split out of inbox-open-in.ts so the send's `links_not_found`
 * (inbox-links-not-found.ts, reached from inbox-mcp.ts and inbox-guides.ts) asks the same places without loading the
 * open-in routes and what they import (a launcher, the machines door, Bun-only modules): scripts and Playwright specs
 * load inbox-guides.ts under Node. Keep this module's imports to node:, core and small shared modules
 * (tests/inbox-send-node-imports.test.ts holds that).
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { inboxAttachmentNameRefusal } from "@plannotator/core/inbox-types";
import { isShapeProjectPath } from "@plannotator/core/shape";
import type { InboxProjectFilePlace } from "@plannotator/shared/inbox/attachments";
import { isLinkedWorktree } from "@plannotator/shared/linked-worktree";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/**
 * The checkout a folder lies in: the nearest folder up with a `.git`, from a folder that may be gone (a branch switch
 * removes a subfolder, the worktree stays). The home folder is never one, even with a `.git`: it holds more than code.
 */
export function checkoutOf(folder: string, home: string): string | null {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return realpathOrNull(dir) === home ? null : dir;
    if (dirname(dir) === dir) return null;
  }
}

/** `path` from `root`, with forward slashes, when it lies inside `root`. */
export function pathInside(root: string, path: string): string | null {
  const inside = relative(root, path);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  return inside.split(sep).join("/");
}

export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** What a referenced file's path is asked in: a thread's message, or a repository's PR page. */
export interface FileScope {
  thread?: unknown;
  message?: unknown;
  repo?: unknown;
  /** A PR page: the pull request whose version of a file its hover shows. */
  pull?: unknown;
  /** `root`: a diff's path, which starts at the top of the repository wherever the agent stood. */
  from?: unknown;
}

const CREDENTIAL_FOLDERS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".docker", ".kube", ".git", ".password-store"]);
const CREDENTIAL_FILES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".bash_history",
  ".zsh_history",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
/** A run of folders and names that holds a CLI's sign-in, anywhere in the path. */
const CREDENTIAL_RUNS = [".config/gh", ".config/glab-cli", ".config/gcloud", ".config/op", ".local/share/keyrings", "library/keychains", ".codex/auth.json", ".claude/.credentials.json", ".claude.json"];

/**
 * A path a hover never shows, as if the file were missing: a thread sent from the home folder makes all of it a project.
 * Other hidden folders (`.github`, `.claude`) are ordinary project files. NTFS names are cleaned as for a dotenv file.
 */
export function holdsCredentials(path: string): boolean {
  const parts = path.replace(/\\/g, "/").toLowerCase().split("/").map((part) => part.replace(/:.*$/s, "").replace(/[. ]+$/, ""));
  const name = parts.at(-1) ?? "";
  const joined = `/${parts.join("/")}/`;
  return (
    parts.some((part) => CREDENTIAL_FOLDERS.has(part)) ||
    CREDENTIAL_FILES.has(name) ||
    /\.(pem|key)$/.test(name) ||
    CREDENTIAL_RUNS.some((run) => joined.includes(`/${run}/`))
  );
}

/**
 * Where a scope's path may be, in the order to try. A diff's path starts at the repository's root
 * (`from: "root"`). A message's link is as the agent wrote it, so it starts in the checkout the agent wrote
 * from: at its folder (`base_path`), then at that checkout's top. Other projects come after, except that an agent in a
 * linked worktree never falls back to the main checkout: that copy is not the agent's file. An absolute path says
 * which of these it means. (A repository's scope, a PR page's, is the route's own.)
 */
export function inboxMessagePlaces(store: InboxStore, home: string, scope: FileScope, named: string): InboxProjectFilePlace[] {
  if (typeof scope.thread !== "string") return [];
  const first = store.message(scope.thread);
  if (!first || first.thread_id !== scope.thread) return [];
  const message = typeof scope.message === "string" ? store.message(scope.message) : null;
  const sender = message?.thread_id === scope.thread ? message : first;
  const base = sender.base_path ?? null;
  const checkout = base ? checkoutOf(base, home) : null;
  const own = sender.from_project?.root ?? store.project(sender.project_id)?.root ?? null;
  const shown = [store.project(first.project_id)?.root, store.thread(scope.thread)?.project.root];
  const known = (roots: unknown[]) => [...new Set(roots.filter((root): root is string => typeof root === "string"))];
  if (isAbsolute(named)) {
    const roots = known([checkout, own, ...shown]);
    const real = realpathOrNull(named);
    const places = roots.flatMap((root) => {
      const inside = pathInside(root, named) ?? (real ? pathInside(root, real) : null);
      return inside ? [{ root, relative: inside }] : [];
    });
    // Outside all of them: refused by the path rule, as any other path outside the project.
    return places.length || !roots.length ? places : [{ root: roots[0]!, relative: named }];
  }
  const roots = known(checkout && isLinkedWorktree(checkout) ? [checkout, ...shown.filter((root) => root !== own)] : [checkout, own, ...shown]);
  const clean = posix.normalize(named.replace(/\\/g, "/"));
  return roots.flatMap((root) => {
    const from = base && scope.from !== "root" ? (base === root ? "" : pathInside(root, base)) : null;
    const places = from ? [{ root, relative: posix.join(from, clean) }] : [];
    return [...places, { root, relative: clean }];
  });
}

/**
 * Where a path a message names may be, as absolute paths to try in order (approval "inbox-file-refs-open-viewer": no
 * project boundary). `~/…` is in the home folder; an absolute path is itself; a relative one starts where the hover's
 * starts (the agent's folder, its checkout, the thread's projects: `inboxMessagePlaces`), and may lead anywhere from
 * there. A message of another thread brings no folder. `givenHome` is the home folder as given, `home` its realpath.
 */
export function inboxMessageCandidates(store: InboxStore, givenHome: string, home: string, scope: FileScope, named: string): string[] {
  if (typeof named !== "string" || named === "" || named.length > 4096) return [];
  if (/^~(?:[\\/]|$)/.test(named)) return [join(givenHome, named.slice(2))];
  if (isAbsolute(named)) return [named];
  return [...new Set(inboxMessagePlaces(store, home, scope, named).map((place) => join(place.root, place.relative)))];
}

/** The paths a relative link may have in a thread's PR, in the order to try ([] for an absolute or `~` path). */
export function inboxPullPaths(store: InboxStore, home: string, scope: FileScope, named: string): string[] {
  if (typeof scope.thread !== "string" || named === "" || isAbsolute(named) || named.startsWith("~")) return [];
  const clean = posix.normalize(named.replace(/\\/g, "/")).replace(/^\.\//, "");
  return [...new Set([...inboxMessagePlaces(store, home, scope, named).map((place) => place.relative), clean])].filter((path) => isShapeProjectPath(path) && !inboxAttachmentNameRefusal(path) && !holdsCredentials(path));
}
