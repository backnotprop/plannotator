export function generateIdentity(): string {
  return 'reader';
}

export type IdentityGenerator = () => string;

export function setIdentityGenerator(_next: IdentityGenerator): void {}
