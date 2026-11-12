import { expect, test } from "bun:test";
import { parseDarwinMounts, parseLinuxMounts } from "./inbox-drives";

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
