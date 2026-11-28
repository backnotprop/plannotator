export const MAX_SEM_DIFF_WORKERS = 4;
const LOW_MEMORY_GB = 4;

export interface SemDiffDevice {
  cores?: number;
  memoryGb?: number;
  touch?: boolean;
}

export function semDiffPoolSize({ cores, memoryGb, touch }: SemDiffDevice): number {
  if (touch || (memoryGb != null && memoryGb <= LOW_MEMORY_GB)) return 1;
  return Math.max(1, Math.min(MAX_SEM_DIFF_WORKERS, Math.floor((cores ?? 2) / 2) - 1));
}

export function thisDevice(): SemDiffDevice {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  return {
    cores: nav?.hardwareConcurrency,
    memoryGb: nav?.deviceMemory,
    touch: typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches,
  };
}
