export function phoneDiffStyle(phone: boolean, saved: 'split' | 'unified'): 'split' | 'unified' {
  return phone ? 'unified' : saved;
}

export function opensNavigatorOnLoad(phone: boolean, viewedCount: number): boolean {
  return phone && viewedCount === 0;
}
