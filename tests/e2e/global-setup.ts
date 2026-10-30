/**
 * Before any spec:
 *
 *  - Never the live feedback Worker (its table is append-only). Every spec and
 *    every binary started with this env sends feedback to a closed loopback
 *    port (tests/setup/feedback-archive-off.ts).
 *  - Never a real agent CLI: recording stubs go first on the runner's PATH, and
 *    the returned teardown fails the run when any stub was called
 *    (agent-cli-stubs.ts).
 *
 * Playwright hands this process.env to its workers.
 */
import guardAgentClis from './agent-cli-stubs';

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env.PLANNOTATOR_FEEDBACK_URL = 'http://127.0.0.1:9/feedback';
  return guardAgentClis();
}
