/**
 * The app's flow specs (apps/mobile/contract/flows/), in order: read by
 * scripts/mobile/surface.ts for the parity surface and by
 * tests/mobile-flows.test.ts for their citations. Imports nothing, so the
 * flows' test reaches no generator.
 */

/** The flows, in order. A new flow file is added here (a folder is never listed). */
export const FLOW_FILES = [
  'apps/mobile/contract/flows/01-navigation.md',
  'apps/mobile/contract/flows/02-pairing.md',
  'apps/mobile/contract/flows/03-list.md',
  'apps/mobile/contract/flows/04-thread.md',
  'apps/mobile/contract/flows/05-answer.md',
  'apps/mobile/contract/flows/06-reply.md',
  'apps/mobile/contract/flows/07-attachment.md',
  'apps/mobile/contract/flows/08-plan.md',
  'apps/mobile/contract/flows/09-agents.md',
  'apps/mobile/contract/flows/10-run-and-secret.md',
  'apps/mobile/contract/flows/11-notifications.md',
  'apps/mobile/contract/flows/12-offline.md',
  'apps/mobile/contract/flows/13-computers.md',
  'apps/mobile/contract/flows/14-live-status.md',
  'apps/mobile/contract/flows/15-computer-settings.md',
] as const;
