/**
 * Where a new board from a thread's Show me opens: over the page as it is when that page is the grid or the board's
 * own thread (`here`), else in its own thread (`home`), never over another thread the person moved to meanwhile.
 */
export function showMeBoardOpensIn(now: { page: string; thread?: string | null }, home: string | null): 'here' | 'home' {
  if (!home || now.page === 'shapes' || (now.page === 'inbox' && now.thread === home)) return 'here';
  return 'home';
}
