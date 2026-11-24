import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { Annotation, Block } from '@plannotator/ui/types';
import type { SelectionActionContext } from '@plannotator/ui/utils/selectionActions';
import type { AttachmentView } from '../api';
import { useDiagramQuestionRoutes } from './DiagramThreadScope';
import { useSideButton } from './sideButton';
import { diagramFileAsk, fileSideSource } from './sideSource';

export function useFileQuestions(attachment: InboxAttachmentState, version: 'current' | 'sent', view: AttachmentView | null,
  blocks: readonly Block[], annotations: readonly Annotation[], onSide?: (words: string, source?: string) => void) {
  const { reply } = useDiagramQuestionRoutes(attachment.message_id);
  const sideButton = useSideButton();
  const sideFrom = onSide && ((selected: string, context: SelectionActionContext) =>
    onSide(selected, fileSideSource(attachment, version, { selected, blockId: context.blockId, blocks, annotations })));
  return { sideButton, sideFrom, diagramQuestion: view ? diagramFileAsk(view, onSide, reply) : undefined };
}
