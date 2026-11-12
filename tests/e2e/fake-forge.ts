import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeForge {
  dir: string;
  calls(): string[];
  github(number: number, answer: unknown): void;
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
