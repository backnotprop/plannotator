import React, { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { getPlatformLabel } from '@plannotator/shared/pr-provider';
import { buildMinimalStackTree } from '@plannotator/shared/pr-stack';
import type { PRMetadata } from '@plannotator/shared/pr-provider';
import type { PRDiffScope, PRDiffScopeOption, PRStackInfo, PRStackTree, PRStackNode } from '@plannotator/shared/pr-stack';

interface StackedPRLabelProps {
  metadata: PRMetadata;
  mrNumberLabel: string;
  stackInfo: PRStackInfo | null;
  stackTree: PRStackTree | null;
  scope: PRDiffScope;
  scopeOptions: PRDiffScopeOption[];
  isSwitchingScope: boolean;
  onSelectScope: (scope: PRDiffScope) => void;
  onNavigatePR?: (url: string) => void;
}

function nodeLabel(node: PRStackNode): string {
  if (node.isDefaultBranch) return node.branch;
  if (node.number != null && node.title) return `#${node.number} ${node.title}`;
  if (node.number != null) return `#${node.number}`;
  return node.branch;
}

function shortNodeLabel(node: PRStackNode): string {
  if (node.isDefaultBranch) return node.branch;
  if (node.number != null) return `#${node.number}`;
  return node.branch;
}

type NodeAction =
  | { kind: 'full-stack' }
  | { kind: 'current' }
  | { kind: 'navigate'; url: string };

function classifyNode(
  node: PRStackNode,
): NodeAction {
  if (node.isCurrent) return { kind: 'current' };
  if (node.isDefaultBranch) return { kind: 'full-stack' };
  return { kind: 'navigate', url: node.url ?? '' };
}

export function StackedPRLabel({
  metadata,
  mrNumberLabel,
  stackInfo,
  stackTree,
  scope,
  scopeOptions,
  isSwitchingScope,
  onSelectScope,
  onNavigatePR,
}: StackedPRLabelProps) {
  const [open, setOpen] = useState(false);

  const hasStack = !!(stackInfo || (stackTree && stackTree.nodes.filter(n => !n.isDefaultBranch).length > 1));

  if (!hasStack) return null;

  const tree = stackTree ?? (stackInfo ? buildMinimalStackTree(metadata, stackInfo) : { nodes: [] });
  const prNodes = tree.nodes.filter(n => !n.isDefaultBranch);
  const currentIndex = tree.nodes.findIndex(n => n.isCurrent);
  const parentNode = currentIndex > 0 ? tree.nodes[currentIndex - 1] : null;
  const rootNode = tree.nodes[0];

  const layerTarget = parentNode ? shortNodeLabel(parentNode) : (stackInfo?.baseBranch ?? 'base');
  const fullStackTarget = rootNode?.isDefaultBranch ? rootNode.branch : (stackInfo?.defaultBranch ?? 'main');
  const scopeTarget = scope === 'full-stack' ? fullStackTarget : layerTarget;
  const hasScopeOptions = scopeOptions.length > 0;

  const layerOption = scopeOptions.find(o => o.id === 'layer');
  const fullStackOption = scopeOptions.find(o => o.id === 'full-stack');

  function handleSelect(nextScope: PRDiffScope) {
    if (nextScope === scope) {
      setOpen(false);
      return;
    }
    onSelectScope(nextScope);
    setOpen(false);
  }

  function isNodeDisabled(node: PRStackNode): boolean {
    const action = classifyNode(node);
    if (action.kind === 'current') return true;
    if (action.kind === 'full-stack') return !(fullStackOption?.enabled) || isSwitchingScope;
    if (action.kind === 'navigate') return !action.url || isSwitchingScope || !onNavigatePR;
    return false;
  }

  function nodeTooltip(node: PRStackNode): string | undefined {
    const action = classifyNode(node);
    switch (action.kind) {
      case 'current': return undefined;
      case 'full-stack':
        return fullStackOption?.enabled
          ? 'Switch to full-stack diff'
          : 'Full-stack diff requires local checkout';
      case 'navigate': return action.url ? `Review ${shortNodeLabel(node)}` : undefined;
    }
  }

  function handleNodeClick(node: PRStackNode) {
    const action = classifyNode(node);
    switch (action.kind) {
      case 'current':
        setOpen(false);
        return;
      case 'full-stack':
        handleSelect('full-stack');
        return;
      case 'navigate':
        if (action.url && onNavigatePR) {
          onNavigatePR(action.url);
          setOpen(false);
        }
        return;
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={isSwitchingScope}
          title={`Stack: comparing vs ${scopeTarget}`}
          className="text-[10px] text-accent/70 hover:text-accent inline-flex items-center gap-1 whitespace-nowrap transition-colors rounded px-1.5 py-0.5 hover:bg-muted/20 disabled:opacity-60 disabled:cursor-wait"
        >
          <svg className="w-[18px] h-[18px] flex-shrink-0" viewBox="0 0 500 400" fill="none" stroke="currentColor" strokeWidth={28} strokeLinejoin="round" strokeLinecap="round">
            <polygon points="250,30 470,160 250,290 30,160" />
            <polyline points="30,220 250,350 470,220" />
            <polyline points="30,280 250,410 470,280" />
          </svg>
          <span>vs {scopeTarget}</span>
          <svg
            className={`w-2.5 h-2.5 flex-shrink-0 opacity-40 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="z-50 w-80 bg-popover text-popover-foreground border border-border rounded shadow-lg overflow-hidden origin-[var(--radix-popover-content-transform-origin)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        >
          {/* Section 1: Stack Tree */}
          <div className="px-3 pt-3 pb-2">
            <div className="text-[11px] font-medium text-muted-foreground mb-2">
              Stack ({prNodes.length} {prNodes.length === 1 ? 'PR' : 'PRs'})
            </div>
            <div>
              {tree.nodes.map((node, i) => {
                const depth = node.isDefaultBranch ? 0 : i;
                const isLast = i === tree.nodes.length - 1;
                const disabled = isNodeDisabled(node);
                const action = classifyNode(node);
                const tooltip = nodeTooltip(node);

                return (
                  <div
                    key={node.branch}
                    className="flex items-start"
                    style={{ paddingLeft: `${Math.max(0, depth - 1) * 14}px` }}
                  >
                    <div className="flex items-center flex-shrink-0 mt-[5px]">
                      {depth > 0 && (
                        <span className="text-[10px] text-border/70 font-mono leading-none mr-0.5">
                          {isLast ? '└─' : '├─'}
                        </span>
                      )}
                      <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        node.isCurrent ? 'bg-accent' : node.isDefaultBranch ? 'bg-muted-foreground/30' : 'bg-muted-foreground/40'
                      }`} />
                    </div>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handleNodeClick(node)}
                      title={tooltip}
                      className={`flex items-center gap-1.5 min-w-0 text-xs leading-6 ml-1.5 rounded px-1 -mx-0.5 transition-colors ${
                        node.isCurrent
                          ? 'text-accent font-medium cursor-default'
                          : disabled
                            ? 'text-muted-foreground/40 cursor-not-allowed'
                            : action.kind === 'navigate'
                              ? 'text-muted-foreground hover:text-foreground hover:bg-muted/30 cursor-pointer'
                              : 'text-muted-foreground hover:text-accent hover:bg-muted/30 cursor-pointer'
                      }`}
                    >
                      <span className="truncate">{nodeLabel(node)}</span>
                      {node.isCurrent && (
                        <span className="text-[9px] text-accent/60 whitespace-nowrap">reviewing</span>
                      )}
                      {action.kind === 'navigate' && node.url && !disabled && (
                        <svg className="w-2.5 h-2.5 flex-shrink-0 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {hasScopeOptions && (
            <>
          <div className="border-t border-border/50" />

          {/* Section 2: Scope Selector */}
          <div className="px-3 py-2">
            <div className="text-[11px] font-medium text-muted-foreground mb-1.5">
              Comparing against
            </div>
            {layerOption && (
              <button
                type="button"
                disabled={!layerOption.enabled || isSwitchingScope}
                onClick={() => handleSelect('layer')}
                className={`w-full flex items-start gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                  scope === 'layer'
                    ? 'bg-muted text-foreground'
                    : layerOption.enabled
                      ? 'text-foreground/80 hover:bg-muted/70'
                      : 'text-muted-foreground/40 cursor-not-allowed'
                }`}
              >
                <span className="mt-0.5 w-3 flex-shrink-0 text-xs">
                  {scope === 'layer' ? '◉' : '○'}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium truncate">
                    {parentNode ? nodeLabel(parentNode) : (stackInfo?.baseBranch ?? 'base')}
                  </span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    Only changes in this PR
                  </span>
                </span>
              </button>
            )}
            {fullStackOption && (
              <button
                type="button"
                disabled={!fullStackOption.enabled || isSwitchingScope}
                onClick={() => handleSelect('full-stack')}
                title={!fullStackOption.enabled ? 'Requires local checkout' : undefined}
                className={`w-full flex items-start gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                  scope === 'full-stack'
                    ? 'bg-muted text-foreground'
                    : fullStackOption.enabled
                      ? 'text-foreground/80 hover:bg-muted/70'
                      : 'text-muted-foreground/40 cursor-not-allowed'
                }`}
              >
                <span className="mt-0.5 w-3 flex-shrink-0 text-xs">
                  {scope === 'full-stack' ? '◉' : '○'}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{fullStackTarget}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    All changes from {fullStackTarget} to here
                  </span>
                </span>
              </button>
            )}
          </div>
            </>
          )}

          <div className="border-t border-border/50" />

          {/* Section 3: PR Link */}
          <div className="px-3 py-2">
            <a
              href={metadata.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
            >
              View {mrNumberLabel} on {getPlatformLabel(metadata)}
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
            </a>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
