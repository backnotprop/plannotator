/**
 * Nudge table, no DOM: each of the twelve codes fires for exactly its
 * condition and carries the ids/path/section/action the flows rely on; a
 * quiet snapshot yields nothing; no message ever embeds document or comment
 * text.
 */
import { describe, expect, test } from 'bun:test';
import { AnnotationChangeTracker, BROWSER_AGENT_SOURCE } from './changes';
import { MAX_NUDGE_IDS, buildNudges, type NudgeSnapshot } from './nudges';
import type { NudgeCode } from './toolset';

const toolName = (bare: string) => `plannotator.${bare}`;

function quiet(overrides: Partial<NudgeSnapshot> = {}): NudgeSnapshot {
  return {
    surface: 'markdown',
    composer: { open: false },
    sourceStale: false,
    documentEdited: false,
    pageUrl: null,
    lastPageUrl: null,
    annotationCount: 0,
    decided: false,
    firstResponse: false,
    annotations: [],
    otherDocuments: [],
    since: 0,
    ...overrides,
  };
}

const codes = (nudges: ReturnType<typeof buildNudges>): NudgeCode[] => nudges.map((n) => n.code);

describe('buildNudges', () => {
  test('a quiet snapshot yields no nudges', () => {
    expect(buildNudges(quiet(), new AnnotationChangeTracker(), toolName)).toEqual([]);
  });

  test('annotations_new names the human ids and never the agent-authored state', () => {
    const tracker = new AnnotationChangeTracker();
    const mine = { id: 'g1', text: 'agent text', source: BROWSER_AGENT_SOURCE };
    tracker.claimOwn(mine);
    tracker.observe([{ id: 'h1', text: 'the secret plan text' }, mine]);
    const nudges = buildNudges(quiet({ annotations: [{ id: 'h1' }, { id: 'g1', source: BROWSER_AGENT_SOURCE }], annotationCount: 2 }), tracker, toolName);
    const fresh = nudges.find((n) => n.code === 'annotations_new');
    expect(fresh?.ids).toEqual(['h1']);
    expect(fresh?.message).not.toContain('secret');
    expect(codes(nudges)).toEqual(['annotations_new', 'pending_unsent']);
  });

  test('replies_new separates replies to agent comments from other new comments', () => {
    const tracker = new AnnotationChangeTracker();
    tracker.observe([{ id: 'g1', source: BROWSER_AGENT_SOURCE }, { id: 'r1', inReplyTo: 'g1' }, { id: 'h2' }]);
    const annotations = [{ id: 'g1', source: BROWSER_AGENT_SOURCE }, { id: 'r1', inReplyTo: 'g1' }, { id: 'h2' }];
    const nudges = buildNudges(quiet({ annotations, annotationCount: 3 }), tracker, toolName);
    expect(nudges.find((n) => n.code === 'replies_new')?.ids).toEqual(['r1']);
    expect(nudges.find((n) => n.code === 'annotations_new')?.ids).toEqual(['g1', 'h2']);
  });

  test('annotations_removed flags removal of the agent\'s own comment as the resolution signal', () => {
    const tracker = new AnnotationChangeTracker();
    tracker.observe([{ id: 'g1', source: BROWSER_AGENT_SOURCE }, { id: 'h1' }]);
    tracker.advance();
    tracker.observe([{ id: 'h1' }]);
    const nudges = buildNudges(quiet({ annotations: [{ id: 'h1' }], annotationCount: 1, since: tracker.watermark }), tracker, toolName);
    const removed = nudges.find((n) => n.code === 'annotations_removed');
    expect(removed?.ids).toEqual(['g1']);
    // Deliberate pin: "your comments" is the phrase that tells the agent the
    // removal was of ITS OWN comment (the resolution signal), as opposed to the
    // neutral wording for someone else's; the two branches must stay distinct.
    expect(removed?.message).toContain('your comments');
  });

  test('composer_open carries the section when known', () => {
    const nudges = buildNudges(quiet({ composer: { open: true, section: 'auth-changes' } }), new AnnotationChangeTracker(), toolName);
    expect(nudges).toEqual([{ code: 'composer_open', message: expect.any(String), section: 'auth-changes' }]);
  });

  test('source_stale and document_edited fire on their flags', () => {
    const nudges = buildNudges(quiet({ sourceStale: true, documentEdited: true }), new AnnotationChangeTracker(), toolName);
    expect(codes(nudges)).toEqual(['source_stale', 'document_edited']);
  });

  test('comment_only_surface fires once, on the first response of a non-markdown surface', () => {
    const tracker = new AnnotationChangeTracker();
    expect(codes(buildNudges(quiet({ surface: 'html', firstResponse: true }), tracker, toolName))).toEqual(['comment_only_surface']);
    expect(codes(buildNudges(quiet({ surface: 'html', firstResponse: false }), tracker, toolName))).toEqual([]);
    expect(codes(buildNudges(quiet({ surface: 'markdown', firstResponse: true }), tracker, toolName))).toEqual([]);
  });

  test('page_changed fires only when the live page differs from the last response', () => {
    const tracker = new AnnotationChangeTracker();
    expect(codes(buildNudges(quiet({ surface: 'live-app', pageUrl: '/a', lastPageUrl: null }), tracker, toolName))).toEqual([]);
    const nudges = buildNudges(quiet({ surface: 'live-app', pageUrl: '/b', lastPageUrl: '/a' }), tracker, toolName);
    expect(nudges).toEqual([{ code: 'page_changed', message: expect.any(String), path: '/b' }]);
  });

  test('other_document_active carries the path and the exact read_document action, capped at ten', () => {
    const docs = Array.from({ length: 12 }, (_, i) => ({
      path: `docs/${i}.md`, open: false, annotations: 1, newSinceLastRead: 1, composerOpen: false, openedSinceLastRead: false,
    }));
    const nudges = buildNudges(quiet({ otherDocuments: docs }), new AnnotationChangeTracker(), toolName);
    const others = nudges.filter((n) => n.code === 'other_document_active');
    expect(others.length).toBe(10);
    expect(others[0]).toEqual({
      code: 'other_document_active',
      message: expect.any(String),
      path: 'docs/0.md',
      action: { tool: 'plannotator.read_document', args: { path: 'docs/0.md' } },
    });
    // A quiet sibling (nothing new, no composer, not just opened) is silent.
    expect(codes(buildNudges(quiet({ otherDocuments: [{ ...docs[0]!, newSinceLastRead: 0 }] }), new AnnotationChangeTracker(), toolName))).toEqual([]);
  });

  test('truncated carries the continuation call with the original section args', () => {
    const nudges = buildNudges(quiet({ truncated: { nextOffset: 16000, args: { section: 'goal' } } }), new AnnotationChangeTracker(), toolName);
    expect(nudges[0]?.action).toEqual({ tool: 'plannotator.read_document', args: { section: 'goal', offset: 16000 } });
  });

  // A 10,000-annotation burst produced an 89 KB annotations_new nudge: the
  // id list had no cap. The first MAX_NUDGE_IDS are listed and the message
  // says how many more there are.
  test('a burst of new or removed comments lists at most MAX_NUDGE_IDS ids and says how many more', () => {
    const tracker = new AnnotationChangeTracker();
    const burst = Array.from({ length: MAX_NUDGE_IDS + 250 }, (_, i) => ({ id: `x-${i}`, text: 't' }));
    tracker.observe(burst);
    const fresh = buildNudges(quiet({ annotations: burst, annotationCount: burst.length }), tracker, toolName)
      .find((n) => n.code === 'annotations_new');
    expect(fresh?.ids?.length).toBe(MAX_NUDGE_IDS);
    expect(fresh?.ids?.[0]).toBe('x-0');
    expect(fresh?.message).toContain('250 more');

    tracker.observe([]);
    const removed = buildNudges(quiet(), tracker, toolName).find((n) => n.code === 'annotations_removed');
    expect(removed?.ids?.length).toBe(MAX_NUDGE_IDS);
    expect(removed?.message).toContain('250 more');

    // Under the cap nothing changes: every id, no suffix.
    const small = new AnnotationChangeTracker();
    small.observe([{ id: 'a', text: 't' }, { id: 'b', text: 't' }]);
    const few = buildNudges(quiet({ annotations: [{ id: 'a' }, { id: 'b' }], annotationCount: 2 }), small, toolName)
      .find((n) => n.code === 'annotations_new');
    expect(few?.ids).toEqual(['a', 'b']);
    expect(few?.message).not.toContain('more');
  });

  test('session_decided replaces pending_unsent once the human has decided', () => {
    const tracker = new AnnotationChangeTracker();
    expect(codes(buildNudges(quiet({ annotationCount: 3 }), tracker, toolName))).toEqual(['pending_unsent']);
    expect(codes(buildNudges(quiet({ annotationCount: 3, decided: true }), tracker, toolName))).toEqual(['session_decided']);
  });
});
