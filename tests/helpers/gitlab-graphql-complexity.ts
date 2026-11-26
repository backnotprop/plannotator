/**
 * A conservative estimate of the complexity GitLab gives a GraphQL query, from the query's text.
 *
 * GitLab refuses a query whose complexity is over its limit (app/graphql/gitlab_schema.rb: 200 without a user, 250
 * for a signed-in user, 300 for an admin), with an error and no data. GitLab does not publish a calculator; this
 * follows its own rules (app/graphql/types/base_field.rb, app/graphql/resolvers/base_resolver.rb) and errs high:
 *
 * - every field counts 1, `count` and `nodes` included; a field GitLab gives a fixed weight counts that weight
 *   (`mergedAt`, `reviewers`: 5), and a field that may call Gitaly (`calls_gitaly: true`) counts 1 more;
 * - a field with arguments counts 1 more (its resolver), and 1 more again with `sort:`;
 * - a connection asked with `first: N` costs its own count and everything under it times (1 + min(N, 100) × 0.01),
 *   GitLab's connection multiplier (applied here to every connection; GitLab applies it to resolver ones only);
 * - an inline fragment's fields (`... on X { … }`) count as the parent's.
 *
 * Over the query that asked a person's four merge request lists at once it gives about 300; a GitLab reported 301.
 */

/** GitLab's fixed weights (`complexity:` on the field). */
const FIXED: Record<string, number> = { mergedAt: 5, reviewers: 5 };
/** Fields GitLab marks `calls_gitaly: true`. */
const GITALY = new Set(["diffHeadSha", "approved", "detailedMergeStatus", "diffStatsSummary", "rootRef"]);

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
  let own = FIXED[field.name] ?? 1;
  if (GITALY.has(field.name)) own += 1;
  if (Object.keys(field.args).length > 0) own += 1;
  if ("sort" in field.args) own += 1;
  const total = own + field.children.reduce((sum, child) => sum + fieldCost(child), 0);
  const first = Number(field.args.first);
  return Number.isFinite(first) && first > 0 ? total * (1 + Math.min(first, 100) * 0.01) : total;
}

/** The estimate for these top-level fields, rounded up. */
export function estimateGqlFields(fields: readonly GqlField[]): number {
  return Math.ceil(fields.reduce((sum, field) => sum + fieldCost(field), 0));
}

/** The estimate for a whole query's text. */
export function estimateGitlabComplexity(query: string): number {
  return estimateGqlFields(parseGqlQuery(query));
}
