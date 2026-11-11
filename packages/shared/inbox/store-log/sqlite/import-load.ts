/// <reference types="bun-types" />
/** Loads the import's rows into a fresh database: no journal or syncing (a half file is thrown away), indexes built after the load. */
import type { Database } from "bun:sqlite";
import type { ImportRow, ImportRows } from "./import-rows";

/** Rows per INSERT: a few hundred bound values each, well under SQLite's limit of 32,766. */
const ROWS_PER_INSERT = 64;

/** Write `rows` into the empty, migrated database `sqlite`. */
export function loadImportRows(sqlite: Database, rows: ImportRows): void {
  sqlite.run("PRAGMA journal_mode = OFF");
  sqlite.run("PRAGMA synchronous = OFF");
  sqlite.run("PRAGMA temp_store = MEMORY");
  sqlite.run("PRAGMA cache_size = -131072");
  const indexes = sqlite.query<{ name: string; sql: string }, []>("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all();
  sqlite.transaction(() => {
    for (const { name } of indexes) sqlite.run(`DROP INDEX "${name}"`);
    insertAll(sqlite, "actors", rows.actors.rows.values());
    insertAll(sqlite, "events", eventsWithIds(rows.events));
    insertAll(sqlite, "projects", rows.projects.rows.values());
    insertAll(sqlite, "messages", rows.messages.rows.values());
    insertAll(sqlite, "threads", rows.threads.rows.values());
    insertAll(sqlite, "read_state", rows.readState.rows.values());
    insertAll(sqlite, "attachments", [...rows.attachments.values()].flatMap((each) => [...each.rows.values()]));
    insertAll(sqlite, "mentions", [...rows.mentions.values()].flat());
    insertAll(sqlite, "questions", rows.questions.rows.values());
    insertAll(sqlite, "answers", rows.answers.rows.values());
    insertAll(sqlite, "annotations", rows.annotations.rows.values());
    insertAll(sqlite, "cards", rows.cards.rows.values());
    insertAll(sqlite, "steps", rows.steps.rows.values());
    insertAll(sqlite, "thread_pulls", rows.threadPulls.rows.values());
    insertAll(sqlite, "thread_pull_events", rows.threadPullEvents);
    insertAll(sqlite, "initiatives", rows.initiatives.rows.values());
    insertAll(sqlite, "thread_names", rows.threadNames);
    insertAll(sqlite, "message_tags", rows.messageTags);
    for (const { sql } of indexes) sqlite.run(sql);
  })();
  // Still unsynced: the import flushes the whole file once.
  sqlite.run("PRAGMA journal_mode = WAL");
}

function* eventsWithIds(events: readonly (ImportRow | null)[]): Iterable<ImportRow> {
  for (const event of events) if (event) yield event;
}

/** Every column is bound; one a row does not give is null. */
function insertAll(sqlite: Database, table: string, rows: Iterable<ImportRow>): void {
  const columns = sqlite.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);
  const width = columns.length;
  const statement = (n: number) => sqlite.prepare(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${Array.from({ length: n }, () => `(${columns.map(() => "?").join(", ")})`).join(", ")}`);
  let full: ReturnType<Database["prepare"]> | null = null;
  const batch: (string | number | null)[] = new Array(ROWS_PER_INSERT * width).fill(null);
  let count = 0;
  for (const row of rows) {
    const at = count * width;
    for (let c = 0; c < width; c++) batch[at + c] = row[columns[c]!] ?? null;
    if (++count === ROWS_PER_INSERT) {
      full ??= statement(ROWS_PER_INSERT);
      // An array binds positionally (bun:sqlite), though its types only name a spread.
      full.run(batch as never);
      count = 0;
    }
  }
  // Finalized here: a statement left open keeps the file open after `close()`, and the rename then breaks it.
  full?.finalize();
  if (count === 0) return;
  const rest = statement(count);
  rest.run(batch.slice(0, count * width) as never);
  rest.finalize();
}
