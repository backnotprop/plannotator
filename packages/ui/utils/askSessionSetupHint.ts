import type { Origin } from '@plannotator/core/agents';
import { isSessionBridgeProvider, type AIProviderOption } from './aiProvider';

export const OMP_EXTENSION_INSTALL_COMMAND = 'omp plugin install @plannotator/pi-extension';

export function askSessionSetupHint(
  origin: Origin | null | undefined,
  providers: ReadonlyArray<Pick<AIProviderOption, 'name' | 'sessionBridge'>>,
): string | null {
  if (origin !== 'oh-my-pi') return null;
  if (providers.some(isSessionBridgeProvider)) return null;
  return `To ask your Oh My Pi session instead, install the Plannotator extension (${OMP_EXTENSION_INSTALL_COMMAND}) and open reviews with its /plannotator-* commands.`;
}
