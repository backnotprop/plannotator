/**
 * The hard brake on mailbox creation: one Durable Object per client address
 * (`idFromName` of CF-Connecting-IP), counting that address's creations in a
 * fixed 60 s window, 20 at most (src/limits.ts). Cloudflare's rate limiting
 * binding stays in front as the cheap first filter, but its counts are
 * approximate and cached per machine, so requests on separate connections pass
 * it well over the limit; this object is one count wherever the requests land.
 *
 * It keeps one row, the window's start and count, never the address (the
 * object's id is a hash of it), and deletes it when the window ends.
 */
import { DurableObject } from "cloudflare:workers";
import { CREATE_WINDOW_MS, takeCreate, type CreateWindow } from "./limits";
import type { Env } from "./mailbox";

export class CreateBrake extends DurableObject<Env> {
  async take(): Promise<{ allowed: boolean; retryAfter: number }> {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS brake (id INTEGER PRIMARY KEY CHECK (id = 1), since INTEGER NOT NULL, count INTEGER NOT NULL)");
    const row = sql.exec<{ since: number; count: number }>("SELECT since, count FROM brake WHERE id = 1").toArray()[0];
    const next = takeCreate((row as CreateWindow | undefined) ?? null, Date.now());
    if (next.allowed) {
      sql.exec("INSERT OR REPLACE INTO brake (id, since, count) VALUES (1, ?, ?)", next.window.since, next.window.count);
      if (next.window.count === 1) await this.ctx.storage.setAlarm(next.window.since + CREATE_WINDOW_MS);
    }
    return { allowed: next.allowed, retryAfter: next.retryAfter };
  }

  /** The window is over: the object keeps nothing until the address creates again. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
