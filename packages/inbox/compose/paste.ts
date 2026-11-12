const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
};

const GENERIC_NAME = /^(?:image|blob|pasted graphic(?: \d+)?|clipboard(?:[ -]?image)?|untitled)(?:\.[a-z0-9]+)?$/i;

const pad = (n: number) => String(n).padStart(2, '0');

export function pasteStamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

function extensionOf(file: Pick<File, 'name' | 'type'>): string {
  const type = (file.type ?? '').toLowerCase();
  const known = IMAGE_EXTENSIONS[type];
  if (known) return known;
  const name = file.name ?? '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
  return type.startsWith('image/') ? 'png' : 'bin';
}

export function isGenericPasteName(name: string | undefined | null): boolean {
  const own = (name ?? '').trim();
  return own === '' || GENERIC_NAME.test(own);
}

export function pastedFileName(file: Pick<File, 'name' | 'type'>, at: Date, taken: ReadonlySet<string>): string {
  const own = (file.name ?? '').trim();
  if (!isGenericPasteName(own)) return own;
  const kind = (file.type ?? '').startsWith('image/') ? 'image' : 'file';
  const stem = `pasted-${kind}-${pasteStamp(at)}`;
  const ext = extensionOf(file);
  let name = `${stem}.${ext}`;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.${ext}`;
  return name;
}

export function clipboardFiles(data: Pick<DataTransfer, 'files' | 'items'> | null): File[] {
  if (!data) return [];
  const fromItems: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []);
}

function plainText(data: Partial<Pick<DataTransfer, 'getData'>> | null): string {
  try {
    return typeof data?.getData === 'function' ? data.getData('text/plain') : '';
  } catch {
    return '';
  }
}

function stringOf(data: Partial<Pick<DataTransfer, 'getData'>> | null, type: string): string {
  try {
    return typeof data?.getData === 'function' ? data.getData(type) : '';
  } catch {
    return '';
  }
}

const decodeAttribute = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function pastedImageOwnLink(data: Partial<Pick<DataTransfer, 'getData'>> | null, phone: boolean): boolean {
  if (!phone) return false;
  const link = plainText(data).trim();
  if (!/^https?:\/\/\S+$/i.test(link)) return false;
  const html = stringOf(data, 'text/html');
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = src ? decodeAttribute((src[1] ?? src[2] ?? src[3] ?? '').trim()) : '';
    if (value === link) return true;
  }
  return false;
}

export function chosenFiles(list: Iterable<File>, taken: Iterable<string>, at = new Date()): File[] {
  const files = [...list];
  const names = chosenFileNames(files, taken, at);
  return files.map((file, i) => (names[i] === file.name ? file : new File([file], names[i]!, { type: file.type, lastModified: file.lastModified })));
}

export function chosenFileNames(files: readonly Pick<File, 'name' | 'type'>[], taken: Iterable<string>, at = new Date()): string[] {
  const names = new Set(taken);
  return files.map((file) => {
    const name = pastedFileName(file, at, names);
    names.add(name);
    return name;
  });
}

export function pastedFiles(
  data: (Pick<DataTransfer, 'files' | 'items'> & Partial<Pick<DataTransfer, 'getData'>>) | null,
  taken: Iterable<string>,
  at = new Date(),
  { phone = false }: { phone?: boolean } = {},
): File[] {
  let files = clipboardFiles(data);
  if (files.length > 0 && plainText(data).trim() !== '' && !pastedImageOwnLink(data, phone)) files = files.filter((file) => !isGenericPasteName(file.name));
  if (files.length === 0) return [];
  const names = new Set(taken);
  return files.map((file) => {
    const name = pastedFileName(file, at, names);
    names.add(name);
    return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
}

export function clipboardHasText(data: Pick<DataTransfer, 'items' | 'types'> | null): boolean {
  if (!data) return false;
  for (const item of Array.from(data.items ?? [])) if (item.kind === 'string' && item.type.startsWith('text/')) return true;
  return Array.from(data.types ?? []).some((type) => type.startsWith('text/'));
}
