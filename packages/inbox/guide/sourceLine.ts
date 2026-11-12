export function reviewSourceLine(snapshot: { source: { repo?: string; branch?: string }; review: { gitRef?: string } }): string {
  return [snapshot.source.repo, snapshot.source.branch, snapshot.review.gitRef].filter(Boolean).join(' · ');
}
