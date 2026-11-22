import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import type { PasteStore } from "../core/storage";

interface PasteFile {
  data: string;
  expiresAt: number;
}

export class FsPasteStore implements PasteStore {
  private resolvedDir: string;
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor(private dataDir: string, sweepIntervalMs = 60 * 60 * 1000) {
    mkdirSync(dataDir, { recursive: true });
    this.resolvedDir = resolve(dataDir);
    this.sweep();
    // A long-running service must also drop expired pastes nobody reads again,
    // not only at its next start. unref() so the timer never holds the process open.
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Stop the periodic sweep. */
  close(): void {
    clearInterval(this.sweepTimer);
  }

  private safePath(id: string): string {
    const filePath = resolve(join(this.dataDir, `${id}.json`));
    if (!filePath.startsWith(this.resolvedDir)) {
      throw new Error("Invalid paste ID");
    }
    return filePath;
  }

  async put(id: string, data: string, ttlSeconds: number): Promise<void> {
    const entry: PasteFile = {
      data,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    await Bun.write(this.safePath(id), JSON.stringify(entry));
  }

  async get(id: string): Promise<string | null> {
    const path = this.safePath(id);
    try {
      const entry: PasteFile = await Bun.file(path).json();
      if (Date.now() > entry.expiresAt) {
        unlinkSync(path);
        return null;
      }
      return entry.data;
    } catch {
      return null;
    }
  }

  /** Delete expired pastes (at startup, then every sweep interval) */
  private sweep(): void {
    try {
      const files = readdirSync(this.dataDir).filter((f) => f.endsWith(".json"));
      const now = Date.now();
      for (const file of files) {
        const path = join(this.dataDir, file);
        try {
          const raw = readFileSync(path, "utf-8");
          const entry: PasteFile = JSON.parse(raw);
          if (now > entry.expiresAt) {
            unlinkSync(path);
          }
        } catch {
          // skip malformed files
        }
      }
    } catch {
      // dataDir might not exist yet
    }
  }
}
