import { isAbsolute, resolve } from "path";

export function getDaemonStartCommand(
  argv: string[] = process.argv,
  execPath = process.execPath,
  cwd = process.cwd(),
): string[] {
  const entry = argv[1];
  if (entry && /\.(?:[cm]?[jt]s)$/.test(entry)) {
    const resolvedEntry = isAbsolute(entry) ? entry : resolve(cwd, entry);
    return [execPath, resolvedEntry, "daemon", "start", "--foreground"];
  }
  return [execPath, "daemon", "start", "--foreground"];
}
