/**
 * Test-only: the move between the JSONL files and `inbox.db`, run in its own process so the crash test
 * (`../import-crash.test.ts`) can kill it with SIGKILL, as a power cut or a force quit would.
 *
 *   bun import-child.ts <dataDir> <now ISO> import                  run the import to the end
 *   bun import-child.ts <dataDir> <now ISO> import:<step>[:<n>]     kill itself at the n-th time it reaches <step>
 *   bun import-child.ts <dataDir> <now ISO> return:<step>[:<n>]     the same, for the way back to the files
 *
 * The import checks its files' side in a second run of this file, as the Inbox does with its own program.
 *
 * Prints `loading <ms>` when the import starts working out and writing the database, `loaded <ms>` once it is
 * written (the window the test's random kills aim at), and `done <status> <ms>` at the end. It touches nothing but
 * `<dataDir>`.
 */
import { INBOX_CHECK_CHILD_ENV, runInboxCheckChild } from "../check-child";
import { importJsonlInbox } from "../import";
import { returnToJsonl } from "../return-to-files";

// Run again as the move's second process (its files' side of the check), as the Inbox runs itself.
if (process.env[INBOX_CHECK_CHILD_ENV]) process.exit(await runInboxCheckChild(process.env));

const [dataDir, nowIso, mode] = process.argv.slice(2) as [string, string, string];
const now = () => new Date(nowIso);
const [what, at, nth] = mode.split(":") as [string, string | undefined, string | undefined];
let seen = 0;
const step = (name: string) => {
  if (what === "import" && name === "read") process.stdout.write(`loading ${performance.now()}\n`);
  if (what === "import" && name === "load") process.stdout.write(`loaded ${performance.now()}\n`);
  if (name !== at || ++seen !== Number(nth ?? 1)) return;
  // The crash: nothing after this line runs, no finally, no exit handler.
  process.kill(process.pid, "SIGKILL"); // inbox-guard: own child
};

if (what === "import") {
  const outcome = await importJsonlInbox(dataDir, { now, step, checkFilesCommand: [process.execPath, import.meta.path] });
  process.stdout.write(`done ${outcome.status} ${performance.now()}\n`);
} else {
  const outcome = returnToJsonl(dataDir, { now, step });
  process.stdout.write(`done ${outcome.status}\n`);
}
