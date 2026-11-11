const FONT_URLS: Record<string, string> = {
  'Red Hat Mono': 'https://fonts.googleapis.com/css2?family=Red+Hat+Mono:wght@300..700&display=swap',
  'Fira Code': 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@300..700&display=swap',
  'Atkinson Hyperlegible Mono': 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@200..700&display=swap',
  'Source Code Pro': 'https://fonts.googleapis.com/css2?family=Source+Code+Pro:wght@300..700&display=swap',
  'JetBrains Mono': 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300..700&display=swap',
  'IBM Plex Mono': 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300..700&display=swap',
  'Inconsolata': 'https://fonts.googleapis.com/css2?family=Inconsolata:wght@300..700&display=swap',
  'Roboto Mono': 'https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@300..700&display=swap',
  'Hack': 'https://cdn.jsdelivr.net/npm/hack-font@3/build/web/hack.css',
};

const loaded = new Set<string>();

export function loadDiffFont(fontFamily: string): void {
  if (!fontFamily || loaded.has(fontFamily)) return;
  // Own keys only: a typed custom name such as `constructor` or `__proto__`
  // must never resolve to something inherited from Object.prototype.
  if (!Object.hasOwn(FONT_URLS, fontFamily)) return;
  const url = FONT_URLS[fontFamily];
  if (typeof url !== 'string') return;

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.diffFont = fontFamily;
  document.head.appendChild(link);
  loaded.add(fontFamily);
}
