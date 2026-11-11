/** Phones paired with this Inbox, in append-only JSONL with the store's line rules (devices.jsonl, device-commands.jsonl) plus pairing secrets in device-secrets/. The token is never stored, only its SHA-256, so a revoked record can tell a removed phone from an unknown token. */

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "./schema";

export const INBOX_DEVICES_FILE = "devices.jsonl";
export const INBOX_DEVICE_SECRETS_DIR = "device-secrets";
export const INBOX_DEVICE_COMMANDS_FILE = "device-commands.jsonl";

export interface InboxDevice {
  id: string;
  name: string;
  platform: string;
  token_sha256: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  carriage: boolean;
  /** Set when a linked machine was unlinked while unreachable: until this time, or until its revoked token is refused once, the tailnet door stays published so it hears `device_revoked`. */
  refusal_owed_until?: string;
}

export type InboxDevicePublic = Omit<InboxDevice, "token_sha256">;

export function publicDevice(device: InboxDevice): InboxDevicePublic {
  const { token_sha256: _hash, ...rest } = device;
  return rest;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class JsonLines<T> {
  private torn = false;
  constructor(readonly path: string) {}

  read(): T[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    this.torn = text.length > 0 && !text.endsWith("\n");
    const out: T[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const value = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as T);
      } catch {
        // A torn line: skipped.
      }
    }
    return out;
  }

  append(line: T): void {
    const prefix = this.torn ? "\n" : "";
    try {
      appendFileSync(this.path, `${prefix}${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (error) {
      this.torn = true;
      throw error;
    }
    this.torn = false;
  }
}

interface DeviceLine {
  v: 1;
  at: string;
  id: string;
  record: InboxDevice;
}

function isDevice(value: unknown): value is InboxDevice {
  if (!value || typeof value !== "object") return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.platform === "string" &&
    typeof d.token_sha256 === "string" &&
    typeof d.created_at === "string" &&
    typeof d.last_seen_at === "string" &&
    (d.revoked_at === null || typeof d.revoked_at === "string")
  );
}

export class InboxDevices {
  private readonly devices = new Map<string, InboxDevice>();
  private readonly byHash = new Map<string, string>();
  private readonly lines: JsonLines<DeviceLine>;
  private readonly secretsDir: string;

  private constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.lines = new JsonLines(join(dir, INBOX_DEVICES_FILE));
    this.secretsDir = join(dir, INBOX_DEVICE_SECRETS_DIR);
    for (const line of this.lines.read()) {
      if (line.v !== 1 || !isDevice(line.record) || line.record.id !== line.id) continue;
      // Fields are only added: a line from before `carriage` existed reads as on.
      this.remember({ ...line.record, carriage: line.record.carriage !== false });
    }
  }

  static open(dataDir: string): InboxDevices {
    return new InboxDevices(inboxDir(dataDir));
  }

  private remember(device: InboxDevice): void {
    this.devices.set(device.id, device);
    this.byHash.set(device.token_sha256, device.id);
  }

  private write(device: InboxDevice, at: string): InboxDevice {
    this.lines.append({ v: 1, at, id: device.id, record: device });
    this.remember(device);
    return device;
  }

  list(): InboxDevice[] {
    return [...this.devices.values()].filter((d) => d.revoked_at === null).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  }

  get(id: string): InboxDevice | null {
    return this.devices.get(id) ?? null;
  }

  byToken(token: string): InboxDevice | null {
    const id = this.byHash.get(sha256Hex(token));
    return id ? (this.devices.get(id) ?? null) : null;
  }

  add(input: { id: string; name: string; platform: string; token: string; secret: string; at: string }): InboxDevice {
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.secretsDir, 0o700);
    } catch {
      // Best effort where the filesystem has no modes.
    }
    writeFileSync(join(this.secretsDir, input.id), input.secret, { mode: 0o600 });
    return this.write(
      {
        id: input.id,
        name: input.name,
        platform: input.platform,
        token_sha256: sha256Hex(input.token),
        created_at: input.at,
        last_seen_at: input.at,
        revoked_at: null,
        carriage: true,
      },
      input.at,
    );
  }

  revoke(id: string, at: string): InboxDevice | null {
    const device = this.devices.get(id);
    if (!device) return null;
    rmSync(join(this.secretsDir, id), { force: true });
    if (device.revoked_at !== null) return device;
    return this.write({ ...device, revoked_at: at }, at);
  }

  oweRefusal(id: string, until: string | null, at: string): InboxDevice | null {
    const device = this.devices.get(id);
    if (!device) return null;
    if ((device.refusal_owed_until ?? null) === until) return device;
    const { refusal_owed_until: _settled, ...rest } = device;
    return this.write(until ? { ...rest, refusal_owed_until: until } : rest, at);
  }

  owedRefusals(nowMs: number): InboxDevice[] {
    return [...this.devices.values()]
      .filter((d) => d.revoked_at !== null && typeof d.refusal_owed_until === "string" && Date.parse(d.refusal_owed_until) > nowMs)
      .sort((a, b) => Date.parse(a.refusal_owed_until!) - Date.parse(b.refusal_owed_until!));
  }

  secret(id: string): string | null {
    try {
      return readFileSync(join(this.secretsDir, id), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  setCarriage(id: string, on: boolean, at: string): void {
    const device = this.devices.get(id);
    if (device && device.carriage !== on) this.write({ ...device, carriage: on }, at);
  }

  touch(id: string, at: string): void {
    const device = this.devices.get(id);
    if (!device) return;
    const dayChanged = device.last_seen_at.slice(0, 10) !== at.slice(0, 10);
    const next = { ...device, last_seen_at: at };
    if (dayChanged) this.write(next, at);
    else this.devices.set(id, next);
  }
}
