/**
 * The Spaces sign-in kept on this computer: `<dataDir>/secrets/spaces.json` (folder 0700, file 0600, written to a
 * temp file and renamed), the pattern of packages/shared/sem-diff-opinion.ts. One token per Spaces origin. It is read
 * only to put on a call to that origin: never logged, never part of a URL, never sent to a page (a page learns
 * `signed_in` and a name).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SpacesCredential {
  token: string;
  /** The person's name, when the sign-in told it. */
  name: string | null;
}

interface SpacesSecrets {
  v: 1;
  hosts: Record<string, SpacesCredential>;
}

export function spacesCredentialPath(dataDir: string): string {
  return join(dataDir, "secrets", "spaces.json");
}

function readSecrets(dataDir: string): SpacesSecrets {
  try {
    const value = JSON.parse(readFileSync(spacesCredentialPath(dataDir), "utf8")) as Partial<SpacesSecrets> | null;
    if (value && value.v === 1 && value.hosts && typeof value.hosts === "object") return { v: 1, hosts: value.hosts };
  } catch {
    // Absent or unreadable: not signed in.
  }
  return { v: 1, hosts: {} };
}

function writeSecrets(dataDir: string, secrets: SpacesSecrets): void {
  const dir = join(dataDir, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = spacesCredentialPath(dataDir);
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  writeFileSync(temp, JSON.stringify(secrets), { mode: 0o600 });
  // An older file's mode is kept by a rename over it only on some systems: set it either way.
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** The sign-in for one Spaces origin, or null. */
export function readSpacesCredential(dataDir: string, host: string): SpacesCredential | null {
  const found = readSecrets(dataDir).hosts[host];
  if (!found || typeof found.token !== "string" || found.token.length === 0 || found.token.length > 4096) return null;
  return { token: found.token, name: typeof found.name === "string" && found.name.trim() ? found.name.trim().slice(0, 200) : null };
}

export function saveSpacesCredential(dataDir: string, host: string, credential: SpacesCredential): void {
  const secrets = readSecrets(dataDir);
  secrets.hosts[host] = credential;
  writeSecrets(dataDir, secrets);
}

export function clearSpacesCredential(dataDir: string, host: string): void {
  const secrets = readSecrets(dataDir);
  if (!(host in secrets.hosts)) return;
  delete secrets.hosts[host];
  writeSecrets(dataDir, secrets);
}
