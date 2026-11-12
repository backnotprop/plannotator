/**
 * Test-only: every table of an Inbox database as plain rows in a fixed order, with the ids the writers make up
 * (actors', answers') replaced by what they stand for, so two databases written by different writers compare whole.
 * `omit`: columns left out per table (`{ actors: ["created_at"] }`).
 */
import { Database } from "bun:sqlite";

export function tablesOf(file: string, omit: Record<string, readonly string[]> = {}): Record<string, unknown[]> {
  // Not read-only: a WAL file with no side files left needs its -shm made to be read.
  const db = new Database(file, { strict: true });
  try {
    const actor = new Map(db.query<{ id: string; kind: string; host: string; session: string }, []>("SELECT id, kind, host, session FROM actors").all().map((a) => [a.id, `${a.kind}:${a.host}:${a.session}`]));
    const answer = new Map(db.query<{ id: string; question_id: string }, []>("SELECT id, question_id FROM answers").all().map((a) => [a.id, `answer:${a.question_id}`]));
    const named = (row: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        out[key] = typeof value === "string" && actor.has(value) ? actor.get(value) : typeof value === "string" && answer.has(value) ? answer.get(value) : value;
      }
      return out;
    };
    const out: Record<string, unknown[]> = {};
    out.schema = db.query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const { name } of db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%drizzle%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      // Rows in the order they were written, the change log's own ids left out (a live write may reuse a removed
      // one); a message's attachments and tags by key (a live write removes and writes them again on each line).
      const order = name === "attachments" ? "message_id, id" : name === "mentions" ? "message_id, position" : "rowid";
      const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}" ORDER BY ${order}`).all().map(named);
      const drop = new Set([...(name === "events" || name === "actors" ? ["id"] : []), ...(omit[name] ?? [])]);
      out[name] = rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !drop.has(key))));
    }
    return out;
  } finally {
    db.close();
  }
}

