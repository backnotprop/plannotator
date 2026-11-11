/// <reference types="bun-types" />
/**
 * The import's one write (`import.ts`): the rows worked out in memory (`import-rows.ts`) into a fresh database,
 * fast, because nothing reads it until the check and a crash only ever leaves a file the next start removes.
 *
 * - No journal and no syncing while loading: a half file is thrown away, never opened.
 * - One transaction; every row through a statement prepared once, many rows per statement.
 * - Indexes dropped before the load and built after it from the schema's own SQL (one sorted build each, and
 *   the unique ones check their rows as they are built).
 * - Then back to the live journal (WAL), still unsynced: `import.ts` flushes the whole file once, on another thread
 *   while it checks it, and runs `integrity_check`, all before the rename.
 */
import type { Database } from "bun:sqlite";
import type { ImportRow, ImportRows } from "./import-rows";

/** Rows per INSERT: a few hundred bound values each, well under SQLite's limit of 32,766. */
const ROWS_PER_INSERT = 64;

/**
 * Write `rows` into the empty, migrated database `sqlite`. (Flushing the pages already in the file while the rest is
 * written was tried: on a GitHub runner it made the load 1.2 s slower and the flush no shorter.)
 */
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
  // The live journal from here on; still no syncing: the import flushes the whole file once, beside its checks.
  sqlite.run("PRAGMA journal_mode = WAL");
}

/** The change log's rows with the ids a live write would give them: in write order, a removed typing row's id left unused. */
function* eventsWithIds(events: readonly (ImportRow | null)[]): Iterable<ImportRow> {
  for (let i = 0; i < events.length; i++) if (events[i]) yield { id: i + 1, ...events[i] };
}

/**
 * Insert `rows` into `table`, `ROWS_PER_INSERT` at a time. Every column of the table is bound; one a row does not
 * give is null (`import-rows.ts` fills the columns whose default is not null).
 */
function insertAll(sqlite: Database, table: string, rows: Iterable<ImportRow>): void {
  const columns = sqlite.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name);
  let full: ReturnType<Database["prepare"]> | null = null;
  let batch: (string | number | null)[] = [];
  let count = 0;
  const statement = (n: number) => sqlite.prepare(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES ${Array.from({ length: n }, () => `(${columns.map(() => "?").join(", ")})`).join(", ")}`);
  for (const row of rows) {
    for (const column of columns) batch.push(row[column] ?? null);
    if (++count === ROWS_PER_INSERT) {
      full ??= statement(ROWS_PER_INSERT);
      full.run(...batch);
      batch = [];
      count = 0;
    }
  }
  // Finalized here: a statement left open keeps the file open after `close()`, and the rename then breaks it.
  full?.finalize();
  if (count === 0) return;
  const rest = statement(count);
  rest.run(...batch);
  rest.finalize();
}
