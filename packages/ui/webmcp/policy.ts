/**
 * Host seam for the WebMCP provider, following the `utils/upload.ts` shape: a module-level
 * default, `set`/`reset`/`get`, wired through `configurePlannotatorUI({ webmcp })`.
 */

export interface WebMcpPolicy {
  enabled?: boolean;
  namePrefix?: string;
}

export interface ResolvedWebMcpPolicy {
  enabled: boolean;
  namePrefix: string;
}

export const DEFAULT_WEBMCP_NAME_PREFIX = 'plannotator.';

const defaultPolicy: ResolvedWebMcpPolicy = {
  enabled: true,
  namePrefix: DEFAULT_WEBMCP_NAME_PREFIX,
};

let policy: ResolvedWebMcpPolicy = defaultPolicy;

export function setWebMcpPolicy(next: WebMcpPolicy): void {
  policy = {
    enabled: next.enabled ?? defaultPolicy.enabled,
    namePrefix: typeof next.namePrefix === 'string' ? next.namePrefix : defaultPolicy.namePrefix,
  };
}

export function resetWebMcpPolicy(): void {
  policy = defaultPolicy;
}

/** Read the active policy at call time (so a late override is honored). */
export function getWebMcpPolicy(): ResolvedWebMcpPolicy {
  return policy;
}
