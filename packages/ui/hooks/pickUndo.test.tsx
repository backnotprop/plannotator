/**
 * A pick from the `/`, `$` or `@` list is the browser's own edit, one undo step of its own, and the words typed or
 * deleted before it stay their own steps (utils/undoableEdit.ts).
 *
 * The bug (Inbox reply box, Chrome): type `alpha beta gamma`, select all, Backspace, type `Run /dep`, pick
 * `deploy-preview`, ⌘Z three times: the box read `Run /deploy-preview alpha beta gamma`. The pick wrote the words as
 * `field.value` (React's write for `setText`), outside the browser's undo stack, so ⌘Z replayed the earlier steps
 * onto words they no longer described.
 *
 * happy-dom has no editing or undo, so this file gives it one, as Chrome keeps it: an edit is a list of splices; a
 * typing run (keys, `execCommand`) stays open until the selection is set (Select All, or a script's
 * `setSelectionRange`); undo takes the splices back, last first, at their offsets in the words as they are now.
 * A script's write of `value` is outside the stack: the words change and the steps stay, as in Chrome.
 *
 * DOM-gated (DOM_TESTS=1), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillCatalogEntry } from '../utils/skillReferences';
import type { MentionPerson, MentionSource } from '../utils/mentions';

const hasDom = typeof document !== 'undefined';
const skills = (hasDom ? await import('./useSkillReferenceAutocomplete') : {}) as typeof import('./useSkillReferenceAutocomplete');
const mentions = (hasDom ? await import('./useMentionAutocomplete') : {}) as typeof import('./useMentionAutocomplete');
const catalog = (hasDom ? await import('../utils/skillCatalog') : {}) as typeof import('../utils/skillCatalog');

const skill = (name: string): SkillCatalogEntry => ({ name, root: 'claude', description: name, humanOnly: false });
const ANN: MentionPerson = { id: 'user-ann', kind: 'user', label: 'Ann', detail: null, canOpen: true };
const SOURCE: MentionSource = { people: [ANN] };
const COMMANDS: SkillCatalogEntry[] = [{ name: 'goal', root: 'plannotator', description: 'Set a goal', humanOnly: false }];

/** One splice: at `at`, `removed` went and `inserted` came. */
interface Splice {
  at: number;
  removed: string;
  inserted: string;
}

/** The browser's editing, as far as undo goes (see the header). */
class FakeEditing {
  undoStack: Splice[][] = [];
  redoStack: Splice[][] = [];
  /** A typing run is open: the next typed edit joins the last step. */
  open = false;
  /** Writes of `value` from script that changed the words (outside the stack). */
  outOfBand = 0;
  private editing = false;
  private restore: (() => void)[] = [];

  install(): void {
    const proto = Object.getPrototypeOf(document.createElement('textarea')) as HTMLTextAreaElement;
    const value = Object.getOwnPropertyDescriptor(proto, 'value')!;
    const setSelectionRange = proto.setSelectionRange;
    this.rawSet = (field, words) => value.set!.call(field, words);
    this.rawSelect = (field, from, to) => setSelectionRange.call(field, from, to);
    const self = this;
    Object.defineProperty(proto, 'value', {
      ...value,
      set(this: HTMLTextAreaElement, next: string) {
        if (!self.editing && next !== value.get!.call(this)) self.outOfBand++;
        value.set!.call(this, next);
      },
    });
    // A script setting the selection ends the typing run (Blink and WebKit), whether or not it moves.
    proto.setSelectionRange = function (this: HTMLTextAreaElement, ...args: Parameters<HTMLTextAreaElement['setSelectionRange']>) {
      self.open = false;
      return setSelectionRange.apply(this, args);
    };
    const doc = document as Document & { execCommand?: Document['execCommand'] };
    const hadExec = Object.prototype.hasOwnProperty.call(doc, 'execCommand');
    const exec = doc.execCommand;
    doc.execCommand = (command: string, _ui?: boolean, words?: string) => {
      const field = document.activeElement;
      if (!(field instanceof HTMLTextAreaElement)) return false;
      const { selectionStart: from, selectionEnd: to } = field;
      if (command === 'insertText') this.edit(field, from, to, words ?? '', 'insertText', true);
      else if (command === 'delete') this.edit(field, from === to ? Math.max(0, from - 1) : from, to, '', 'deleteContentBackward', true);
      else return false;
      return true;
    };
    this.restore.push(() => {
      Object.defineProperty(proto, 'value', value);
      proto.setSelectionRange = setSelectionRange;
      if (hadExec) doc.execCommand = exec;
      else delete doc.execCommand;
    });
  }

  uninstall(): void {
    for (const undo of this.restore.splice(0)) undo();
  }

  private rawSet: (field: HTMLTextAreaElement, words: string) => void = () => {};
  private rawSelect: (field: HTMLTextAreaElement, from: number, to: number) => void = () => {};

  private write(field: HTMLTextAreaElement, words: string, caret: number, inputType: string): void {
    this.editing = true;
    try {
      this.rawSet(field, words);
    } finally {
      this.editing = false;
    }
    this.rawSelect(field, caret, caret);
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
  }

  /** One edit: `[from, to)` becomes `inserted`; `typing` joins the open run (and leaves it open). */
  edit(field: HTMLTextAreaElement, from: number, to: number, inserted: string, inputType: string, typing: boolean): void {
    const words = field.value;
    const splice = { at: from, removed: words.slice(from, to), inserted };
    if (typing && this.open && this.undoStack.length > 0) this.undoStack[this.undoStack.length - 1]!.push(splice);
    else this.undoStack.push([splice]);
    this.open = typing;
    this.redoStack = [];
    this.write(field, words.slice(0, from) + inserted + words.slice(to), from + inserted.length, inputType);
  }

  undo(field: HTMLTextAreaElement): void {
    const step = this.undoStack.pop();
    this.open = false;
    if (!step) return;
    let words = field.value;
    let caret = 0;
    for (const s of [...step].reverse()) {
      words = words.slice(0, s.at) + s.removed + words.slice(s.at + s.inserted.length);
      caret = s.at + s.removed.length;
    }
    this.redoStack.push(step);
    this.write(field, words, caret, 'historyUndo');
  }

  redo(field: HTMLTextAreaElement): void {
    const step = this.redoStack.pop();
    this.open = false;
    if (!step) return;
    let words = field.value;
    let caret = 0;
    for (const s of step) {
      words = words.slice(0, s.at) + s.inserted + words.slice(s.at + s.removed.length);
      caret = s.at + s.inserted.length;
    }
    this.undoStack.push(step);
    this.write(field, words, caret, 'historyRedo');
  }

  /** Keys typed at the selection, one character an edit, in one run. */
  type(field: HTMLTextAreaElement, words: string): void {
    for (const ch of words) this.edit(field, field.selectionStart, field.selectionEnd, ch, 'insertText', true);
  }

  /** ⌘A: the selection is the whole field, and the typing run ends. */
  selectAll(field: HTMLTextAreaElement): void {
    this.rawSelect(field, 0, field.value.length);
    this.open = false;
  }

  /** Backspace: the selection, else the character before the caret. */
  backspace(field: HTMLTextAreaElement): void {
    const { selectionStart: from, selectionEnd: to } = field;
    if (from === to && from === 0) return;
    this.edit(field, from === to ? from - 1 : from, to, '', 'deleteContentBackward', true);
  }
}

let editing: FakeEditing;
let root: Root | null = null;
let host: HTMLElement | null = null;
let api: { skills: ReturnType<typeof skills.useSkillReferenceAutocomplete>; mention: ReturnType<typeof mentions.useMentionAutocomplete> } | null = null;
let commandRuns: string[] = [];

function Composer({ initial = '' }: { initial?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initial);
  const skill = skills.useSkillReferenceAutocomplete({
    text,
    setText,
    textareaRef: ref,
    enabled: true,
    commands: COMMANDS,
    onCommand: (row) => commandRuns.push(row.name),
    quietOnDelete: true,
  });
  const mention = mentions.useMentionAutocomplete({ text, setText, textareaRef: ref, source: SOURCE, quietOnDelete: true });
  api = { skills: skill, mention };
  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(event) => {
        const kind = (event.nativeEvent as InputEvent).inputType;
        setText(event.target.value);
        skill.onEdit(kind);
        mention.onEdit(kind);
      }}
      onSelect={() => {
        skill.onSelect();
        mention.onSelect();
      }}
    />
  );
}

async function mount(initial?: string): Promise<HTMLTextAreaElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Composer initial={initial} />));
  await act(async () => {});
  const field = host.querySelector('textarea')!;
  field.focus();
  return field;
}

/** Runs a step as the browser would, then lets React and the hooks' timers settle. */
async function step(run: () => void): Promise<void> {
  await act(async () => run());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
}

/** The words after each of `count` undos (or redos). */
async function walk(field: HTMLTextAreaElement, kind: 'undo' | 'redo', count: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < count; i++) {
    await step(() => editing[kind](field));
    seen.push(field.value);
  }
  return seen;
}

beforeEach(() => {
  if (!hasDom) return;
  catalog.setSkillCatalogTransport(async () => [skill('deploy-preview'), skill('write-better')]);
  catalog.resetSkillCatalogCache();
  editing = new FakeEditing();
  editing.install();
  commandRuns = [];
});

afterEach(async () => {
  if (!hasDom) return;
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  api = null;
  editing.uninstall();
  catalog.resetSkillCatalogTransport();
  catalog.resetSkillCatalogCache();
});

describe.if(hasDom)('a pick from the list is its own undo step', () => {
  test('the reported sequence: words deleted before a skill pick never come back merged with it', async () => {
    const field = await mount();
    await step(() => editing.type(field, 'alpha beta gamma'));
    await step(() => editing.selectAll(field));
    await step(() => editing.backspace(field));
    expect(field.value).toBe('');
    await step(() => editing.type(field, 'Run /dep'));
    expect(api!.skills.menu?.items[0]?.name).toBe('deploy-preview');
    await step(() => api!.skills.select(0));
    expect(field.value).toBe('Run /deploy-preview ');
    expect(field.selectionStart).toBe('Run /deploy-preview '.length);
    expect(editing.outOfBand).toBe(0);

    // The pick, then the deletion and the typing after it (one run, as Chrome keeps it), then the first words; then
    // nothing further: the field stays empty.
    expect(await walk(field, 'undo', 4)).toEqual(['Run /dep', 'alpha beta gamma', '', '']);
    expect(await walk(field, 'redo', 3)).toEqual(['alpha beta gamma', 'Run /dep', 'Run /deploy-preview ']);
    expect(editing.outOfBand).toBe(0);
  });

  test('select all, delete, type, then undo: the deletion comes back whole; the words typed after a pick are their own step', async () => {
    const field = await mount();
    await step(() => editing.type(field, 'first words'));
    await step(() => editing.selectAll(field));
    await step(() => editing.backspace(field));
    await step(() => editing.type(field, 'new /wri'));
    await step(() => api!.skills.select(0));
    await step(() => editing.type(field, 'please'));
    expect(field.value).toBe('new /write-better please');
    expect(await walk(field, 'undo', 3)).toEqual(['new /write-better ', 'new /wri', 'first words']);
    expect(await walk(field, 'redo', 3)).toEqual(['new /wri', 'new /write-better ', 'new /write-better please']);
    expect(editing.outOfBand).toBe(0);
  });

  test('an @ pick: one step, undo and redo walk it exactly', async () => {
    const field = await mount();
    await step(() => editing.type(field, 'ask @An'));
    expect(api!.mention.menu?.items[0]?.id).toBe(ANN.id);
    await step(() => api!.mention.select(0));
    expect(field.value).toBe('ask @Ann ');
    expect(api!.mention.mentions.map((p) => p.id)).toEqual([ANN.id]);
    expect(await walk(field, 'undo', 2)).toEqual(['ask @An', '']);
    expect(await walk(field, 'redo', 2)).toEqual(['ask @An', 'ask @Ann ']);
    expect(editing.outOfBand).toBe(0);
  });

  test('a command pick takes its typed trigger out as one step: undo brings the trigger back', async () => {
    const field = await mount();
    await step(() => editing.type(field, 'ship it /go'));
    const at = api!.skills.menu!.items.findIndex((row) => row.name === 'goal');
    await step(() => api!.skills.select(at));
    expect(commandRuns).toEqual(['goal']);
    expect(field.value).toBe('ship it ');
    expect(await walk(field, 'undo', 2)).toEqual(['ship it /go', '']);
    expect(editing.outOfBand).toBe(0);
  });

  test('a draft brought back: a pick after it undoes to the typing, then to the draft, never further', async () => {
    const field = await mount('kept draft ');
    field.setSelectionRange(field.value.length, field.value.length);
    await step(() => editing.type(field, '/dep'));
    await step(() => api!.skills.select(0));
    expect(field.value).toBe('kept draft /deploy-preview ');
    expect(await walk(field, 'undo', 3)).toEqual(['kept draft /dep', 'kept draft ', 'kept draft ']);
    expect(editing.outOfBand).toBe(0);
  });

  test('a field without focus still takes the pick (written as before, no editing to go through)', async () => {
    const field = await mount();
    await step(() => editing.type(field, 'Run /dep'));
    field.blur();
    await step(() => api!.skills.select(0));
    expect(field.value).toBe('Run /deploy-preview ');
  });
});
