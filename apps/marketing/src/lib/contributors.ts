// Fetches contributors, issue authors, and discussion participants from GitHub.
// Caches the result in-process so it only fetches once per build / dev session.

type Person = { login: string; avatarUrl: string; url: string };

export interface Contributors {
  authors: Person[];
  community: Person[];
}

let cached: Contributors | null = null;

const COAUTHOR_RE = /^Co-authored-by:\s*.+?\s*<([^>]+)>\s*$/gim;
const NOREPLY_ID_RE = /^(\d+)\+([^@]+)@users\.noreply\.github\.com$/;
const NOREPLY_LOGIN_RE = /^([^@]+)@users\.noreply\.github\.com$/;

async function fetchJSON(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  return res.ok ? res.json() : null;
}

async function fetchGraphQL(token: string, query: string) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return res.ok ? res.json() : null;
}

export async function getContributors(): Promise<Contributors> {
  if (cached) return cached;

  const authors = new Map<string, Person>();
  const headers: Record<string, string> = { 'Accept': 'application/vnd.github.v3+json' };
  const token = import.meta.env.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `bearer ${token}`;

  // REST /contributors covers the full commit history.
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
    try {
      // Paginate through all commits to collect every Co-authored-by trailer
      const coAuthorEmails = new Set<string>();
      let cursor: string | null = null;
      let hasNextPage = true;
      while (hasNextPage) {
        const afterClause = cursor ? `, after: "${cursor}"` : '';
        const json = await fetchGraphQL(token, `{
          repository(owner: "backnotprop", name: "plannotator") {
            defaultBranchRef {
              target {
                ... on Commit {
                  history(first: 100${afterClause}) {
                    pageInfo { hasNextPage endCursor }
                    nodes { message }
                  }
                }
              }
            }
          }
        }`);
        const history = json?.data?.repository?.defaultBranchRef?.target?.history;
        if (!history) break;
        for (const node of history.nodes || []) {
          const message: string = node?.message || '';
          for (const match of message.matchAll(COAUTHOR_RE)) {
            coAuthorEmails.add(match[1].toLowerCase());
          }
        }
        hasNextPage = history.pageInfo.hasNextPage;
        cursor = history.pageInfo.endCursor;
      }

      // Resolve co-author emails — these are code authors too
      for (const email of coAuthorEmails) {
        if (email.includes('noreply.github.com')) {
          const login = NOREPLY_ID_RE.exec(email)?.[2] ?? NOREPLY_LOGIN_RE.exec(email)?.[1];
          if (login && !authors.has(login)) {
            const user = await fetchJSON(`https://api.github.com/users/${login}`, headers);
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
      const json = await fetchGraphQL(token, `{
        repository(owner: "backnotprop", name: "plannotator") {
          issues(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { author { login avatarUrl url } }
          }
          discussions(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
            nodes { author { login avatarUrl url } }
          }
        }
      }`);
      const repo = json?.data?.repository;
      for (const node of repo?.issues?.nodes || []) {
        const u = node?.author;
        if (u?.login && !authors.has(u.login)) community.set(u.login, u);
      }
      for (const node of repo?.discussions?.nodes || []) {
        const u = node?.author;
        if (u?.login && !authors.has(u.login)) community.set(u.login, u);
      }
    } catch {}
  }

  cached = {
    authors: [...authors.values()],
    community: [...community.values()],
  };
  return cached;
}
