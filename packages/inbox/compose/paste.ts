/**
 * Paste to attach (the owner: "I need to be able to paste in as well when
 * I'm in the new message or if I'm focused in a reply"). A paste that
 * carries files (a screenshot, an image copied from a page, a file copied
 * in the file manager where the browser hands it over) attaches them through
 * the same upload path as the paperclip. Text is never taken from the
 * browser: a paste of text alone is left wholly to its native path (nothing
 * prevented, nothing re-read later), and a paste that carries text beside
 * its files (an image copied from a page brings HTML, a file copied in the
 * file manager its name) attaches the files and still lets the browser
 * insert the text. Only a paste of files and no text is prevented.
 * Dictation apps (Hex) write the clipboard, post a synthetic paste and
 * restore the clipboard about 500 ms later, so everything here reads
 * `event.clipboardData` synchronously, inside the event, and never
 * `navigator.clipboard`. A clipboard image has no useful name ("image.png", "Pasted
 * Graphic.png", none at all), so it gets one: `pasted-image-2026-10-16-0912.png`.
 */

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

/** The names browsers and systems give a clipboard image: nothing a person chose. */
const GENERIC_NAME = /^(?:image|blob|pasted graphic(?: \d+)?|clipboard(?:[ -]?image)?|untitled)(?:\.[a-z0-9]+)?$/i;

const pad = (n: number) => String(n).padStart(2, '0');

/** `2026-10-16-0912` in the person's own time. */
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

/**
 * The name a pasted file is attached under: its own when it has a real one,
 * else `pasted-image-<stamp>.<ext>` (`pasted-file-…` for anything else), with
 * `-2`, `-3` added when the name is already taken in this message.
 */
/** A name nobody chose: what a browser or the system gives a clipboard picture (or none). */
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

/** The files a clipboard carries (none for a text paste). */
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

/** The clipboard's plain text, read synchronously ('' when it has none or cannot say). */
function plainText(data: Partial<Pick<DataTransfer, 'getData'>> | null): string {
  try {
    return typeof data?.getData === 'function' ? data.getData('text/plain') : '';
  } catch {
    return '';
  }
}

/**
 * The files of one paste, named for attaching. Empty: let the browser paste
 * the text. `taken`: the names already attached to this message.
 *
 * Text with an unnamed picture is text: a cell copied in Excel, Numbers or
 * Pages carries a rendering of itself, which Chromium hands over as a file
 * named `image.png`. When the clipboard has plain text, only files with a
 * real name attach (a file copied in Finder brings its name as the text); a
 * screenshot or Chrome's "Copy image" carries no plain text and attaches, and
 * on a phone, an image copied from a page, whose text is only its own
 * address (pastedImageOwnLink), attaches too.
 */
/** One of the clipboard's string types, read synchronously ('' when absent or unreadable). */
function stringOf(data: Partial<Pick<DataTransfer, 'getData'>> | null, type: string): string {
  try {
    return typeof data?.getData === 'function' ? data.getData(type) : '';
  } catch {
    return '';
  }
}

const decodeAttribute = (value: string) =>
  value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * An image copied from a page: the plain text is one http(s) address and the
 * HTML beside it is an `<img>` whose `src` is that same address. That text is
 * the picture's own link, not words the person meant to paste. Only a phone
 * takes the picture over the text (`phone`): there iOS Safari and Chrome on
 * Android carry the link beside the image; a desktop keeps today's rule, so a
 * spreadsheet cell holding a URL (its text, an HTML table and a picture of the
 * cell) still pastes as text everywhere.
 */
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

/**
 * Files a person chose with the attach button, named as a paste names them: a
 * photo the library hands over as `image.jpg` (iOS) gets `pasted-image-<stamp>.jpg`,
 * a real name is kept. `taken`: the names already attached to this message.
 */
export function chosenFiles(list: Iterable<File>, taken: Iterable<string>, at = new Date()): File[] {
  const files = [...list];
  const names = chosenFileNames(files, taken, at);
  return files.map((file, i) => (names[i] === file.name ? file : new File([file], names[i]!, { type: file.type, lastModified: file.lastModified })));
}

/** The names chosenFiles gives, in order. */
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

/** The clipboard carries text the browser would insert (plain or HTML): its native paste must run. */
export function clipboardHasText(data: Pick<DataTransfer, 'items' | 'types'> | null): boolean {
  if (!data) return false;
  for (const item of Array.from(data.items ?? [])) if (item.kind === 'string' && item.type.startsWith('text/')) return true;
  return Array.from(data.types ?? []).some((type) => type.startsWith('text/'));
}
