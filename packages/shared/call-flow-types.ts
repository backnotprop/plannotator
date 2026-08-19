/** Browser-safe contracts for Plannotator's optional CallDiff integration. */

import type { CallFlowLanguageId } from "./call-flow-languages";

export type CallFlowNodeStatus = "same" | "added" | "removed";
export type CallFlowNodeKind = "call" | "branch";

export interface CallFlowNode {
  key: string;
  label: string;
  status: CallFlowNodeStatus;
  kind?: CallFlowNodeKind;
  file?: string;
  line?: number;
  endLine?: number;
  children: CallFlowNode[];
}

interface CallFlowTreeBase {
  entry: string;
  tree: CallFlowNode;
}

interface CallFlowTreeWithRaw extends CallFlowTreeBase {
  /** Canonical colorless CallDiff rendering for this complete entry tree. */
  raw: string;
  /** One-based line where `raw` begins inside the response-level raw output. */
  rawLineStart: number;
}

interface CallFlowTreeWithoutRaw extends CallFlowTreeBase {
  /** Omitted when upstream's per-entry rendering cannot be aligned safely. */
  raw?: undefined;
  rawLineStart?: undefined;
}

/** One structured inferred entry tree, optionally aligned to canonical raw output. */
export type CallFlowTree = CallFlowTreeWithRaw | CallFlowTreeWithoutRaw;

export interface CallFlowFileImpact {
  entry: string;
  /** Every inferred entry path containing this same changed source node. */
  entries: string[];
  key: string;
  label: string;
  status: Exclude<CallFlowNodeStatus, "same">;
  kind?: CallFlowNodeKind;
  file: string;
  line?: number;
  endLine?: number;
  depth: number;
}

export interface CallFlowDiagnostic {
  level: "warning" | "error";
  message: string;
}

export interface CallFlowSummary {
  entries: number;
  changedNodes: number;
  added: number;
  removed: number;
  impactedFiles: number;
  warnings: number;
}

export type CallFlowCapabilityState =
  | "disabled"
  | "available"
  | "unavailable"
  | "unsupported";

export interface CallFlowAdvert {
  enabled: boolean;
  available: boolean;
  state: CallFlowCapabilityState;
  provider: "calldiff";
  version?: string;
  reason?: string;
  message?: string;
  /** True only when the managed install flow applies; its Node preflight can still require user action. */
  installable?: boolean;
  languages?: CallFlowLanguageAdvert[];
  /** Static current-review footprint shown at the disabled consent boundary; it never starts work. */
  consentPlan?: CallFlowInstallPlan;
  /** Exact missing targets the managed installer can install now. */
  installPlan?: CallFlowInstallPlan;
}

export interface CallFlowLanguageAdvert {
  id: CallFlowLanguageId;
  label: string;
  kind: "core" | "pack";
  installed: boolean;
  required: boolean;
  changedFiles: number;
  installSizeBytes: number;
}

export interface CallFlowInstallPlan {
  languageIds: CallFlowLanguageId[];
  labels: string[];
  changedFiles: number;
  installSizeBytes: number;
}

export interface CallFlowSkippedLanguage {
  id: CallFlowLanguageId;
  label: string;
  files: string[];
  installSizeBytes: number;
}

/** Coarse phases reported while the opt-in runtime install runs. */
export type CallFlowInstallStage = "downloading" | "verifying" | "installing-deps" | "building";

/**
 * Wire contract for POST /api/call-flow/install and
 * GET /api/call-flow/install-status. done identifies the completed target
 * set; error persists until the next install POST retries.
 */
export type CallFlowInstallStatus =
  | { state: "idle" }
  | { state: "running"; stage: CallFlowInstallStage; languageIds: CallFlowLanguageId[]; currentLanguageId?: CallFlowLanguageId }
  | { state: "done"; languageIds: CallFlowLanguageId[] }
  | { state: "error"; error: string; reason?: string; languageIds?: CallFlowLanguageId[]; currentLanguageId?: CallFlowLanguageId };

export type CallFlowResponse =
  | {
      status: "ok";
      snapshotId: string;
      provider: "calldiff";
      version: string;
      from: string;
      to: string;
      message?: string;
      /** Canonical colorless CallDiff rendering, including source locations. */
      raw: string;
      trees: CallFlowTree[];
      fileImpacts: Record<string, CallFlowFileImpact[]>;
      summary: CallFlowSummary;
      diagnostics: CallFlowDiagnostic[];
      skippedLanguages: CallFlowSkippedLanguage[];
    }
  | {
      status: "disabled" | "unsupported" | "unavailable" | "stale" | "error";
      reason: string;
      message: string;
    };

export interface ParsedCallDiffWorkerResult {
  version: string;
  from: string;
  to: string;
  message?: string;
  /** Canonical colorless CallDiff rendering, including source locations. */
  raw: string;
  trees: CallFlowTree[];
  diagnostics: CallFlowDiagnostic[];
}

const MAX_TREES = 100;
const MAX_NODES = 5_000;
const MAX_TREE_DEPTH = 32;
const MAX_DIAGNOSTICS = 100;
const MAX_TEXT_LENGTH = 2_000;
const MAX_RAW_LENGTH = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, field: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`CallDiff worker returned an invalid ${field}.`);
  }
  return value.slice(0, max);
}

function boundedRaw(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("CallDiff worker response is missing its raw diff.");
  }
  if (value.length > MAX_RAW_LENGTH) {
    throw new Error("CallDiff raw diff exceeded Plannotator's 1 MB limit.");
  }
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function boundedRelativeFile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/")
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split("/").some((segment) => segment === "..")
    || normalized.includes("\0")
  ) {
    throw new Error("CallDiff worker returned an unsafe source path.");
  }
  return normalized.slice(0, MAX_TEXT_LENGTH);
}

/** Parse and bound the untrusted JSON emitted by the isolated Node worker. */
export function parseCallDiffWorkerResult(value: unknown): ParsedCallDiffWorkerResult {
  if (!isRecord(value) || value.protocol !== 1 || value.ok !== true) {
    const message = isRecord(value) && typeof value.message === "string"
      ? value.message.slice(0, MAX_TEXT_LENGTH)
      : "CallDiff worker returned an invalid response.";
    throw new Error(message);
  }
  if (!isRecord(value.result) || !Array.isArray(value.result.trees)) {
    throw new Error("CallDiff worker response is missing its diff trees.");
  }
  if (value.result.trees.length > MAX_TREES) {
    throw new Error("CallDiff result exceeded Plannotator's tree limits.");
  }

  let nodeCount = 0;
  const parseNode = (candidate: unknown, depth: number): CallFlowNode => {
    if (!isRecord(candidate) || depth > MAX_TREE_DEPTH || ++nodeCount > MAX_NODES) {
      throw new Error("CallDiff result exceeded Plannotator's tree limits.");
    }
    const status = candidate.status;
    if (status !== "same" && status !== "added" && status !== "removed") {
      throw new Error("CallDiff worker returned an invalid node status.");
    }
    const kind = candidate.kind;
    if (kind !== undefined && kind !== "call" && kind !== "branch") {
      throw new Error("CallDiff worker returned an invalid node kind.");
    }
    if (!Array.isArray(candidate.children)) {
      throw new Error("CallDiff worker returned a node without children.");
    }
    const file = boundedRelativeFile(candidate.file);
    const line = optionalPositiveInteger(candidate.line);
    const endLine = optionalPositiveInteger(candidate.endLine);
    return {
      key: boundedString(candidate.key, "node key"),
      label: boundedString(candidate.label, "node label"),
      status,
      ...(kind && { kind }),
      ...(file && { file }),
      ...(line && { line }),
      ...(endLine && { endLine }),
      children: candidate.children.map((child) => parseNode(child, depth + 1)),
    };
  };

  const raw = boundedRaw(value.result.ascii);
  const trees = value.result.trees.map((candidate): CallFlowTree => {
    if (!isRecord(candidate)) throw new Error("CallDiff worker returned an invalid tree.");
    const entry = boundedString(candidate.entry, "tree entry");
    const tree = parseNode(candidate.tree, 0);
    const treeRaw = typeof candidate.ascii === "string"
      && candidate.ascii.length > 0
      && candidate.ascii.length <= MAX_RAW_LENGTH
        ? candidate.ascii
        : undefined;
    const rawOffset = treeRaw ? raw.indexOf(treeRaw) : -1;
    if (treeRaw === undefined || rawOffset === -1) return { entry, tree };
    let rawLineStart = 1;
    for (let index = 0; index < rawOffset; index += 1) {
      if (raw.charCodeAt(index) === 10) rawLineStart += 1;
    }
    return {
      entry,
      raw: treeRaw,
      rawLineStart,
      tree,
    };
  });

  const diagnostics: CallFlowDiagnostic[] = [];
  if (Array.isArray(value.diagnostics)) {
    for (const candidate of value.diagnostics.slice(0, MAX_DIAGNOSTICS)) {
      if (!isRecord(candidate) || typeof candidate.message !== "string") continue;
      diagnostics.push({
        level: candidate.level === "error" ? "error" : "warning",
        message: candidate.message.slice(0, MAX_TEXT_LENGTH),
      });
    }
  }

  return {
    version: boundedString(value.version, "version", 100),
    from: boundedString(value.result.from, "from snapshot"),
    to: boundedString(value.result.to, "to snapshot"),
    ...(typeof value.result.message === "string" && value.result.message.length > 0
      ? { message: value.result.message.slice(0, MAX_TEXT_LENGTH) }
      : {}),
    raw,
    trees,
    diagnostics,
  };
}

function treeContainsChangedNodeInFiles(node: CallFlowNode, files: ReadonlySet<string>): boolean {
  if (node.status !== "same" && node.file && files.has(node.file)) return true;
  return node.children.some((child) => treeContainsChangedNodeInFiles(child, files));
}

/**
 * Select complete inferred entry trees that contain a changed node in one of
 * the requested files. The trees are never pruned: the Lens shows the same
 * parent/child context as the Dock, filtered only at the entry-tree boundary.
 */
export function getCallFlowTreesForFiles(
  trees: readonly CallFlowTree[],
  filePaths: readonly string[],
): CallFlowTree[] {
  const files = new Set(filePaths.filter(Boolean));
  if (files.size === 0) return [];
  return trees.filter(({ tree }) => treeContainsChangedNodeInFiles(tree, files));
}

/** Flatten changed call sites once so the Dock and per-file Lens share counts. */
export function indexCallFlowImpacts(trees: readonly CallFlowTree[]): {
  fileImpacts: Record<string, CallFlowFileImpact[]>;
  summary: CallFlowSummary;
} {
  const fileImpacts: Record<string, CallFlowFileImpact[]> = {};
  const uniqueChangedNodes = new Set<string>();
  const impactByLocation = new Map<string, CallFlowFileImpact>();
  let added = 0;
  let removed = 0;

  const visit = (entry: string, node: CallFlowNode, depth: number): void => {
    if (node.status !== "same") {
      const identity = [node.status, node.file ?? "", node.line ?? 0, node.endLine ?? 0, node.key, node.label].join("\0");
      if (!uniqueChangedNodes.has(identity)) {
        uniqueChangedNodes.add(identity);
        if (node.status === "added") added += 1;
        else removed += 1;
      }
      if (node.file) {
        const existing = impactByLocation.get(identity);
        if (existing) {
          if (!existing.entries.includes(entry)) existing.entries.push(entry);
        } else {
          const impact: CallFlowFileImpact = {
            entry,
            entries: [entry],
            key: node.key,
            label: node.label,
            status: node.status,
            ...(node.kind && { kind: node.kind }),
            file: node.file,
            ...(node.line && { line: node.line }),
            ...(node.endLine && { endLine: node.endLine }),
            depth,
          };
          (fileImpacts[node.file] ??= []).push(impact);
          impactByLocation.set(identity, impact);
        }
      }
    }
    for (const child of node.children) visit(entry, child, depth + 1);
  };

  for (const tree of trees) visit(tree.entry, tree.tree, 0);
  return {
    fileImpacts,
    summary: {
      entries: trees.length,
      changedNodes: added + removed,
      added,
      removed,
      impactedFiles: Object.keys(fileImpacts).length,
      warnings: 0,
    },
  };
}
