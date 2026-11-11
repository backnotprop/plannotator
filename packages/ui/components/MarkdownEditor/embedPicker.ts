import {
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import {
  EditorState,
  MapMode,
  StateEffect,
  StateField,
  type Extension,
  type StateEffectType,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SlashCommandItem } from '@plannotator/atomic-editor';
import { planEmbedInsert } from '@plannotator/core/embed-insert';

export type EmbedKind = 'html';

export interface EmbedTarget {
  readonly kind: EmbedKind;
  readonly path: string;
  readonly title?: string | null;
}

export interface EmbedPickerConfig {
  readonly getTargets: () => readonly EmbedTarget[];
  readonly buildInsertLine: (target: EmbedTarget) => string;
  readonly uploadTarget?: (kind: EmbedKind) => Promise<EmbedTarget | null>;
  readonly getNotice?: (docBody: string) => string | null;
  readonly labels?: {
    readonly upload?: string;
    readonly empty?: string;
    readonly noMatch?: (query: string) => string;
  };
}

type IconCompletion = Completion & {
  readonly slashCommandIcon?: string;
};

type UploadAnchor = {
  readonly from: number;
  readonly to: number;
  readonly text: string;
};

type UploadState =
  | { readonly _tag: 'idle' }
  | { readonly _tag: 'uploading'; readonly anchor: UploadAnchor | null };

type UploadStateEffect =
  | { readonly _tag: 'start'; readonly anchor: UploadAnchor }
  | { readonly _tag: 'finish' };

type UploadStateEffectType = StateEffectType<UploadStateEffect>;

const IDLE_UPLOAD_STATE: UploadState = { _tag: 'idle' };
const EMBED_PREFIX = '/embed ';
const HTML_KIND: EmbedKind = 'html';

const EMBED_ICON =
  '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6.4 6 4.4 8l2 2"/><path d="M9.6 6 11.6 8l-2 2"/></svg>';

const UPLOAD_ICON =
  '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5V13h10V8.5"/><path d="M8 11V3M5 6l3-3 3 3"/></svg>';

/**
 * Build the static slash-menu item that hands completion to the `/embed` picker. immediately
 * reopens completion.
 */
export function embedSlashItem(): SlashCommandItem {
  return {
    label: 'Embed HTML',
    detail: 'live preview',
    icon: EMBED_ICON,
    apply: (view, completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert: EMBED_PREFIX },
        selection: { anchor: from + EMBED_PREFIX.length },
        annotations: pickedCompletion.of(completion),
      });
      startCompletion(view);
    },
  };
}

/** Build the `/embed` target picker extension for one editor mount. */
export function embedPicker(config: EmbedPickerConfig): Extension {
  const uploadStateEffect = StateEffect.define<UploadStateEffect>();
  const uploadStateField = StateField.define<UploadState>({
    create: () => IDLE_UPLOAD_STATE,
    update: (current, transaction) => {
      let next = current;
      if (next._tag === 'uploading' && next.anchor !== null && transaction.docChanged) {
        const mappedFrom = transaction.changes.mapPos(next.anchor.from, 1, MapMode.TrackAfter);
        const mappedTo = transaction.changes.mapPos(next.anchor.to, -1, MapMode.TrackBefore);
        next = {
          _tag: 'uploading',
          anchor:
            mappedFrom === null || mappedTo === null || mappedFrom > mappedTo
              ? null
              : { ...next.anchor, from: mappedFrom, to: mappedTo },
        };
      }

      for (const effect of transaction.effects) {
        if (!effect.is(uploadStateEffect)) continue;
        next =
          effect.value._tag === 'start'
            ? { _tag: 'uploading', anchor: effect.value.anchor }
            : IDLE_UPLOAD_STATE;
      }
      return next;
    },
  });

  const source = createEmbedPickerSource(config, uploadStateField, uploadStateEffect);
  return [uploadStateField, EditorState.languageData.of(() => [{ autocomplete: source }])];
}

function createEmbedPickerSource(
  config: EmbedPickerConfig,
  uploadStateField: StateField<UploadState>,
  uploadStateEffect: UploadStateEffectType,
): CompletionSource {
  return (context) => {
    const match = context.matchBefore(/\/embed +[^\n]*$/);
    if (match === null) return null;

    // Like the package slash source, the trigger must open its line. An embed
    // is a block insertion and belongs in its own paragraph.
    const line = context.state.doc.lineAt(match.from);
    if (!/^\s*$/.test(line.text.slice(0, match.from - line.from))) return null;

    const query = match.text.replace(/^\/embed +/, '');
    const targets = config.getTargets().filter((target) => target.kind === HTML_KIND);
    const matches = filterTargets(targets, query);
    const options: IconCompletion[] = [];
    const notice = config.getNotice?.(context.state.doc.toString()) ?? null;
    if (notice !== null) {
      options.push({
        label: notice,
        apply: () => {
        },
      });
    }

    if (matches.length === 0) {
      options.push({
        label:
          targets.length === 0
            ? config.labels?.empty ?? 'No HTML files in this workspace'
            : config.labels?.noMatch?.(query.trim()) ?? `No HTML files match “${query.trim()}”`,
        apply: (view, completion, _from, to) => {
          view.dispatch({
            changes: { from: line.from, to, insert: '' },
            annotations: pickedCompletion.of(completion),
          });
        },
      });
    } else {
      for (const target of matches) {
        options.push({
          label: targetLabel(target),
          detail: target.path,
          apply: (view, completion, from, to) => {
            applyTargetInsert(view, completion, from, to, target, config.buildInsertLine);
          },
        });
      }
    }

    const uploadTarget = config.uploadTarget;
    if (uploadTarget !== undefined) {
      const uploadState = context.state.field(uploadStateField);
      options.push(
        uploadState._tag === 'uploading'
          ? {
              label: 'Uploading...',
              slashCommandIcon: UPLOAD_ICON,
              apply: () => {
              },
            }
          : {
              label: config.labels?.upload ?? 'Upload HTML...',
              slashCommandIcon: UPLOAD_ICON,
              apply: (view, completion, from, to) => {
                startUpload(
                  view,
                  completion,
                  from,
                  to,
                  config,
                  uploadTarget,
                  uploadStateField,
                  uploadStateEffect,
                );
              },
            },
      );
    }

    return {
      // Our case-insensitive substring matcher owns filtering because CM's fuzzy matcher closes a
      // completion session when a title query contains spaces.
      from: match.from,
      options,
      filter: false,
    };
  };
}

function filterTargets(targets: readonly EmbedTarget[], query: string): readonly EmbedTarget[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return targets;
  return targets.filter((target) => {
    const title = (target.title ?? '').toLowerCase();
    return title.includes(needle) || target.path.toLowerCase().includes(needle);
  });
}

function targetLabel(target: EmbedTarget): string {
  const title = target.title ?? '';
  return title.trim() === '' ? target.path : title;
}

function applyTargetInsert(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
  target: EmbedTarget,
  buildInsertLine: EmbedPickerConfig['buildInsertLine'],
): void {
  const body = view.state.doc.toString();
  const plan = planEmbedInsert(body, from, to, buildInsertLine(target));
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: plan.cursor },
    scrollIntoView: true,
    annotations: pickedCompletion.of(completion),
  });
}

function startUpload(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
  config: EmbedPickerConfig,
  uploadTarget: NonNullable<EmbedPickerConfig['uploadTarget']>,
  uploadStateField: StateField<UploadState>,
  uploadStateEffect: UploadStateEffectType,
): void {
  const uploadState = view.state.field(uploadStateField, false);
  if (uploadState?._tag === 'uploading') return;

  const anchor: UploadAnchor = {
    from,
    to,
    text: view.state.doc.sliceString(from, to),
  };
  view.dispatch({
    effects: uploadStateEffect.of({ _tag: 'start', anchor }),
    annotations: pickedCompletion.of(completion),
  });

  void (async () => {
    try {
      const target = await uploadTarget(HTML_KIND);
      finishUpload(view, completion, target, config, uploadStateField, uploadStateEffect);
    } catch {
      clearUpload(view, uploadStateField, uploadStateEffect);
    }
  })();
}

function finishUpload(
  view: EditorView,
  completion: Completion,
  target: EmbedTarget | null,
  config: EmbedPickerConfig,
  uploadStateField: StateField<UploadState>,
  uploadStateEffect: UploadStateEffectType,
): void {
  const uploadState = view.state.field(uploadStateField, false);
  if (uploadState?._tag !== 'uploading') return;

  const anchor = uploadState.anchor;
  if (target === null || anchor === null || !isLiveAnchor(view, anchor)) {
    clearUpload(view, uploadStateField, uploadStateEffect);
    return;
  }

  const body = view.state.doc.toString();
  const plan = planEmbedInsert(body, anchor.from, anchor.to, config.buildInsertLine(target));
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: plan.cursor },
    scrollIntoView: true,
    effects: uploadStateEffect.of({ _tag: 'finish' }),
    annotations: pickedCompletion.of(completion),
  });
}

function isLiveAnchor(view: EditorView, anchor: UploadAnchor): boolean {
  if (anchor.from > anchor.to || anchor.to > view.state.doc.length) return false;
  if (view.state.doc.sliceString(anchor.from, anchor.to) !== anchor.text) return false;
  const line = view.state.doc.lineAt(anchor.from);
  return /^\s*$/.test(line.text.slice(0, anchor.from - line.from));
}

function clearUpload(
  view: EditorView,
  uploadStateField: StateField<UploadState>,
  uploadStateEffect: UploadStateEffectType,
): void {
  const uploadState = view.state.field(uploadStateField, false);
  if (uploadState?._tag !== 'uploading') return;
  view.dispatch({ effects: uploadStateEffect.of({ _tag: 'finish' }) });
}
