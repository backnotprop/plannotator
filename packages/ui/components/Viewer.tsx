import React, { useRef, useState, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Highlighter from 'web-highlighter';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { Block, Annotation, AnnotationType, EditorMode } from '../types';
import { Toolbar } from './Toolbar';
import { TaterSpriteSitting } from './TaterSpriteSitting';
import { AttachmentsButton } from './AttachmentsButton';
import { getIdentity } from '../utils/identity';

interface ViewerProps {
  blocks: Block[];
  markdown: string;
  annotations: Annotation[];
  onAddAnnotation: (ann: Annotation) => void;
  onSelectAnnotation: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  taterMode: boolean;
  globalAttachments?: string[];
  onAddGlobalAttachment?: (path: string) => void;
  onRemoveGlobalAttachment?: (path: string) => void;
}

export interface ViewerHandle {
  removeHighlight: (id: string) => void;
  clearAllHighlights: () => void;
  applySharedAnnotations: (annotations: Annotation[]) => void;
}

export const Viewer = forwardRef<ViewerHandle, ViewerProps>(({
  blocks,
  markdown,
  annotations,
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  mode,
  taterMode,
  globalAttachments = [],
  onAddGlobalAttachment,
  onRemoveGlobalAttachment,
}, ref) => {
  const [copied, setCopied] = useState(false);
  const [showGlobalCommentInput, setShowGlobalCommentInput] = useState(false);
  const [globalCommentValue, setGlobalCommentValue] = useState('');
  const globalCommentInputRef = useRef<HTMLInputElement>(null);

  const handleCopyPlan = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  const handleAddGlobalComment = () => {
    if (!globalCommentValue.trim()) return;

    const newAnnotation: Annotation = {
      id: `global-${Date.now()}`,
      blockId: '',
      startOffset: 0,
      endOffset: 0,
      type: AnnotationType.GLOBAL_COMMENT,
      text: globalCommentValue.trim(),
      originalText: '',
      createdA: Date.now(),
      author: getIdentity(),
    };

    onAddAnnotation(newAnnotation);
    setGlobalCommentValue('');
    setShowGlobalCommentInput(false);
  };

  useEffect(() => {
    if (showGlobalCommentInput) {
      globalCommentInputRef.current?.focus();
    }
  }, [showGlobalCommentInput]);
  const containerRef = useRef<HTMLDivElement>(null);
  const highlighterRef = useRef<Highlighter | null>(null);
  const modeRef = useRef<EditorMode>(mode);
  const onAddAnnotationRef = useRef(onAddAnnotation);
  const pendingSourceRef = useRef<any>(null);
  const [toolbarState, setToolbarState] = useState<{ element: HTMLElement; source: any } | null>(null);
  const [hoveredCodeBlock, setHoveredCodeBlock] = useState<{ block: Block; element: HTMLElement } | null>(null);
  const [isCodeBlockToolbarExiting, setIsCodeBlockToolbarExiting] = useState(false);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Keep refs in sync with props
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    onAddAnnotationRef.current = onAddAnnotation;
  }, [onAddAnnotation]);

  // Helper to create annotation from highlighter source
  const createAnnotationFromSource = (
    highlighter: Highlighter,
    source: any,
    type: AnnotationType,
    text?: string,
    imagePaths?: string[]
  ) => {
    const doms = highlighter.getDoms(source.id);
    let blockId = '';
    let startOffset = 0;

    if (doms?.length > 0) {
      const el = doms[0] as HTMLElement;
      let parent = el.parentElement;
      while (parent && !parent.dataset.blockId) {
        parent = parent.parentElement;
      }
      if (parent?.dataset.blockId) {
        blockId = parent.dataset.blockId;
        const blockText = parent.textContent || '';
        const beforeText = blockText.split(source.text)[0];
        startOffset = beforeText?.length || 0;
      }
    }

    const newAnnotation: Annotation = {
      id: source.id,
      blockId,
      startOffset,
      endOffset: startOffset + source.text.length,
      type,
      text,
      originalText: source.text,
      createdA: Date.now(),
      author: getIdentity(),
      startMeta: source.startMeta,
      endMeta: source.endMeta,
      imagePaths,
    };

    if (type === AnnotationType.DELETION) {
      highlighter.addClass('deletion', source.id);
    } else if (type === AnnotationType.COMMENT) {
      highlighter.addClass('comment', source.id);
    }

    onAddAnnotationRef.current(newAnnotation);
  };

  // Helper to find text in DOM and create a range
  const findTextInDOM = useCallback((searchText: string): Range | null => {
    if (!containerRef.current) return null;

    const walker = document.createTreeWalker(
      containerRef.current,
      NodeFilter.SHOW_TEXT,
      null
    );

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent || '';
      const index = text.indexOf(searchText);
      if (index !== -1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + searchText.length);
        return range;
      }
    }

    // Try across multiple text nodes for multi-line content
    const fullText = containerRef.current.textContent || '';
    const searchIndex = fullText.indexOf(searchText);
    if (searchIndex === -1) return null;

    // Use Selection API to find and select the text
    const selection = window.getSelection();
    if (!selection) return null;

    // Reset walker
    const walker2 = document.createTreeWalker(
      containerRef.current,
      NodeFilter.SHOW_TEXT,
      null
    );

    let charCount = 0;
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;

    while ((node = walker2.nextNode() as Text | null)) {
      const nodeLength = node.textContent?.length || 0;

      if (!startNode && charCount + nodeLength > searchIndex) {
        startNode = node;
        startOffset = searchIndex - charCount;
      }

      if (startNode && charCount + nodeLength >= searchIndex + searchText.length) {
        endNode = node;
        endOffset = searchIndex + searchText.length - charCount;
        break;
      }

      charCount += nodeLength;
    }

    if (startNode && endNode) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    }

    return null;
  }, []);

  useImperativeHandle(ref, () => ({
    removeHighlight: (id: string) => {
      // Try highlighter first (for regular text selections)
      highlighterRef.current?.remove(id);

      // Handle manually created highlights (may be multiple marks with same ID)
      const manualHighlights = containerRef.current?.querySelectorAll(`[data-bind-id="${id}"]`);
      manualHighlights?.forEach(el => {
        const parent = el.parentNode;
        while (el.firstChild) {
          parent?.insertBefore(el.firstChild, el);
        }
        el.remove();
      });
    },

    clearAllHighlights: () => {
      // Clear all manual highlights (shared annotations and code blocks)
      const manualHighlights = containerRef.current?.querySelectorAll('[data-bind-id]');
      manualHighlights?.forEach(el => {
        const parent = el.parentNode;
        while (el.firstChild) {
          parent?.insertBefore(el.firstChild, el);
        }
        el.remove();
      });

      // Clear web-highlighter highlights
      const webHighlights = containerRef.current?.querySelectorAll('.annotation-highlight');
      webHighlights?.forEach(el => {
        const parent = el.parentNode;
        while (el.firstChild) {
          parent?.insertBefore(el.firstChild, el);
        }
        el.remove();
      });
    },

    applySharedAnnotations: (sharedAnnotations: Annotation[]) => {
      const highlighter = highlighterRef.current;
      if (!highlighter || !containerRef.current) return;

      sharedAnnotations.forEach(ann => {
        // Skip if already highlighted
        const existingDoms = highlighter.getDoms(ann.id);
        if (existingDoms && existingDoms.length > 0) return;

        // Also skip if manually highlighted
        const existingManual = containerRef.current?.querySelector(`[data-bind-id="${ann.id}"]`);
        if (existingManual) return;

        // Find the text in the DOM
        const range = findTextInDOM(ann.originalText);
        if (!range) {
          console.warn(`Could not find text for annotation ${ann.id}: "${ann.originalText.slice(0, 50)}..."`);
          return;
        }

        try {
          // Multi-mark approach: wrap each text node portion separately
          // This avoids destructive extractContents() that breaks DOM structure
          const textNodes: { node: Text; start: number; end: number }[] = [];

          // Collect all text nodes within the range
          const walker = document.createTreeWalker(
            range.commonAncestorContainer.nodeType === Node.TEXT_NODE
              ? range.commonAncestorContainer.parentNode!
              : range.commonAncestorContainer,
            NodeFilter.SHOW_TEXT,
            null
          );

          let node: Text | null;
          let inRange = false;

          while ((node = walker.nextNode() as Text | null)) {
            // Check if this node is the start container
            if (node === range.startContainer) {
              inRange = true;
              const start = range.startOffset;
              const end = node === range.endContainer ? range.endOffset : node.length;
              if (end > start) {
                textNodes.push({ node, start, end });
              }
              if (node === range.endContainer) break;
              continue;
            }

            // Check if this node is the end container
            if (node === range.endContainer) {
              if (inRange) {
                const end = range.endOffset;
                if (end > 0) {
                  textNodes.push({ node, start: 0, end });
                }
              }
              break;
            }

            // Node is fully within range
            if (inRange && node.length > 0) {
              textNodes.push({ node, start: 0, end: node.length });
            }
          }

          // If we only have one text node and it's fully contained, use simple approach
          if (textNodes.length === 0) {
            console.warn(`No text nodes found for annotation ${ann.id}`);
            return;
          }

          // Wrap each text node portion with its own mark (process in reverse to avoid offset issues)
          textNodes.reverse().forEach(({ node, start, end }) => {
            try {
              const nodeRange = document.createRange();
              nodeRange.setStart(node, start);
              nodeRange.setEnd(node, end);

              const mark = document.createElement('mark');
              mark.className = 'annotation-highlight';
              mark.dataset.bindId = ann.id;

              if (ann.type === AnnotationType.DELETION) {
                mark.classList.add('deletion');
              } else if (ann.type === AnnotationType.COMMENT) {
                mark.classList.add('comment');
              }

              // surroundContents works reliably for single text node ranges
              nodeRange.surroundContents(mark);

              // Make it clickable
              mark.addEventListener('click', () => {
                onSelectAnnotation(ann.id);
              });
            } catch (e) {
              console.warn(`Failed to wrap text node for annotation ${ann.id}:`, e);
            }
          });
        } catch (e) {
          console.warn(`Failed to apply highlight for annotation ${ann.id}:`, e);
        }
      });
    }
  }), [findTextInDOM, onSelectAnnotation]);

  useEffect(() => {
    if (!containerRef.current) return;

    const highlighter = new Highlighter({
      $root: containerRef.current,
      exceptSelectors: ['.annotation-toolbar', 'button'],
      wrapTag: 'mark',
      style: { className: 'annotation-highlight' }
    });

    highlighterRef.current = highlighter;

    highlighter.on(Highlighter.event.CREATE, ({ sources }: { sources: any[] }) => {
      if (sources.length > 0) {
        const source = sources[0];
        const doms = highlighter.getDoms(source.id);
        if (doms?.length > 0) {
          // Clean up previous pending highlight if exists
          if (pendingSourceRef.current) {
            highlighter.remove(pendingSourceRef.current.id);
            pendingSourceRef.current = null;
          }

          if (modeRef.current === 'redline') {
            // Auto-delete in redline mode
            createAnnotationFromSource(highlighter, source, AnnotationType.DELETION);
            window.getSelection()?.removeAllRanges();
          } else {
            // Show toolbar in selection mode
            pendingSourceRef.current = source;
            setToolbarState({ element: doms[0] as HTMLElement, source });
          }
        }
      }
    });

    highlighter.on(Highlighter.event.CLICK, ({ id }: { id: string }) => {
      onSelectAnnotation(id);
    });

    highlighter.run();

    return () => highlighter.dispose();
  }, [onSelectAnnotation]);


  useEffect(() => {
    const highlighter = highlighterRef.current;
    if (!highlighter) return;

    annotations.forEach(ann => {
      try {
        const doms = highlighter.getDoms(ann.id);
        if (doms?.length > 0) {
          if (ann.type === AnnotationType.DELETION) {
            highlighter.addClass('deletion', ann.id);
          } else if (ann.type === AnnotationType.COMMENT) {
            highlighter.addClass('comment', ann.id);
          }
        }
      } catch (e) {}
    });
  }, [annotations]);

  const handleAnnotate = (type: AnnotationType, text?: string, imagePaths?: string[]) => {
    const highlighter = highlighterRef.current;
    if (!toolbarState || !highlighter) return;

    createAnnotationFromSource(highlighter, toolbarState.source, type, text, imagePaths);
    pendingSourceRef.current = null;
    setToolbarState(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleToolbarClose = () => {
    if (toolbarState && highlighterRef.current) {
      highlighterRef.current.remove(toolbarState.source.id);
    }
    pendingSourceRef.current = null;
    setToolbarState(null);
    window.getSelection()?.removeAllRanges();
  };

  const handleCodeBlockAnnotate = (type: AnnotationType, text?: string) => {
    const highlighter = highlighterRef.current;
    if (!hoveredCodeBlock || !highlighter) return;

    // Find the code element inside the pre
    const codeEl = hoveredCodeBlock.element.querySelector('code');
    if (!codeEl) return;

    // Create a range that selects all content in the code block
    const range = document.createRange();
    range.selectNodeContents(codeEl);

    // Set the browser selection to this range
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // Use highlighter.fromRange which triggers CREATE event internally
    // We need to handle this synchronously, so we'll create the annotation directly
    const id = `codeblock-${Date.now()}`;
    const codeText = codeEl.textContent || '';

    // Wrap the content manually
    const wrapper = document.createElement('mark');
    wrapper.className = 'annotation-highlight';
    wrapper.dataset.bindId = id;

    // Extract and wrap content
    range.surroundContents(wrapper);

    // Add the appropriate class
    if (type === AnnotationType.DELETION) {
      wrapper.classList.add('deletion');
    } else if (type === AnnotationType.COMMENT) {
      wrapper.classList.add('comment');
    }

    // Create the annotation
    const newAnnotation: Annotation = {
      id,
      blockId: hoveredCodeBlock.block.id,
      startOffset: 0,
      endOffset: codeText.length,
      type,
      text,
      originalText: codeText,
      createdA: Date.now(),
      author: getIdentity(),
    };

    onAddAnnotationRef.current(newAnnotation);

    // Clear selection
    selection?.removeAllRanges();
    setHoveredCodeBlock(null);
  };

  const handleCodeBlockToolbarClose = () => {
    setHoveredCodeBlock(null);
  };

  return (
    <div className="relative z-50 w-full max-w-3xl">
      {taterMode && <TaterSpriteSitting />}
      <article
        ref={containerRef}
        className="w-full max-w-3xl bg-card border border-border/50 rounded-xl shadow-xl p-5 md:p-10 lg:p-14 relative"
      >
        {/* Header buttons */}
        <div className="absolute top-3 right-3 md:top-5 md:right-5 flex items-center gap-2">
          {/* Attachments button */}
          {onAddGlobalAttachment && onRemoveGlobalAttachment && (
            <AttachmentsButton
              paths={globalAttachments}
              onAdd={onAddGlobalAttachment}
              onRemove={onRemoveGlobalAttachment}
              variant="toolbar"
            />
          )}

          {/* Global comment button/input */}
          {showGlobalCommentInput ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleAddGlobalComment();
              }}
              className="flex items-center gap-1.5 bg-muted/80 rounded-md p-1"
            >
              <input
                ref={globalCommentInputRef}
                type="text"
                className="bg-transparent border-none outline-none text-xs w-40 md:w-56 px-2 placeholder:text-muted-foreground"
                placeholder="Add a global comment..."
                value={globalCommentValue}
                onChange={(e) => setGlobalCommentValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setShowGlobalCommentInput(false);
                    setGlobalCommentValue('');
                  }
                }}
              />
              <button
                type="submit"
                disabled={!globalCommentValue.trim()}
                className="px-2 py-1 text-xs font-medium rounded bg-purple-600 text-white hover:bg-purple-500 disabled:opacity-50 transition-all"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowGlobalCommentInput(false);
                  setGlobalCommentValue('');
                }}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </form>
          ) : (
            <button
              onClick={() => setShowGlobalCommentInput(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-md transition-colors"
              title="Add global comment"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
              <span className="hidden md:inline">Global comment</span>
            </button>
          )}

          {/* Copy plan button */}
          <button
            onClick={handleCopyPlan}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-md transition-colors"
            title={copied ? 'Copied!' : 'Copy plan'}
          >
            {copied ? (
              <>
                <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                <span className="hidden md:inline">Copied!</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span className="hidden md:inline">Copy plan</span>
              </>
            )}
          </button>
        </div>
        {blocks.map(block => (
          block.type === 'code' ? (
            <CodeBlock
              key={block.id}
              block={block}
              onHover={(element) => {
                // Clear any pending leave timeout
                if (hoverTimeoutRef.current) {
                  clearTimeout(hoverTimeoutRef.current);
                  hoverTimeoutRef.current = null;
                }
                // Cancel exit animation if re-entering
                setIsCodeBlockToolbarExiting(false);
                // Only show hover toolbar if no selection toolbar is active
                if (!toolbarState) {
                  setHoveredCodeBlock({ block, element });
                }
              }}
              onLeave={() => {
                // Delay then start exit animation
                hoverTimeoutRef.current = setTimeout(() => {
                  setIsCodeBlockToolbarExiting(true);
                  // After exit animation, unmount
                  setTimeout(() => {
                    setHoveredCodeBlock(null);
                    setIsCodeBlockToolbarExiting(false);
                  }, 150);
                }, 100);
              }}
              isHovered={hoveredCodeBlock?.block.id === block.id}
            />
          ) : (
            <BlockRenderer key={block.id} block={block} />
          )
        ))}

        <Toolbar
          highlightElement={toolbarState?.element ?? null}
          onAnnotate={handleAnnotate}
          onClose={handleToolbarClose}
        />

        {/* Code block hover toolbar */}
        {hoveredCodeBlock && !toolbarState && (
          <CodeBlockToolbar
            element={hoveredCodeBlock.element}
            onAnnotate={handleCodeBlockAnnotate}
            onClose={handleCodeBlockToolbarClose}
            isExiting={isCodeBlockToolbarExiting}
            onMouseEnter={() => {
              if (hoverTimeoutRef.current) {
                clearTimeout(hoverTimeoutRef.current);
                hoverTimeoutRef.current = null;
              }
              setIsCodeBlockToolbarExiting(false);
            }}
            onMouseLeave={() => {
              hoverTimeoutRef.current = setTimeout(() => {
                setIsCodeBlockToolbarExiting(true);
                setTimeout(() => {
                  setHoveredCodeBlock(null);
                  setIsCodeBlockToolbarExiting(false);
                }, 150);
              }, 100);
            }}
          />
        )}
      </article>
    </div>
  );
});

/**
 * Renders inline markdown: **bold**, *italic*, `code`, [links](url)
 */
const InlineMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold: **text**
    let match = remaining.match(/^\*\*(.+?)\*\*/);
    if (match) {
      parts.push(<strong key={key++} className="font-semibold">{match[1]}</strong>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Italic: *text*
    match = remaining.match(/^\*(.+?)\*/);
    if (match) {
      parts.push(<em key={key++}>{match[1]}</em>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Inline code: `code`
    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      parts.push(
        <code key={key++} className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono">
          {match[1]}
        </code>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Links: [text](url)
    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      parts.push(
        <a
          key={key++}
          href={match[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {match[1]}
        </a>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    // Find next special character or consume one regular character
    const nextSpecial = remaining.slice(1).search(/[\*`\[]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else {
      parts.push(remaining.slice(0, nextSpecial + 1));
      remaining = remaining.slice(nextSpecial + 1);
    }
  }

  return <>{parts}</>;
};

const parseTableContent = (content: string): { headers: string[]; rows: string[][] } => {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseRow = (line: string): string[] => {
    // Remove leading/trailing pipes and split by |
    return line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map(cell => cell.trim());
  };

  const headers = parseRow(lines[0]);
  const rows: string[][] = [];

  // Skip the separator line (contains dashes) and parse data rows
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    // Skip separator lines (contain only dashes, pipes, colons, spaces)
    if (/^[\|\-:\s]+$/.test(line)) continue;
    rows.push(parseRow(line));
  }

  return { headers, rows };
};

const BlockRenderer: React.FC<{ block: Block }> = ({ block }) => {
  switch (block.type) {
    case 'heading':
      const Tag = `h${block.level || 1}` as keyof JSX.IntrinsicElements;
      const styles = {
        1: 'text-2xl font-bold mb-4 mt-6 first:mt-0 tracking-tight',
        2: 'text-xl font-semibold mb-3 mt-8 text-foreground/90',
        3: 'text-base font-semibold mb-2 mt-6 text-foreground/80',
      }[block.level || 1] || 'text-base font-semibold mb-2 mt-4';

      return <Tag className={styles} data-block-id={block.id}><InlineMarkdown text={block.content} /></Tag>;

    case 'blockquote':
      return (
        <blockquote
          className="border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic"
          data-block-id={block.id}
        >
          <InlineMarkdown text={block.content} />
        </blockquote>
      );

    case 'list-item': {
      const indent = (block.level || 0) * 1.25; // 1.25rem per level
      const isCheckbox = block.checked !== undefined;
      return (
        <div
          className="flex gap-3 my-1.5"
          data-block-id={block.id}
          style={{ marginLeft: `${indent}rem` }}
        >
          <span className="select-none shrink-0 flex items-center">
            {isCheckbox ? (
              block.checked ? (
                <svg className="w-4 h-4 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-muted-foreground/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )
            ) : (
              <span className="text-primary/60">
                {(block.level || 0) === 0 ? '•' : (block.level || 0) === 1 ? '◦' : '▪'}
              </span>
            )}
          </span>
          <span className={`text-sm leading-relaxed ${isCheckbox && block.checked ? 'text-muted-foreground line-through' : 'text-foreground/90'}`}>
            <InlineMarkdown text={block.content} />
          </span>
        </div>
      );
    }

    case 'code':
      return <CodeBlock block={block} />;

    case 'table': {
      const { headers, rows } = parseTableContent(block.content);
      return (
        <div className="my-4 overflow-x-auto" data-block-id={block.id}>
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                {headers.map((header, i) => (
                  <th
                    key={i}
                    className="px-3 py-2 text-left font-semibold text-foreground/90 bg-muted/30"
                  >
                    <InlineMarkdown text={header} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border/50 hover:bg-muted/20">
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-3 py-2 text-foreground/80">
                      <InlineMarkdown text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'hr':
      return <hr className="border-border/30 my-8" data-block-id={block.id} />;

    default:
      return (
        <p
          className="mb-4 leading-relaxed text-foreground/90 text-[15px]"
          data-block-id={block.id}
        >
          <InlineMarkdown text={block.content} />
        </p>
      );
  }
};

interface CodeBlockProps {
  block: Block;
  onHover: (element: HTMLElement) => void;
  onLeave: () => void;
  isHovered: boolean;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ block, onHover, onLeave, isHovered }) => {
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);

  // Highlight code block on mount and when content/language changes
  useEffect(() => {
    if (codeRef.current) {
      // Reset any previous highlighting
      codeRef.current.removeAttribute('data-highlighted');
      codeRef.current.className = `hljs font-mono${block.language ? ` language-${block.language}` : ''}`;
      hljs.highlightElement(codeRef.current);
    }
  }, [block.content, block.language]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(block.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [block.content]);

  const handleMouseEnter = () => {
    if (containerRef.current) {
      onHover(containerRef.current);
    }
  };

  // Build className for code element
  const codeClassName = `hljs font-mono${block.language ? ` language-${block.language}` : ''}`;

  return (
    <div
      ref={containerRef}
      className="relative group my-5"
      data-block-id={block.id}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={onLeave}
    >
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity z-10"
        title={copied ? 'Copied!' : 'Copy code'}
      >
        {copied ? (
          <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
      <pre className="rounded-lg text-[13px] overflow-x-auto bg-muted/50 border border-border/30">
        <code ref={codeRef} className={codeClassName}>{block.content}</code>
      </pre>
    </div>
  );
};

const CodeBlockToolbar: React.FC<{
  element: HTMLElement;
  onAnnotate: (type: AnnotationType, text?: string) => void;
  onClose: () => void;
  isExiting: boolean;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}> = ({ element, onAnnotate, onClose, isExiting, onMouseEnter, onMouseLeave }) => {
  const [step, setStep] = useState<'menu' | 'input'>('menu');
  const [inputValue, setInputValue] = useState('');
  const [position, setPosition] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (step === 'input') inputRef.current?.focus();
  }, [step]);

  // Update position on scroll/resize
  useEffect(() => {
    const updatePosition = () => {
      const rect = element.getBoundingClientRect();
      setPosition({
        top: rect.top - 40,
        right: window.innerWidth - rect.right,
      });
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [element]);

  const { top, right } = position;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputValue.trim()) {
      onAnnotate(AnnotationType.COMMENT, inputValue);
    }
  };

  return createPortal(
    <div
      className="annotation-toolbar fixed z-[100] bg-popover border border-border rounded-lg shadow-2xl"
      style={{
        top,
        right,
        animation: isExiting ? 'code-toolbar-out 0.15s ease-in forwards' : 'code-toolbar-in 0.2s ease-out',
      }}
      onMouseDown={e => e.stopPropagation()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <style>{`
        @keyframes code-toolbar-in {
          from {
            opacity: 0;
            transform: translateY(12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes code-toolbar-out {
          from {
            opacity: 1;
            transform: translateY(0);
          }
          to {
            opacity: 0;
            transform: translateY(8px);
          }
        }
      `}</style>
      {step === 'menu' ? (
        <div className="flex items-center p-1 gap-0.5">
          <button
            onClick={() => onAnnotate(AnnotationType.DELETION)}
            title="Delete"
            className="p-1.5 rounded-md transition-colors text-destructive hover:bg-destructive/10"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
          <button
            onClick={() => setStep('input')}
            title="Comment"
            className="p-1.5 rounded-md transition-colors text-accent hover:bg-accent/10"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
          </button>
          <div className="w-px h-5 bg-border mx-0.5" />
          <button
            onClick={onClose}
            title="Cancel"
            className="p-1.5 rounded-md transition-colors text-muted-foreground hover:bg-muted"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex items-start gap-1.5 p-1.5 pl-3">
          <textarea
            ref={inputRef}
            rows={1}
            className="bg-transparent text-sm min-w-44 max-w-80 max-h-32 placeholder:text-muted-foreground resize-none px-2 py-1.5 focus:outline-none focus:bg-muted/30"
            style={{ fieldSizing: 'content' } as React.CSSProperties}
            placeholder="Add a comment..."
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') setStep('menu');
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && inputValue.trim()) {
                e.preventDefault();
                onAnnotate(AnnotationType.COMMENT, inputValue);
              }
            }}
          />
          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="px-[15px] py-1 text-xs font-medium rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity self-stretch"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setStep('menu')}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </form>
      )}
    </div>,
    document.body
  );
};
