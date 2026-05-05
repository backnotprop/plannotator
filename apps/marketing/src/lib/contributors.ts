// Fetches contributors, issue authors, and discussion participants from GitHub.
// Caches the result in-process so it only fetches once per build / dev session.

type Person = { login: string; avatarUrl: string; url: string };

export interface Contributors {
  authors: Person[];
  community: Person[];
}

let cached: Contributors | null = null;

const COAUTHOR_RE = /^Co-authored-by:\s*.+?\s*<([^>]+)>\s*$/gim;
const NOREPLY_RE = /^(\d+)\+([^@]+)@users\.noreply\.github\.com$/;

async function fetchJSON(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  return res.ok ? res.json() : null;
}

export async function getContributors(): Promise<Contributors> {
  if (cached) return cached;

  const authors = new Map<string, Person>();
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
  const token = import.meta.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `bearer ${token}`;

  // REST /contributors covers the full commit history (not just last 100).
  try {
    const data = await fetchJSON(
      'https://api.github.com/repos/backnotprop/plannotator/contributors?per_page=100',
      headers,
    );
    if (data) {
      for (const c of data) {
        if (c.type === 'User' && c.login) {
          authors.set(c.login, { login: c.login, avatarUrl: c.avatar_url, url: c.html_url });
        }
      }
    }
  } catch {}

  const community = new Map<string, Person>();

  if (token) {
    // GraphQL adds issue authors, discussion participants, and commit messages
    // for Co-authored-by parsing — none of which REST /contributors provides.
    try {
      const query = `{
        repository(owner: "backnotprop", name: "plannotator") {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100) {
                  nodes { message }
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

        // Parse co-author emails from commit messages
        const coAuthorEmails = new Set<string>();
        for (const node of repo?.defaultBranchRef?.target?.history?.nodes || []) {
          const message: string = node?.message || '';
          for (const match of message.matchAll(COAUTHOR_RE)) {
            coAuthorEmails.add(match[1].toLowerCase());
          }
        }

        // Resolve co-author emails — these are code authors too
        for (const email of coAuthorEmails) {
          if (email.includes('noreply.github.com')) {
            const m = NOREPLY_RE.exec(email);
            if (m && !authors.has(m[2])) {
              const user = await fetchJSON(`https://api.github.com/users/${m[2]}`, headers);
              if (user?.login && user?.type === 'User') {
                authors.set(user.login, { login: user.login, avatarUrl: user.avatar_url, url: user.html_url });
              }
            }
          } else {
            const data = await fetchJSON(
              `https://api.github.com/search/users?q=${encodeURIComponent(email)}+in:email`,
              headers,
            );
            const item = data?.items?.[0];
            if (item?.login && item?.type === 'User' && !authors.has(item.login)) {
              authors.set(item.login, { login: item.login, avatarUrl: item.avatar_url, url: item.html_url });
            }
          }
        }

        // Issue and discussion authors who aren't code contributors
        for (const node of repo?.issues?.nodes || []) {
          const u = node?.author;
          if (u?.login && !authors.has(u.login)) community.set(u.login, u);
        }
        for (const node of repo?.discussions?.nodes || []) {
          const u = node?.author;
          if (u?.login && !authors.has(u.login)) community.set(u.login, u);
        }
      }
    } catch {}
  }

  cached = {
    authors: [...authors.values()],
    community: [...community.values()],
  };
  return cached;
}
