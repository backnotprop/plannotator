import React from 'react';
import { Annotation, AnnotationType, Block } from '../types';

interface SidebarProps {
  annotations: Annotation[];
  blocks: Block[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  selectedId: string | null;
}

export const AnnotationSidebar: React.FC<SidebarProps> = ({
  annotations,
  blocks,
  onSelect,
  onDelete,
  selectedId
}) => {
  const sortedAnnotations = [...annotations].sort((a, b) => {
    const blockA = blocks.findIndex(blk => blk.id === a.blockId);
    const blockB = blocks.findIndex(blk => blk.id === b.blockId);
    if (blockA !== blockB) return blockA - blockB;
    return a.startOffset - b.startOffset;
  });

  return (
    <div className="w-[min(22rem,32vw)] min-w-[16rem] border-l border-border/50 bg-card/50 backdrop-blur-sm h-full flex flex-col transition-colors">
      <div className="p-4 border-b border-border/50 flex items-center justify-between">
        <h2 className="font-semibold text-foreground">Review Changes</h2>
        <span className="text-xs bg-muted text-muted-foreground px-2 py-1 rounded-full">
          {annotations.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {sortedAnnotations.length === 0 ? (
          <div className="text-center text-muted-foreground mt-10 text-sm">
            <p>No annotations yet.</p>
            <p className="mt-2 text-xs">Select text in the document to add comments or suggest changes.</p>
          </div>
        ) : (
          sortedAnnotations.map(ann => (
            <div
              key={ann.id}
              onClick={() => onSelect(ann.id)}
              className={`
                group relative p-3 rounded-lg border transition-all cursor-pointer
                ${selectedId === ann.id
                  ? 'bg-accent/20 border-accent shadow-sm'
                  : 'bg-card border-border hover:border-accent hover:shadow-sm'
                }
              `}
            >
              <div className="flex justify-between items-start mb-1">
                <span className={`
                  text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded
                  ${ann.type === AnnotationType.DELETION ? 'bg-destructive/20 text-destructive' :
                    ann.type === AnnotationType.INSERTION ? 'bg-secondary/20 text-secondary' :
                    ann.type === AnnotationType.REPLACEMENT ? 'bg-primary/20 text-primary' :
                    'bg-accent/20 text-accent'}
                `}>
                  {ann.type}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(ann.id); }}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all p-1 rounded hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Remove Annotation"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>

              <div className="text-sm text-muted-foreground mb-2 font-mono bg-muted p-2 rounded-lg text-xs truncate">
                "{ann.originalText}"
              </div>

              {(ann.text && ann.type !== AnnotationType.DELETION) && (
                <div className="text-sm text-foreground font-medium pl-3 border-l-2 border-primary">
                  {ann.type === AnnotationType.REPLACEMENT ? '→ ' : ''}{ann.text}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
