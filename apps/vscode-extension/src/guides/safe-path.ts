import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" ? false : !rel.startsWith("..") && !isAbsolute(rel);
}

export function realFileInside(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) return null;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(join(root, path));
    if (!inside(realRoot, real)) return null;
    return lstatSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

export function headLeavesRepo(sides: { head: { kind: "fs"; root: string } | { kind: "rev"; rev: string } }, file: { path: string; status?: string }): boolean {
  return sides.head.kind === "fs" && file.status !== "deleted" && !realFileInside(sides.head.root, file.path);
}

export function readOwnFile(root: string, path: string): Buffer | null {
  const real = realFileInside(root, path);
  if (!real) return null;
  try {
    if (lstatSync(join(root, path)).isSymbolicLink()) return null;
    return readFileSync(real);
  } catch {
    return null;
  }
}

export function headRefusal(root: string, path: string): string {
  const leaves = !path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0");
  if (!leaves) {
    try {
      lstatSync(join(root, path));
    } catch {
      return `${path} is not on disk.`;
    }
  }
  return `${path} is not a file inside the repository (a link out of it is not opened).`;
}
