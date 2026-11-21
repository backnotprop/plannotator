/** The provenance line guides.show draws under the counts: repository, branch, the reviewed range. */
export function reviewSourceLine(snapshot: { source: { repo?: string; branch?: string }; review: { gitRef?: string } }): string {
  return [snapshot.source.repo, snapshot.source.branch, snapshot.review.gitRef].filter(Boolean).join(' · ');
}
