/**
 * The drive rows come from the mount table only (approval "inbox-launch-any-folder"): what guards it is which mounts
 * count as a person's drive (under /Volumes on macOS, /mnt, /media and /run/media on Linux; none hidden, none Finder
 * hides, never the boot disk) and which read as a network drive (it may be slow to answer).
 */
import { expect, test } from "bun:test";
import { createDriveList, parseDarwinMounts, parseLinuxMounts } from "./inbox-drives";

test("macOS: drives under /Volumes; a network one has no local flag; system and hidden volumes are left out", () => {
  const table = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)",
    "/dev/disk4s1 on /Volumes/Studio SSD (apfs, local, nodev, nosuid, journaled, noowners, mounted by me)",
    "//me@nas._smb._tcp.local/Backup on /Volumes/Backup (smbfs, nodev, nosuid, mounted by me)",
    "/dev/disk5s1 on /Volumes/.timemachine/x (apfs, local, nobrowse)",
    "/dev/disk6s1 on /Volumes/com.apple.TimeMachine.localsnapshots (apfs, local, journaled)",
    "/dev/disk7s1 on /Volumes/Helper (hfs, local, nobrowse)",
  ].join("\n");
  expect(parseDarwinMounts(table)).toEqual([
    { path: "/Volumes/Studio SSD", name: "Studio SSD" },
    { path: "/Volumes/Backup", name: "Backup", network: true },
  ]);
});

test("Linux: drives under /mnt, /media and /run/media, spaces unescaped; NFS, SMB and sshfs are network drives", () => {
  const table = [
    "/dev/nvme0n1p2 / ext4 rw 0 0",
    "proc /proc proc rw 0 0",
    "/dev/sdb1 /media/me/Studio\\040SSD exfat rw 0 0",
    "nas:/export /mnt/backup nfs4 rw 0 0",
    "me@host:/srv /run/media/me/remote fuse.sshfs rw 0 0",
    "/dev/sdc1 /mnt/.hidden ext4 rw 0 0",
  ].join("\n");
  expect(parseLinuxMounts(table)).toEqual([
    { path: "/media/me/Studio SSD", name: "Studio SSD" },
    { path: "/mnt/backup", name: "backup", network: true },
    { path: "/run/media/me/remote", name: "remote", network: true },
  ]);
});

for (const marker of ["WSL_DISTRO_NAME", "WSL_INTEROP"]) {
  test(`WSL (${marker}): system mounts keep their metadata without folder shortcuts; drive letters and user mounts stay`, async () => {
    const paths = ["/mnt/wsl", "/mnt/wslg", "/mnt/wslg/distro", "/mnt/host"];
    const other = ["/mnt/c", "/mnt/D", "/mnt/data", "/mnt/c/backup", "/mnt/wsl-projects", "/media/me/USB", "/run/media/me/remote"];
    const env = {
      [marker]: "wsl",
      PLANNOTATOR_TEST_SANDBOX: "1",
      PLANNOTATOR_TEST_DRIVES: JSON.stringify({ drives: [...paths, ...other].map((path) => ({ path, network: true })) }),
    };
    const list = createDriveList({ platform: "linux", env });
    const drives = await list.list();
    expect(drives).toHaveLength(paths.length + other.length);
    for (const path of paths) expect(drives.find((drive) => drive.path === path)).toMatchObject({ shortcut: false, network: true });
    for (const path of other) expect(drives.find((drive) => drive.path === path)?.shortcut).toBeUndefined();
    expect(list.known()).toBe(drives);
  });
}

test("Linux outside WSL keeps every mount as a shortcut", async () => {
  const list = createDriveList({
    platform: "linux",
    env: { PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_TEST_DRIVES: JSON.stringify({ drives: [{ path: "/mnt/wslg" }] }) },
  });
  expect(await list.list()).toEqual([{ path: "/mnt/wslg", name: "wslg" }]);
});
