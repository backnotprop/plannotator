/**
 * Comments made on a file an agent's message names (approval "inbox-file-refs-open-viewer"), before it is one of the
 * message's attachments. The first attaches the file; then each comment is kept there, in the order made, and the
 * attachment opens at the first. One made while that runs waits its turn, also while the attachment opens (`done`):
 * it is never dropped, and its own promise says whether it was kept, so a comment already kept never reads as
 * unsaved when a later one fails. A failure keeps every comment not yet kept (`failed` hands them back with the
 * reason), and `retry` goes on from there: the file is attached once.
 */
export interface ReferencedCommentSteps {
  /** Attach the file to its message: the attachment's id. */
  attach: () => Promise<string>;
  /** Keep one comment on the attachment: the record's id. */
  save: (attachmentId: string, annotation: object) => Promise<string>;
  /** Every comment is kept: open the attachment at the first. Asked again when more were kept while it ran. */
  done: (attachmentId: string, first: string | null) => Promise<void> | void;
  /** Some were not kept: the reason, and those comments (their words stay on screen). */
  failed: (cause: unknown, unsaved: object[]) => void;
}

export interface ReferencedCommentQueue {
  /** Queue one comment: true once it is kept (and the attachment opened), false when it was not kept. */
  add: (annotation: object) => Promise<boolean>;
  /** Go on with the comments a failure left: true when every one is kept. */
  retry: () => Promise<boolean>;
}

interface Waiting {
  annotation: object;
  /** Its `add`'s answer, until told (a comment a failure left is told false once; Try again keeps it quietly). */
  answer: ((kept: boolean) => void) | null;
}

function tell(item: Waiting, kept: boolean): void {
  item.answer?.(kept);
  item.answer = null;
}

export function referencedCommentQueue(steps: ReferencedCommentSteps): ReferencedCommentQueue {
  const waiting: Waiting[] = [];
  let attached: string | null = null;
  let first: string | null = null;
  let running: Promise<boolean> | null = null;
  const run = (): Promise<boolean> => {
    if (running) return running;
    running = (async () => {
      // Kept in this run: told true once the attachment has opened with them.
      const kept: Waiting[] = [];
      try {
        attached ??= await steps.attach();
        do {
          while (waiting.length > 0) {
            const id = await steps.save(attached, waiting[0]!.annotation);
            kept.push(waiting.shift()!);
            first ??= id;
          }
          await steps.done(attached, first);
          // One made while the attachment opened is kept too, and the attachment opens again with it.
        } while (waiting.length > 0);
        return true;
      } catch (cause) {
        steps.failed(cause, waiting.map((item) => item.annotation));
        for (const item of waiting) tell(item, false);
        return false;
      } finally {
        for (const item of kept) tell(item, true);
        running = null;
      }
    })();
    return running;
  };
  return {
    add: (annotation) =>
      new Promise<boolean>((answer) => {
        waiting.push({ annotation, answer });
        void run();
      }),
    retry: run,
  };
}
