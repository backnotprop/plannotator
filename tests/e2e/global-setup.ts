/**
 * Before any spec:
 *
 *  - Never the live feedback Worker (its table is append-only). Every spec and
 *    every binary started with this env sends feedback to a closed loopback
 *    port (tests/setup/feedback-archive-off.ts).
 *  - Never the live daily ping: NO_ANON_PING=1 for every spec and every binary
 *    started with this env (tests/daily-ping-live-guard.test.ts).
 *  - Never a real agent CLI: recording stubs go first on the runner's PATH, and
 *    the returned teardown fails the run when any stub was called
 *    (agent-cli-stubs.ts).
 *  - In CI, says which flaky tests the quarantine leaves out (quarantine.ts).
 *
 * Playwright hands this process.env to its workers.
 */
import guardAgentClis from './agent-cli-stubs';
import { quarantineFilter, quarantinedTests } from './quarantine';

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env.PLANNOTATOR_FEEDBACK_URL = 'http://127.0.0.1:9/feedback';
  process.env.NO_ANON_PING = '1';
  if (quarantineFilter(process.env).grepInvert) {
    const left = quarantinedTests().map((t) => `  ${t.spec} › ${t.describe ? `${t.describe} › ` : ""}${t.title}`);
    console.log(`Quarantined in CI, left out of this run (tests/e2e/quarantine.json; run locally with bun run test:e2e:quarantine):\n${left.join('\n')}`);
  }
  return guardAgentClis();
}
