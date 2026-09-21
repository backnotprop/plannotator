import { describe, expect, it } from 'bun:test';
import {
  applyCollectionMutation,
  applyCollectionMutations,
  createUndoHistoryState,
  isHumanHistoryMutation,
  recordUndoAction,
  takeRedoAction,
  takeUndoAction,
  type CollectionMutation,
} from './undoHistory';

interface TestItem {
  id: string;
  text: string;
  inReplyTo?: string;
}

const getId = (item: TestItem): string => item.id;

describe('undo history', () => {
  it('bounds the past stack and invalidates redo after a new action', () => {
    let state = createUndoHistoryState<number>();
    for (let action = 1; action <= 5; action += 1) {
      state = recordUndoAction(state, action, 3);
    }
    expect(state.past).toEqual([3, 4, 5]);

    const undone = takeUndoAction(state);
    expect(undone.action).toBe(5);
    expect(undone.state.future).toEqual([5]);
    const branched = recordUndoAction(undone.state, 6, 3);
    expect(branched.future).toEqual([]);
    expect(takeRedoAction(branched, 3).action).toBeNull();
  });

  it('restores add, edit, and delete at their original positions', () => {
    const parent = { id: 'parent', text: 'Parent' };
    const reply = { id: 'reply', text: 'Reply', inReplyTo: parent.id };
    const sibling = { id: 'sibling', text: 'Sibling' };
    const deleted: CollectionMutation<TestItem> = { kind: 'delete', item: reply, index: 1 };
    const withoutReply = applyCollectionMutation([parent, reply, sibling], deleted, 'redo', getId);
    expect(withoutReply.map(getId)).toEqual(['parent', 'sibling']);
    expect(applyCollectionMutation(withoutReply, deleted, 'undo', getId)).toEqual([parent, reply, sibling]);

    const edited: CollectionMutation<TestItem> = {
      kind: 'edit',
      before: parent,
      after: { ...parent, text: 'Edited' },
    };
    expect(applyCollectionMutation([parent], edited, 'redo', getId)[0]?.text).toBe('Edited');
    expect(applyCollectionMutation([{ ...parent, text: 'Edited' }], edited, 'undo', getId)).toEqual([parent]);

    const added: CollectionMutation<TestItem> = { kind: 'add', item: reply, index: 1 };
    expect(applyCollectionMutation([parent, sibling], added, 'redo', getId)).toEqual([parent, reply, sibling]);
    expect(applyCollectionMutation([parent, reply, sibling], added, 'undo', getId)).toEqual([parent, sibling]);
  });

  it('inverts compound additions without changing reply relationships', () => {
    const parent = { id: 'parent', text: 'Parent' };
    const reply = { id: 'reply', text: 'Reply', inReplyTo: parent.id };
    const mutations: CollectionMutation<TestItem>[] = [
      { kind: 'add', item: parent, index: 0 },
      { kind: 'add', item: reply, index: 1 },
    ];
    const added = applyCollectionMutations([], mutations, 'redo', getId);
    expect(added).toEqual([parent, reply]);
    expect(applyCollectionMutations(added, mutations, 'undo', getId)).toEqual([]);
    expect(applyCollectionMutations([], mutations, 'redo', getId)[1]?.inReplyTo).toBe('parent');
  });

  it('explicitly excludes external and agent-authored mutations', () => {
    expect(isHumanHistoryMutation({})).toBe(true);
    expect(isHumanHistoryMutation({ source: 'browser-agent' })).toBe(false);
    expect(isHumanHistoryMutation({ source: 'external-review' })).toBe(false);
  });
});
