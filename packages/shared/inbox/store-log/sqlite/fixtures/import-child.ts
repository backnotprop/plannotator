/**
 * Test-only child process for `import-crash.test.ts`, so it can SIGKILL the move.
 *   bun import-child.ts <dataDir> <now ISO> import | import:<step>[:<n>] | return:<step>[:<n>] | open
 * Prints `loading <ms>`, `loaded <ms>` and `done <status> <ms>`; touches nothing but `<dataDir>`.
 */
import { INBOX_CHECK_CHILD_ENV, runInboxCheckChild } from "../check-child";
import { importJsonlInbox } from "../import";
import { openInboxStore } from "../open-store";
import { returnToJsonl } from "../return-to-files";

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

if (what === "open") {
  const opened = await openInboxStore(dataDir, { sqlite: null, now });
  process.stdout.write(`done ${opened.log} ${opened.why} ${opened.store.listProjects().length}\n`);
} else if (what === "import") {
  const outcome = await importJsonlInbox(dataDir, { now, step, checkFilesCommand: [process.execPath, import.meta.path] });
  process.stdout.write(`done ${outcome.status} ${performance.now()}\n`);
} else {
  const outcome = returnToJsonl(dataDir, { now, step });
  process.stdout.write(`done ${outcome.status}\n`);
}
