import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest } from "../core/handler";
import type { FeedbackEntry } from "../core/storage";
import { createThrottle } from "../core/throttle";
import { D1FeedbackStore } from "../stores/d1";

const root = join(import.meta.dir, "..");
const schema = readFileSync(join(root, "schema.sql"), "utf-8");
const migration = readFileSync(join(root, "migrations/0001_agents.sql"), "utf-8");
const oldSchema = schema.replace(/^\s*agents TEXT,\n/m, "");

function d1(db: Database): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              db.query(sql).run(...(values as never[]));
              return { success: true, meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function table(sql: string): Database {
  const db = new Database(":memory:");
  db.exec(sql);
  return db;
}

const entry: FeedbackEntry = {
  message: "The search box forgets my last query.",
  category: "bug",
  contact: null,
  version: "0.28.40",
  os: "macOS",
  surface: "inbox",
  agents: "Claude Code, Codex",
  created_at: "2026-11-05T12:00:00.000Z",
};

const rows = (db: Database) => db.query("SELECT * FROM feedback").all() as Record<string, unknown>[];

describe("D1FeedbackStore", () => {
  test("the old schema really lacks the column (the test's premise)", () => {
    expect(oldSchema).not.toContain("agents TEXT");
    expect(() => table(oldSchema).query("INSERT INTO feedback (message, agents, created_at) VALUES ('x', 'y', 'z')").run()).toThrow(/no column named agents/);
  });

  test("on a table the migration has not reached, the feedback is stored once, without the names", async () => {
    const db = table(oldSchema);
    await new D1FeedbackStore(d1(db)).insert(entry);
    const stored = rows(db);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ message: entry.message, category: "bug", version: "0.28.40", os: "macOS", surface: "inbox", created_at: entry.created_at });
    expect("agents" in stored[0]!).toBe(false);
  });

  test("through the whole handler, an unmigrated table still answers 201", async () => {
    const db = table(oldSchema);
    const res = await handleRequest(
      new Request("https://feedback.example/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hi", surface: "inbox", agents: ["Codex"] }),
      }),
      { store: new D1FeedbackStore(d1(db)), throttle: createThrottle({ limit: 10, windowMs: 60_000 }), ip: "203.0.113.7" },
    );
    expect(res.status).toBe(201);
    expect(rows(db)).toHaveLength(1);
  });

  test("after the migration, and on a fresh schema, the names are stored", async () => {
    for (const db of [table(oldSchema + "\n" + migration), table(schema)]) {
      await new D1FeedbackStore(d1(db)).insert(entry);
      expect(rows(db)).toEqual([expect.objectContaining({ message: entry.message, agents: "Claude Code, Codex" })]);
      expect(() => db.query("UPDATE feedback SET agents = NULL").run()).toThrow(/append-only/);
      expect(() => db.query("DELETE FROM feedback").run()).toThrow(/append-only/);
    }
  });

  test("any other failure is not retried: it reaches the handler as a failed insert, and nothing is written", async () => {
    const db = new Database(":memory:");
    await expect(new D1FeedbackStore(d1(db)).insert(entry)).rejects.toThrow(/no such table/);
  });
});
