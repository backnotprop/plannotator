import type { AskAIParams } from '@plannotator/ui/hooks/useAIChat';

export function askAIAnnotationParams(options: {
  sessionBridge: boolean;
  hasSession: boolean;
  feedbackExport: string | undefined;
  draftList: () => string;
}): Pick<AskAIParams, 'contextUpdate' | 'draftAnnotations'> {
  if (options.sessionBridge) return { draftAnnotations: options.draftList() };
  return { contextUpdate: options.hasSession ? options.feedbackExport : undefined };
}
