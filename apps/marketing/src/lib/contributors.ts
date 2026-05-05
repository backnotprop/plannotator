// Fetches contributors, issue authors, and discussion participants from GitHub.
// Caches the result in-process so it only fetches once per build / dev session.

type Person = { login: string; avatarUrl: string; url: string };

let cached: Person[] | null = null;

const COAUTHOR_RE = /^Co-authored-by:\s*.+?\s*<([^>]+)>\s*$/gim;

export async function getContributors(): Promise<Person[]> {
  if (cached) return cached;

  const people = new Map<string, Person>();
  const token = import.meta.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN;

  if (token) {
    const coAuthorEmails = new Set<string>();
    try {
      const query = `{
        repository(owner: "backnotprop", name: "plannotator") {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100) {
                  nodes {
                    author { user { login avatarUrl url } }
                    message
                  }
                }
              }
            }
          }
          issues(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { author { login avatarUrl url } }
          }
          discussions(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { author { login avatarUrl url } }
          }
        }
      }`;
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: { 'Authorization': `bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (res.ok) {
        const json = await res.json();
        const repo = json.data?.repository;
        for (const node of repo?.defaultBranchRef?.target?.history?.nodes || []) {
          const u = node?.author?.user;
          if (u?.login) people.set(u.login, u);
          const message: string = node?.message || '';
          for (const match of message.matchAll(COAUTHOR_RE)) {
            coAuthorEmails.add(match[1].toLowerCase());
          }
        }

        // Resolve co-author emails before processing issues/discussions so
        // they appear alongside commit authors in the natural recency order.
        for (const email of coAuthorEmails) {
          try {
            const r = await fetch(
              `https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email`,
              {
                headers: {
                  'Authorization': `bearer ${token}`,
                  'Accept': 'application/vnd.github.v3+json',
                },
              },
            );
            if (r.ok) {
              const j = await r.json();
              const item = j?.items?.[0];
              if (item?.login && item?.type === 'User' && !people.has(item.login)) {
                people.set(item.login, {
                  login: item.login,
                  avatarUrl: item.avatar_url,
                  url: item.html_url,
                });
              }
            }
          } catch {}
        }

        for (const node of repo?.issues?.nodes || []) {
          const u = node?.author;
          if (u?.login) people.set(u.login, u);
        }
        for (const node of repo?.discussions?.nodes || []) {
          const u = node?.author;
          if (u?.login) people.set(u.login, u);
        }
      }
    } catch {}
  } else {
    try {
      const res = await fetch(
        'https://api.github.com/repos/backnotprop/plannotator/contributors?per_page=100',
        { headers: { 'Accept': 'application/vnd.github.v3+json' } },
      );
      if (res.ok) {
        const data = await res.json();
        for (const c of data) {
          if (c.type === 'User' && c.login) {
            people.set(c.login, {
              login: c.login,
              avatarUrl: c.avatar_url,
              url: c.html_url,
            });
          }
        }
      }
    } catch {}
  }

  cached = [...people.values()];
  return cached;
}
