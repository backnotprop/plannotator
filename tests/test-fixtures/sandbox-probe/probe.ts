/**
 * Run by tests/never-touch-the-real-inbox.test.ts as `bun <this file>` from a
 * folder with no bunfig: imports the Inbox test helper the way a test file
 * does and prints the data dir the process ended up with, or fails when the
 * import refused it.
 */
import "../../helpers/inbox-world";

process.stdout.write(`${process.env.PLANNOTATOR_DATA_DIR}\n`);
