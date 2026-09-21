/** Build-time stand-in — the portable viewer never mints a reviewer identity. */
export function generateIdentity(): string {
  return 'reader';
}

export type IdentityGenerator = () => string;

/**
 * No-op registration, so the viewer build keeps working should
 * `packages/ui/configure.ts` (which imports `setIdentityGenerator` from the
 * real module) ever enter its import graph. The viewer never mints a name, so
 * there is nothing to register into.
 */
export function setIdentityGenerator(_next: IdentityGenerator): void {}
