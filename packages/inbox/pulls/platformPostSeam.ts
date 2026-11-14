import { mock } from 'bun:test';

export async function realPlatformPost(): Promise<void> {
  const seam: string = '../guide/PlatformPost.tsx';
  const real = (await import(seam)) as Record<string, unknown>;
  mock.module('#platform-post', () => real);
  await (await import('../threadDrawReady')).diffDrawReady(['typescript']);
}
