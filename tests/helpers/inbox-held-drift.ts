type Json = unknown;

interface ThreadLike {
  thread: { project?: Record<string, unknown> } & Record<string, unknown>;
}

interface ListRowLike {
  thread_id: string;
  thread_name?: string | null;
}

interface ListLike {
  sections: readonly { threads: readonly ListRowLike[] }[];
  snoozed?: readonly ListRowLike[];
}

const MAX_LINES = 24;

export function comparableThread(model: ThreadLike): Json {
  const { repo: _repo, repo_known: _known, ...project } = model.thread.project ?? {};
  return { ...model.thread, project };
}

export function comparableList(list: ListLike, only?: ReadonlySet<string>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const row of [...list.sections.flatMap((section) => section.threads), ...(list.snoozed ?? [])]) {
    if (!only || only.has(row.thread_id)) out[row.thread_id] = row.thread_name ?? null;
  }
  return out;
}

export function comparableFiles(files: { attachments?: Json; inline_images?: Json; annotations?: Json; earlier_annotations?: Json }): Json {
  return { attachments: files.attachments ?? [], inline_images: files.inline_images ?? [], annotations: files.annotations ?? [], earlier_annotations: files.earlier_annotations ?? [] };
}

const show = (value: Json): string => {
  const text = JSON.stringify(value);
  if (text === undefined) return 'absent';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

const labelOf = (item: Json, index: number): string => {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const record = item as Record<string, unknown>;
    if (typeof record.id === 'string') return `[id=${record.id}]`;
    if (typeof record.key === 'string') return `[key=${record.key}]`;
  }
  return `[${index}]`;
};

function walk(held: Json, fresh: Json, path: string, out: string[]): void {
  if (out.length >= MAX_LINES) return;
  if (Object.is(held, fresh)) return;
  if (Array.isArray(held) && Array.isArray(fresh)) {
    const heldLabels = held.map(labelOf);
    const freshLabels = fresh.map(labelOf);
    if (heldLabels.join() !== freshLabels.join()) {
      out.push(`${path}: held ${heldLabels.join(' ') || '(empty)'} | fresh ${freshLabels.join(' ') || '(empty)'}`);
      return;
    }
    held.forEach((item, i) => walk(item, fresh[i], `${path}${heldLabels[i]}`, out));
    return;
  }
  if (held && fresh && typeof held === 'object' && typeof fresh === 'object' && !Array.isArray(held) && !Array.isArray(fresh)) {
    const a = held as Record<string, unknown>;
    const b = fresh as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (a[key] === undefined && b[key] === undefined) continue;
      walk(a[key], b[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push(`${path}: held ${show(held)} | fresh ${show(fresh)}`);
}

export function heldDrift(held: Json, fresh: Json): string | null {
  const out: string[] = [];
  walk(held, fresh, '', out);
  if (out.length === 0) return null;
  return out.length >= MAX_LINES ? [...out, '...'].join('\n') : out.join('\n');
}

export function threadDrift(held: ThreadLike, fresh: ThreadLike): string | null {
  return heldDrift(comparableThread(held), comparableThread(fresh));
}

export function listDrift(held: ListLike, fresh: ListLike, only?: ReadonlySet<string>): string | null {
  return heldDrift(comparableList(held, only), comparableList(fresh, only));
}
