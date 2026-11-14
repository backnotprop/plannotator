import { storage } from '@plannotator/ui/utils/storage';
import type { SecondOpinionLink, SecondOpinionState } from '@plannotator/sem-diff';

export interface PowerUpFileState {
  state: 'asking' | SecondOpinionState;
  links: SecondOpinionLink[];
}

export interface PowerUpStatus {
  asking: number;
  answered: number;
  links: number;
  unavailable: Exclude<PowerUpFileState['state'], 'asking' | 'ok'> | null;
}

export interface PowerUpConfig {
  active: boolean;
  rejected: readonly string[];
  provider: 'jev' | 'clef' | null;
  retry: number;
}

const REJECTED_KEY = 'plannotator-power-up-rejected';
const MAX_REJECTED = 150;

export function readPowerUpRejected(): readonly string[] {
  try {
    const parsed = JSON.parse(storage.getItem(REJECTED_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id)) : [];
  } catch {
    return [];
  }
}

export function writePowerUpRejected(ids: readonly string[]): readonly string[] {
  const kept = ids.slice(-MAX_REJECTED);
  storage.setItem(REJECTED_KEY, JSON.stringify(kept));
  return kept;
}

export const PROVIDER_NAME: Record<'jev' | 'clef', string> = { jev: 'Jev', clef: 'Clef' };
