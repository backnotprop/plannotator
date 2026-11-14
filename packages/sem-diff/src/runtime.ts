// How the engine finds its parsers and reads its debug switches, kept apart so the core
// runs the same in Node, a browser and a worker. Nothing here imports a Node module up front.
import type { LanguageId } from './parse.ts';

/** A grammar or runtime file: a path or URL to load, or its bytes. */
export type WasmSource = string | URL | Uint8Array;

export interface SemDiffSetup {
  /**
   * Where a language's grammar lives. `file` is its package path, e.g.
   * `tree-sitter-go/tree-sitter-go.wasm`. In a browser, return a URL the page can fetch.
   * Default (Node only): resolved from the installed packages.
   */
  locateGrammar?: (file: string, language: LanguageId) => WasmSource | Promise<WasmSource>;
  /** Where web-tree-sitter's own `web-tree-sitter.wasm` lives (default: next to its script). */
  locateRuntime?: (file: string) => string;
  /** Debug output on stderr: why candidates were rejected, the evidence per candidate. */
  debug?: { reasons?: boolean; features?: boolean };
  /** Let the learned check accept candidates the rules reject (off by default). */
  learned?: boolean;
  /**
   * A second opinion on extract/inline candidates the rules reject, e.g. a decision model's
   * answers looked up ahead of time (harness/compare/clef.py). Return true to accept. It must
   * answer at once: look answers up here, never fetch them.
   */
  secondOpinion?: (candidate: Candidate) => boolean;
  /** Skip the second opinion when the helper's code is still in the caller (default on). */
  secondOpinionCopyCheck?: boolean;
}

/** One extract/inline candidate, as a second opinion sees it. */
export interface Candidate {
  kind: 'extract' | 'inline';
  /** The file's name, as given to `semanticDiffFile` (filled in for per-diff second opinions). */
  file?: string;
  helper: string;
  caller: string;
  /** Source text. For an extract, `caller` is the new caller and `callerNew` the old one (extract is inline run backwards). */
  code: { helper: string; caller: string; callerNew: string };
}

let setup: SemDiffSetup = {};

/** Configure the engine once, before the first diff (later calls replace earlier ones). */
export function configure(s: SemDiffSetup): void {
  setup = { ...s };
}

export const currentSetup = (): SemDiffSetup => setup;

/** An environment switch, read only where `process` exists (Node); always off in a browser. */
function env(name: string): boolean {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return !!p?.env?.[name];
}

export const flags = {
  reasons: () => !!setup.debug?.reasons || env('SEMANTIC_DEBUG'),
  features: () => !!setup.debug?.features || env('SEMANTIC_FEATURES'),
  learned: () => !!setup.learned || env('SEMANTIC_LEARNED'),
};

// Rules that can be switched off to measure what each one adds (harness/score.ts). Not part
// of the public setup: the shipped engine never reads the environment to decide a result.
const rulesOff = new Set<string>();
export const rule = (name: string): boolean => !rulesOff.has(name);
export function switchRulesOff(names: Iterable<string>): void {
  rulesOff.clear();
  for (const n of names) rulesOff.add(n);
}

/** The default grammar lookup: Node's resolver, loaded only when needed and never bundled. */
export async function resolveInNode(file: string): Promise<string> {
  const name = 'node:module';
  const { createRequire } = (await import(/* @vite-ignore */ name)) as { createRequire(url: string): { resolve(id: string): string } };
  return createRequire(import.meta.url).resolve(file);
}
