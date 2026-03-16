import { mkdirSync, readdirSync, readFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import type { PasteStore } from "../core/storage";
import type { ReviewSession } from "@plannotator/ui/types";

interface PasteFile {
  data: string;
  expiresAt: number;
}

export class FsPasteStore implements PasteStore {
  private resolvedDir: string;

  constructor(private dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.resolvedDir = resolve(dataDir);
    this.sweep();
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

  /** Delete expired pastes on startup */
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

  // Review Session methods

  async putSession(id: string, session: ReviewSession, ttlSeconds: number): Promise<void> {
    const entry: PasteFile = {
      data: JSON.stringify(session),
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    const path = this.safePath(`session-${id}`);
    await Bun.write(path, JSON.stringify(entry));
  }

  async getSession(id: string): Promise<ReviewSession | null> {
    const path = this.safePath(`session-${id}`);
    try {
      const entry: PasteFile = await Bun.file(path).json();
      if (Date.now() > entry.expiresAt) {
        unlinkSync(path);
        return null;
      }
      return JSON.parse(entry.data);
    } catch {
      return null;
    }
  }

  async updateSession(id: string, session: ReviewSession, ttlSeconds: number): Promise<boolean> {
    const path = this.safePath(`session-${id}`);
    try {
      // Read existing session
      const entry: PasteFile = await Bun.file(path).json();
      if (Date.now() > entry.expiresAt) {
        unlinkSync(path);
        return false;
      }

      const existing: ReviewSession = JSON.parse(entry.data);

      // Optimistic locking check
      if (existing.version !== session.version - 1) {
        return false; // Version mismatch — another client updated first
      }

      // Write updated session
      const newEntry: PasteFile = {
        data: JSON.stringify(session),
        expiresAt: Date.now() + ttlSeconds * 1000,
      };
      await Bun.write(path, JSON.stringify(newEntry));
      return true;
    } catch {
      return false;
    }
  }
}
