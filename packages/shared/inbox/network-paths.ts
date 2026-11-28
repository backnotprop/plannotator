/**
 * Paths on another computer that a file an agent's message names never reaches (approval
 * "inbox-file-refs-open-viewer"): a look at one would make a network call before any check could refuse it. On
 * Windows a UNC path (`\\host\share`, `//host/share`, `\\?\…`, `\\.\pipe\…`) connects and hands over the user's
 * NTLM hash; on macOS `/net/<host>`, `/Network/…` and `/home` mount on first touch, and a host that never answers
 * holds the call for the mount's timeout. Both are refused as written, before anything touches them.
 *
 * A share the person already mounted (an SMB volume under `/Volumes`, an NFS home folder, WSL's `/mnt/c`) is theirs
 * and reads like any folder: the realpath and the read are async, so a slow share holds that one view, never the Inbox.
 */

/** A UNC or device path, in either slash. */
const UNC = /^(?:\/\/|\\\\|\\\/|\/\\)/;

/** macOS's mount-on-touch folders (autofs: `/net`, `/Network/Servers`, `/home`). */
const DARWIN_AUTOMOUNTS = /^\/(?:net|Network|home|System\/Volumes\/Data\/(?:net|Network|home))(?:\/|$)/i;

/** Whether `path`, as written, reaches another computer when touched: a UNC path, or a macOS mount-on-touch folder. */
export function isNetworkPath(path: string, platform: NodeJS.Platform): boolean {
  if (UNC.test(path)) return true;
  return platform === "darwin" && DARWIN_AUTOMOUNTS.test(path);
}
