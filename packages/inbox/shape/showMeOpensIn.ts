export function showMeBoardOpensIn(now: { page: string; thread?: string | null }, home: string | null): 'here' | 'home' {
  if (!home || now.page === 'shapes' || (now.page === 'inbox' && now.thread === home)) return 'here';
  return 'home';
}
