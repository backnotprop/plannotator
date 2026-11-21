/**
 * The drives a machine has mounted besides its own disk (approval "inbox-launch-any-folder"): the folder menu's drive
 * rows and the folder browser's places. Read from the mount table, never by touching the drives themselves (a network
 * drive that stopped answering would hold the read): macOS's `mount` (a drive under `/Volumes`; a network one has no
 * `local` flag), Linux's `/proc/self/mounts` (under `/mnt`, `/media`, `/run/media`). Windows: none (launch is off there).
 */
import { readFileSync } from "node:fs";
import { testDrives } from "./inbox-folder-reader";

export interface InboxDrive {
  /** Where it is mounted: `/Volumes/Studio SSD`. */
  path: string;
  /** Its name: the mount folder's own name. */
  name: string;
  /** A network drive (SMB, NFS, AFP, WebDAV, sshfs): it may be slow to answer. */
  network?: true;
}

/** How long one read of the mount table is kept: the sessions read asks every few seconds while New message is open. */
const DRIVES_KEEP_MS = 5000;
/** How long `mount` may take (it reads the kernel's table, not the drives). */
const MOUNT_TIMEOUT_MS = 2000;

const LINUX_NETWORK = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "fuse.sshfs", "sshfs", "9p", "davfs", "fuse.rclone", "ceph", "glusterfs", "fuse.glusterfs"]);

const nameOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
/** A folder name nobody picks: hidden, or one of macOS's own (`com.apple.TimeMachine.localsnapshots`). */
const quietName = (path: string) => path.split("/").some((segment) => segment.startsWith(".") || segment.startsWith("com.apple."));

/** macOS `mount` output: `<what> on <path> (<type>, <flags…>)`, one drive per line, under `/Volumes` only, none Finder hides. */
export function parseDarwinMounts(text: string): InboxDrive[] {
  const drives: InboxDrive[] = [];
  for (const line of text.split("\n")) {
    const match = / on (\/Volumes\/[^/]+) \(([^)]*)\)$/.exec(line.trim());
    if (!match || quietName(match[1]!)) continue;
    const flags = match[2]!.split(",").map((flag) => flag.trim());
    // Hidden from Finder too (a system helper's volume).
    if (flags.includes("nobrowse")) continue;
    drives.push({ path: match[1]!, name: nameOf(match[1]!), ...(flags.includes("local") ? {} : { network: true as const }) });
  }
  return drives;
}

/** Linux `/proc/self/mounts`: `<what> <path> <type> <options> …`, a path's spaces as `\040`. */
export function parseLinuxMounts(text: string): InboxDrive[] {
  const drives: InboxDrive[] = [];
  for (const line of text.split("\n")) {
    const [, rawPath, type] = line.split(" ");
    if (!rawPath || !type) continue;
    const path = rawPath.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (!/^\/(mnt|media|run\/media)\/./.test(path) || quietName(path)) continue;
    drives.push({ path, name: nameOf(path), ...(LINUX_NETWORK.has(type) ? { network: true as const } : {}) });
  }
  return drives;
}

export function createDriveList(options: { platform: string; env?: Readonly<Record<string, string | undefined>>; now?: () => number }) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  let kept: { at: number; drives: InboxDrive[] } | null = null;
  let reading: Promise<InboxDrive[]> | null = null;

  const readNow = async (): Promise<InboxDrive[]> => {
    const stub = testDrives(env);
    let drives: InboxDrive[] = [];
    if (stub?.drives) drives = stub.drives.map((d) => ({ path: d.path, name: nameOf(d.path), ...(d.network ? { network: true as const } : {}) }));
    else if (options.platform === "darwin") {
      // windows-hide-guard: macOS only (/sbin/mount).
      const child = Bun.spawn(["/sbin/mount"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin:/sbin" } });
      const timer = setTimeout(() => child.kill("SIGKILL"), MOUNT_TIMEOUT_MS);
      try {
        const [out, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
        drives = exit === 0 ? parseDarwinMounts(out) : [];
      } finally {
        clearTimeout(timer);
      }
    } else if (options.platform === "linux") {
      try {
        drives = parseLinuxMounts(readFileSync("/proc/self/mounts", "utf8"));
      } catch {
        drives = [];
      }
    }
    if (stub) drives = drives.map((d) => (stub.network.includes(d.path) ? { ...d, network: true as const } : d));
    return drives.sort((a, b) => a.name.localeCompare(b.name));
  };

  return {
    /** The drives mounted now (read again when the last read is older than a few seconds). */
    async list(): Promise<InboxDrive[]> {
      if (kept && now() - kept.at < DRIVES_KEEP_MS) return kept.drives;
      reading ??= readNow()
        .catch(() => [] as InboxDrive[])
        .then((drives) => {
          kept = { at: now(), drives };
          reading = null;
          return drives;
        });
      return reading;
    },
    /** The last list read, without waiting (empty before the first). */
    known(): readonly InboxDrive[] {
      return kept?.drives ?? [];
    },
  };
}
