import type { Origin } from '@plannotator/core/agents';
import { isSessionBridgeProvider, type AIProviderOption } from './aiProvider';

/**
 * The command that installs the Plannotator extension into Oh My Pi. OMP loads
 * Pi extensions as OMP plugins; this is the one place the UI names it.
 */
export const OMP_EXTENSION_INSTALL_COMMAND = 'omp plugin install @plannotator/pi-extension';

/**
 * A one-line note for Ask AI when the agent that opened Plannotator COULD
 * answer "Ask this session" but this session has no bridge to it (#1814).
 *
 * Only Oh My Pi qualifies today: origin `oh-my-pi` means the CLI ran from
 * OMP's shell (OMP exports `OMPCODE` to its bash children), which never has a
 * bridge, while the Plannotator extension loaded into OMP does. Every other
 * origin without a bridge either has no way to get one or is already covered,
 * so it gets no note. A session that has a bridge never shows it.
 */
export function askSessionSetupHint(
  origin: Origin | null | undefined,
  providers: ReadonlyArray<Pick<AIProviderOption, 'name' | 'sessionBridge'>>,
): string | null {
  if (origin !== 'oh-my-pi') return null;
  if (providers.some(isSessionBridgeProvider)) return null;
  return `To ask your Oh My Pi session instead, install the Plannotator extension (${OMP_EXTENSION_INSTALL_COMMAND}) and open reviews with its /plannotator-* commands.`;
}
