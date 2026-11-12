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
