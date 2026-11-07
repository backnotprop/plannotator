/**
 * Paths on another computer, which a file an agent's message names never reaches (approval
 * "inbox-file-refs-open-viewer"): a look at one would make a network call before any check could refuse it. On
 * Windows a UNC path (`\\host\share`, `//host/share`, `\\?\…`, `\\.\pipe\…`) connects and hands over the user's
 * NTLM hash; on macOS `/net/<host>` and `/Network/…` mount on first touch, and a host that never answers holds the
 * call for the mount's timeout. A share already mounted (`/Volumes/share` from smbfs, an NFS mount) is refused by the
 * mount table, read without touching any mount.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** File systems that live on another computer, or mount one when touched. */
const NETWORK_FS = new Set(["smbfs", "nfs", "nfs4", "afpfs", "webdav", "cifs", "smb3", "smb2", "ncpfs", "9p", "autofs", "fuse.sshfs", "sshfs", "fuse.rclone", "davfs", "fuse.davfs2", "ftp"]);

/** A UNC or device path, in either slash. */
const UNC = /^(?:\/\/|\\\\|\\\/|\/\\)/;

/** macOS's mount-on-touch folders (autofs: `/net`, `/Network/Servers`, `/home`). */
const DARWIN_AUTOMOUNTS = /^\/(?:net|Network|home|System\/Volumes\/Data\/(?:net|Network|home))(?:\/|$)/i;

/**
 * The mount points of network file systems in a mount table: `mount`'s lines on macOS (`//u@host/share on
 * /Volumes/share (smbfs, nodev)`) or `/proc/mounts` on Linux (`host:/x /mnt/x nfs4 rw 0 0`).
 */
export function networkMountPointsOf(table: string, format: "darwin" | "linux"): string[] {
  const points: string[] = [];
  for (const line of table.split("\n")) {
    if (format === "darwin") {
      const match = /^.+? on (.+) \(([^,)]+)/.exec(line);
      if (match && NETWORK_FS.has(match[2]!.trim().toLowerCase())) points.push(match[1]!);
    } else {
      const [, point, type] = line.split(/\s+/);
      // /proc/mounts writes a space in a path as \040.
      if (point && type && NETWORK_FS.has(type.toLowerCase())) points.push(point.replace(/\\040/g, " "));
    }
  }
  return points.filter((point) => point !== "/");
}

/** Whether `path`, as written, is on another computer: a UNC path, a macOS mount-on-touch folder, or under a network mount. */
export function isNetworkPath(path: string, platform: NodeJS.Platform, mounts: readonly string[]): boolean {
  if (UNC.test(path)) return true;
  if (platform === "darwin" && DARWIN_AUTOMOUNTS.test(path)) return true;
  const lower = platform === "darwin" || platform === "win32";
  const at = lower ? path.toLowerCase() : path;
  return mounts.some((point) => {
    const p = lower ? point.toLowerCase() : point;
    return at === p || at.startsWith(p.endsWith("/") ? p : `${p}/`);
  });
}

let cached: { at: number; points: Promise<string[]> } | null = null;
const MOUNTS_TTL_MS = 30_000;

/** This computer's network mount points, read at most every 30 s; none where the table cannot be read. */
export function networkMountPoints(platform: NodeJS.Platform = process.platform, now = Date.now()): Promise<string[]> {
  if (cached && now - cached.at < MOUNTS_TTL_MS) return cached.points;
  const points =
    platform === "darwin"
      ? new Promise<string[]>((done) => {
          execFile("/sbin/mount", [], { timeout: 2000, maxBuffer: 1 << 20 }, (error, stdout) => done(error ? [] : networkMountPointsOf(String(stdout), "darwin")));
        })
      : platform === "linux"
        ? readFile("/proc/mounts", "utf8").then((table) => networkMountPointsOf(table, "linux"), () => [])
        : Promise.resolve([]);
  cached = { at: now, points };
  return points;
}
