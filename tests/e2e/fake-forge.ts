/**
 * A scripted `gh` and `glab` for the hover-card e2e spec, so no spec runs the
 * real ones or reaches GitHub or GitLab. Plain sh, like fake-tailscale.ts.
 *
 * `gh api graphql … -F number=N` prints `<dir>/gh-N.json` (exit 0), or
 * `<dir>/gh-N.err` on stderr (exit 1), else GitHub's not-found error.
 * `glab api graphql … -f iid=N` prints `<dir>/glab-mr-N.json` for the merge
 * request query and `<dir>/glab-issue-N.json` for the issue one. `gh auth
 * status` reports one signed-in account. The Board's batch of lane-card
 * marks (`query CardMarks`, one `n<N>: issueOrPullRequest(number: N)` alias
 * a link) answers each alias from the item `github()` was given (its state,
 * draft flag, state reason and title), or null. Every call is one line in
 * `<dir>/calls` (`gh number=12`, `gh marks 11,12,14`, `glab mr iid=7`), never
 * the query text.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeForge {
  /** Put first on PATH. */
  dir: string;
  /** The calls made so far, one per line. */
  calls(): string[];
  /** A GitHub item's GraphQL answer (or an error line for stderr). */
  github(number: number, answer: unknown): void;
  /** A GitLab item's GraphQL answer. */
  gitlab(kind: 'mr' | 'issue', iid: number, answer: unknown): void;
}

export function fakeForge(dir: string): FakeForge {
  mkdirSync(dir, { recursive: true });
  const calls = join(dir, 'calls');
  writeFileSync(calls, '');
  const gh = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'if [ "$1" = auth ] && [ "$2" = status ]; then',
    '  echo \'{"hosts":{"github.com":[{"login":"e2e","active":true,"state":"success","tokenSource":"keyring"}]}}\'',
    '  exit 0',
    'fi',
    'q=""',
    'for a; do case "$a" in query=*CardMarks*) q="$a";; esac; done',
    'if [ -n "$q" ]; then',
    '  nums=$(printf "%s" "$q" | grep -o "issueOrPullRequest(number: [0-9]*)" | grep -o "[0-9][0-9]*" | sort -n)',
    '  echo "gh marks $(echo $nums | tr " " ",")" >> "$dir/calls"',
    '  printf \'{"data":{"repository":{\'',
    '  sep=""',
    '  for n in $nums; do',
    '    printf \'%s"n%s":\' "$sep" "$n"; sep=","',
    '    if [ -f "$dir/gh-mark-$n.json" ]; then cat "$dir/gh-mark-$n.json"; else printf null; fi',
    '  done',
    '  printf \'}}}\\n\'',
    '  exit 0',
    'fi',
    'n=""',
    'for a; do case "$a" in number=*) n="${a#number=}";; esac; done',
    'echo "gh number=$n" >> "$dir/calls"',
    'if [ -f "$dir/gh-$n.json" ]; then cat "$dir/gh-$n.json"; exit 0; fi',
    'if [ -f "$dir/gh-$n.err" ]; then cat "$dir/gh-$n.err" >&2; exit 1; fi',
    'echo "GraphQL: Could not resolve to an issue or pull request with the number of $n. (repository.issueOrPullRequest)" >&2',
    'exit 1',
    '',
  ].join('\n');
  const glab = [
    '#!/bin/sh',
    `dir='${dir}'`,
    'n=""; kind=issue',
    'for a; do case "$a" in iid=*) n="${a#iid=}";; *mergeRequest\\(*) kind=mr;; esac; done',
    'echo "glab $kind iid=$n" >> "$dir/calls"',
    'if [ -f "$dir/glab-$kind-$n.json" ]; then cat "$dir/glab-$kind-$n.json"; exit 0; fi',
    'echo \'{"data":{"project":{"mergeRequest":null,"issue":null}}}\'',
    'exit 0',
    '',
  ].join('\n');
  for (const [name, body] of [['gh', gh], ['glab', glab]] as const) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return {
    dir,
    calls: () => readFileSync(calls, 'utf8').split('\n').filter(Boolean),
    github: (number, answer) => {
      if (typeof answer === 'string') return writeFileSync(join(dir, `gh-${number}.err`), answer);
      writeFileSync(join(dir, `gh-${number}.json`), JSON.stringify(answer));
      const item = (answer as { data?: { repository?: { issueOrPullRequest?: Record<string, unknown> } } }).data?.repository?.issueOrPullRequest;
      if (item) writeFileSync(join(dir, `gh-mark-${number}.json`), JSON.stringify({ __typename: item.__typename, state: item.state, isDraft: item.isDraft ?? false, stateReason: item.stateReason ?? null, title: item.title }));
    },
    gitlab: (kind, iid, answer) => writeFileSync(join(dir, `glab-${kind}-${iid}.json`), JSON.stringify(answer)),
  };
}
