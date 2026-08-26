import { useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import type { PRDiffScope, PRStackNode, PRStackTree } from '@plannotator/shared/pr-stack';
import { storage } from '@plannotator/ui/utils/storage';
import { isVSCodeWebview } from '../utils/runtimeSurface';

const APPROVE_AND_NEXT_TOAST_SEEN_KEY = 'plannotator-approve-next-toast-seen';

function findNextOpenStackNode(stackTree: PRStackTree | null, metadata: PRMetadata | null): PRStackNode | null {
  if (!stackTree || !metadata) return null;

  const currentIndex = stackTree.nodes.findIndex(node => node.isCurrent || node.url === metadata.url);
  if (currentIndex < 0) return null;

  return stackTree.nodes
    .slice(currentIndex + 1)
    .find(node => !node.isDefaultBranch && node.state === 'open' && !!node.url) ?? null;
}

interface UseApproveAndNextAffordanceOptions {
  isApproving: boolean;
  isPlatformActioning: boolean;
  isSendingFeedback: boolean;
  mrLabel: string;
  platformMode: boolean;
  platformUser: string | null;
  prDiffScope: PRDiffScope;
  prMetadata: PRMetadata | null;
  prStackTree: PRStackTree | null;
}

export function useApproveAndNextAffordance({
  isApproving,
  isPlatformActioning,
  isSendingFeedback,
  mrLabel,
  platformMode,
  platformUser,
  prDiffScope,
  prMetadata,
  prStackTree,
}: UseApproveAndNextAffordanceOptions) {
  const toastShown = useRef(false);
  const nextOpenStackNode = useMemo(
    () => findNextOpenStackNode(prStackTree, prMetadata),
    [prStackTree, prMetadata],
  );
  const vscodeWebview = isVSCodeWebview();
  const isOwnPlatformPR = !!platformUser && prMetadata?.author === platformUser;
  const showApproveAndNext = platformMode && prDiffScope === 'layer' && !!nextOpenStackNode && !isOwnPlatformPR && !vscodeWebview;
  const platformApproveDisabled = isSendingFeedback || isApproving || isPlatformActioning || isOwnPlatformPR;
  const platformApproveMuted = isOwnPlatformPR && !isSendingFeedback && !isApproving && !isPlatformActioning;
  const platformApproveTitle = isOwnPlatformPR
    ? `You can't approve your own ${mrLabel}`
    : 'Approve - no changes needed';
  const nextApproveLabel = nextOpenStackNode?.number != null
    ? `${mrLabel} #${nextOpenStackNode.number}`
    : nextOpenStackNode?.branch ?? `next ${mrLabel}`;
  const platformApproveGroupClass = showApproveAndNext
    ? 'inline-flex items-stretch [&>button:first-child]:rounded-r-none'
    : 'inline-flex items-stretch';

  useEffect(() => {
    if (!showApproveAndNext || toastShown.current) return;
    if (storage.getItem(APPROVE_AND_NEXT_TOAST_SEEN_KEY) === 'true') return;

    toastShown.current = true;
    storage.setItem(APPROVE_AND_NEXT_TOAST_SEEN_KEY, 'true');
    toast('Stacked PR shortcut available', {
      description: 'Use the arrow beside Approve to approve this PR and continue to the next open PR in the stack.',
      duration: 7000,
      position: 'top-right',
      classNames: { toast: '!w-auto', description: '!text-foreground/70' },
    });
  }, [showApproveAndNext]);

  return {
    isOwnPlatformPR,
    nextApproveLabel,
    nextOpenStackNode,
    platformApproveDisabled,
    platformApproveGroupClass,
    platformApproveMuted,
    platformApproveTitle,
    showApproveAndNext,
  };
}
