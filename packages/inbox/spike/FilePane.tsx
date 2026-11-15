/**
 * A file as a pane of its own: the thread pane's own viewer (AttachmentPane), read only, over the thread's files.
 * Comments, versions and full screen stay with the thread pane (the viewer is drawn inside ThreadPane today).
 */
import { useEffect, useState } from 'react';
import { AttachmentPane } from '../components/AttachmentPane';
import { useThreadRead } from './ReadOnlyThread';
import { agentName } from '../format';

export function FilePane({ threadId, attachmentId, onOpenFile, onName }: { threadId: string; attachmentId: string; onOpenFile: (threadId: string, attachmentId: string) => void; onName: (name: string) => void }) {
  const { thread, files } = useThreadRead(threadId);
  const [version, setVersion] = useState<'current' | 'sent'>('current');
  const attachment = files.find((a) => a.id === attachmentId) ?? null;
  const name = attachment?.name ?? null;
  useEffect(() => {
    if (name) onName(name);
  }, [name, onName]);
  if (!thread || !attachment) return <div className="spk-file spk-note">{thread ? 'This file is not in the thread.' : 'Opening…'}</div>;
  const asker = thread.messages.find((m) => m.author.kind === 'agent')?.author;
  return (
    <div className="spk-file" data-spike-file={attachmentId}>
      <AttachmentPane
        attachment={attachment}
        attachments={files}
        records={[]}
        agent={asker && asker.kind === 'agent' ? agentName(asker) : 'Agent'}
        projectName={thread.project.name}
        projectRoot={thread.project.root}
        repo={thread.project.repo ?? null}
        version={version}
        onVersion={setVersion}
        full={false}
        onToggleFull={() => {}}
        focusId={null}
        readOnly
        onSaved={() => {}}
        onRemoved={() => {}}
        onOpenAt={(id) => onOpenFile(threadId, id)}
        onClose={() => {}}
        strip={{ picks: 0, annotations: 0, onWriteReply: () => {} }}
      />
    </div>
  );
}
