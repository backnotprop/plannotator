/**
 * A file's comment (the header's Comment box) keeps what the box attached: a
 * picture and a file survive the saved draft, its reload and the feedback the
 * agent is sent. What regresses: the attachments dropped when the comment is
 * made (the box offered them, the comment never had them), dropped from the
 * feedback, or a comment of pictures alone made into no comment at all.
 *
 * The draft is the real review draft store (packages/shared/review-draft.ts)
 * under a temp PLANNOTATOR_DATA_DIR set inside each test and restored after.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeAnnotation, ImageAttachment } from '@plannotator/ui/types';
import type { PRMetadata } from '@plannotator/shared/pr-types';
import { contentHash } from '@plannotator/shared/draft';
import { loadReviewDraft, prDraftTargetKey, saveReviewDraft } from '@plannotator/shared/review-draft';
import { reanchorCodeAnnotations } from '@plannotator/ui/utils/codeAnnotationAnchor';
import { newFileComment } from './fileComment';
import { exportReviewFeedback } from './exportFeedback';

const pr: PRMetadata = {
  platform: 'github',
  host: 'github.com',
  owner: 'northwind',
  repo: 'orchard',
  number: 7,
  title: 'Sort the harvest',
  author: 'ada-novak',
  baseBranch: 'main',
  headBranch: 'feature/harvest',
  baseSha: 'b0',
  headSha: 'h1',
  url: 'https://github.com/northwind/orchard/pull/7',
};

const picture: ImageAttachment = { path: '/tmp/plannotator/upload-1/shed-roof.png', name: 'shed-roof' };
const logFile: ImageAttachment = { path: '/tmp/plannotator/upload-2/harvest.log', name: 'harvest.log', kind: 'file' };

let savedDataDir: string | undefined;

beforeEach(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = mkdtempSync(join(tmpdir(), 'plannotator-file-comment-'));
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

/** Save the comments as the review's draft, then read them back as a reload does. */
function saveAndReload(annotations: CodeAnnotation[]): CodeAnnotation[] {
  const keys = { patchKey: contentHash('the patch'), targetKey: prDraftTargetKey(pr, 'layer') };
  expect(saveReviewDraft(keys, { codeAnnotations: annotations, draftGeneration: 1, ts: 1 })).toBe(true);
  const loaded = loadReviewDraft(keys);
  if (!loaded.found) throw new Error('the draft was not found');
  const restored = loaded.draft.codeAnnotations as CodeAnnotation[];
  return reanchorCodeAnnotations(restored, [], { patchChanged: true });
}

function made(text: string, images?: ImageAttachment[]): CodeAnnotation {
  const comment = newFileComment({ id: 'c1', filePath: 'src/harvest.ts', text, images, createdAt: 1, author: 'Charlie Dunn' });
  if (!comment) throw new Error('no comment was made');
  return { ...comment, prUrl: pr.url };
}

describe('a file comment keeps what its box attached', () => {
  test('a picture and a file: kept through the draft and its reload, and both reach the agent', () => {
    const [restored] = saveAndReload([made('  Charlie Dunn: the roof in this shot leaks.  ', [picture, logFile])]);
    expect(restored.scope).toBe('file');
    expect(restored.images).toEqual([picture, logFile]);

    const feedback = exportReviewFeedback([restored], pr);
    const section = feedback.slice(feedback.indexOf('## src/harvest.ts'));
    expect(section).toContain('### File Comment\nCharlie Dunn: the roof in this shot leaks.\n');
    expect(section).toContain(`**Attached images:**\n- [shed-roof] \`${picture.path}\`\n`);
    expect(section).toContain(`**Attached files:**\n- [harvest.log] \`${logFile.path}\`\n`);
  });

  test('pictures alone are a comment: made, kept, and sent with no empty words line', () => {
    const [restored] = saveAndReload([made('   ', [picture])]);
    expect(restored.images).toEqual([picture]);
    expect(restored.text).toBeUndefined();

    const feedback = exportReviewFeedback([restored], pr);
    expect(feedback).toContain(`### File Comment\n**Attached images:**\n- [shed-roof] \`${picture.path}\`\n`);
    expect(feedback).not.toMatch(/^>\s*$/m);
  });

  test('a box with neither words nor attachments makes no comment', () => {
    expect(newFileComment({ id: 'c2', filePath: 'src/harvest.ts', text: '  ', images: [], createdAt: 1 })).toBeNull();
  });

  test("a whole-file line comment's attachments reach the agent too", () => {
    const line: CodeAnnotation = {
      id: 'l1', type: 'comment', scope: 'line', filePath: 'src/harvest.ts', lineStart: 4, lineEnd: 4, side: 'new',
      text: 'Bob Tully: this count is off.', images: [picture, logFile], createdAt: 2, prUrl: pr.url,
    };
    const feedback = exportReviewFeedback(saveAndReload([line]), pr);
    expect(feedback).toContain(`**Attached images:**\n- [shed-roof] \`${picture.path}\`\n`);
    expect(feedback).toContain(`**Attached files:**\n- [harvest.log] \`${logFile.path}\`\n`);
  });
});
