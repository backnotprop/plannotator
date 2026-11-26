/**
 * A conservative estimate of the complexity GitLab gives a GraphQL query, from the query's text.
 *
 * GitLab refuses a query whose complexity is over its limit (app/graphql/gitlab_schema.rb: 200 without a user, 250
 * for a signed-in user, 300 for an admin), with an error and no data. GitLab does not publish a calculator; this
 * follows its own rules (app/graphql/types/base_field.rb, app/graphql/resolvers/base_resolver.rb) and errs high:
 *
 * - only a field in `KNOWN` is scored: any other field name throws, so a field added to a query is looked up first;
 * - every field counts 1, `count` and `nodes` included; a field GitLab gives a fixed weight counts that weight
 *   (`mergedAt`, `reviewers`: 5), and a field that may call Gitaly (`calls_gitaly: true`) counts 1 more;
 * - a resolver field, or any field with arguments, counts 1 more, 1 more again with `sort:`, and 5 more with `search:`;
 * - a connection asked with `first: N` (or `last: N`) costs its own count and everything under it times
 *   (1 + min(N, 100) × 0.01), GitLab's connection multiplier (applied here to every connection so asked; GitLab
 *   applies it to resolver ones only); a resolver connection asked with neither is scored at GitLab's page size, 100
 *   (× 2), as GitLab does;
 * - an inline fragment's fields (`... on X { … }`) count as the parent's.
 *
 * Over the query that asked a person's four merge request lists at once it gives about 300; a GitLab reported 301.
 */

interface Weight {
  /** GitLab's fixed weight (`complexity:` on the field); 1 when it has none. */
  fixed?: number;
  /** `calls_gitaly: true`. */
  gitaly?: true;
  /** Resolved by a resolver class (`resolver:`), not a plain method. */
  resolver?: true;
  /** A connection type (`….connection_type`). */
  connection?: true;
}

/**
 * Every GitLab field the Inbox asks, and what GitLab's source says it costs: app/graphql/types/merge_request_type.rb,
 * user_interface.rb (the user's merge request lists), project_type.rb, repository_type.rb, query_type.rb, and
 * base_field.rb / resolvers/base_resolver.rb for how those add up. Keyed by field name across types: where two types
 * share a name, the costlier reading is kept (`project` is a resolver on Query, a plain field on a merge request).
 */
const KNOWN: Record<string, Weight> = {
  // Query, users
  currentUser: { resolver: true },
  username: {},
  avatarUrl: {},
  reviewRequestedMergeRequests: { resolver: true, connection: true },
  authoredMergeRequests: { resolver: true, connection: true },
  assignedMergeRequests: { resolver: true, connection: true },
  // Projects
  project: { resolver: true },
  sourceProject: {},
  fullPath: {},
  repository: {},
  rootRef: { gitaly: true },
  mergeRequests: { resolver: true, connection: true },
  // Connections
  count: {},
  nodes: {},
  // Merge requests
  iid: {},
  title: {},
  webUrl: {},
  state: {},
  draft: {},
  updatedAt: {},
  mergedAt: { fixed: 5 },
  sourceBranch: {},
  targetBranch: {},
  diffHeadSha: { gitaly: true },
  approved: { gitaly: true },
  detailedMergeStatus: { gitaly: true },
  conflicts: {},
  diffStatsSummary: { gitaly: true },
  additions: {},
  deletions: {},
  fileCount: {},
  headPipeline: {},
  status: {},
  author: {},
  approvedBy: { connection: true },
  reviewers: { fixed: 5, connection: true },
};

/** GitLab's default page size, and the most a connection gives (`default_max_page_size`). */
const PAGE_SIZE = 100;

export interface GqlField {
  name: string;
  args: Record<string, string>;
  children: GqlField[];
}

function tokens(text: string): string[] {
  const out: string[] = [];
  const re = /\s+|,|#[^\n]*|("(?:[^"\\]|\\.)*")|(\.\.\.)|([A-Za-z_$][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)|([{}():[\]!=@])/gy;
  while (re.lastIndex < text.length) {
    const m = re.exec(text);
    if (!m) throw new Error(`cannot read the query at ${re.lastIndex}`);
    const tok = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
    if (tok !== undefined) out.push(tok);
  }
  return out;
}

/** The query's top-level fields (its operation's selection set), by their field names (aliases dropped). */
export function parseGqlQuery(text: string): GqlField[] {
  const t = tokens(text);
  let i = 0;
  const take = (tok: string) => {
    if (t[i] !== tok) throw new Error(`expected ${tok} at token ${i}, got ${t[i]}`);
    i++;
  };
  const skipValue = (): string => {
    const start = i;
    if (t[i] === "[" || t[i] === "{") {
      const close = t[i] === "[" ? "]" : "}";
      i++;
      while (t[i] !== close) {
        if (close === "}") {
          i++;
          take(":");
        }
        skipValue();
      }
    }
    i++;
    return t.slice(start, i).join(" ");
  };
  const selectionSet = (): GqlField[] => {
    take("{");
    const fields: GqlField[] = [];
    while (t[i] !== "}") {
      if (i >= t.length) throw new Error("unclosed selection set");
      if (t[i] === "...") {
        i++;
        if (t[i] === "on") i += 2;
        fields.push(...selectionSet());
        continue;
      }
      let name = t[i++]!;
      if (t[i] === ":") {
        i++;
        name = t[i++]!;
      }
      const args: Record<string, string> = {};
      if (t[i] === "(") {
        i++;
        while (t[i] !== ")") {
          const key = t[i++]!;
          take(":");
          args[key] = skipValue();
        }
        i++;
      }
      fields.push({ name, args, children: t[i] === "{" ? selectionSet() : [] });
    }
    i++;
    return fields;
  };
  if (t[i] === "query") {
    i++;
    if (t[i] !== "{" && t[i] !== "(") i++;
    if (t[i] === "(") {
      while (t[i] !== ")") i++;
      i++;
    }
  }
  return selectionSet();
}

function fieldCost(field: GqlField): number {
  const weight = Object.hasOwn(KNOWN, field.name) ? KNOWN[field.name]! : null;
  if (!weight) {
    throw new Error(
      `GitLab field "${field.name}" has no known weight: look up its complexity:, calls_gitaly:, resolver: and connection type in GitLab's source (app/graphql/types/merge_request_type.rb, user_interface.rb, project_type.rb, repository_type.rb, …) and add it to KNOWN in tests/helpers/gitlab-graphql-complexity.ts`,
    );
  }
  let own = weight.fixed ?? 1;
  if (weight.gitaly) own += 1;
  if (weight.resolver || Object.keys(field.args).length > 0) own += 1;
  if ("sort" in field.args) own += 1;
  if ("search" in field.args) own += 5;
  const total = own + field.children.reduce((sum, child) => sum + fieldCost(child), 0);
  const asked = [field.args.first, field.args.last].map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const limit = asked.length > 0 ? Math.min(...asked, PAGE_SIZE) : weight.resolver && weight.connection ? PAGE_SIZE : 0;
  return total * (1 + limit * 0.01);
}

/** The estimate for these top-level fields, rounded up. */
export function estimateGqlFields(fields: readonly GqlField[]): number {
  return Math.ceil(fields.reduce((sum, field) => sum + fieldCost(field), 0));
}

/** The estimate for a whole query's text. */
export function estimateGitlabComplexity(query: string): number {
  return estimateGqlFields(parseGqlQuery(query));
}
