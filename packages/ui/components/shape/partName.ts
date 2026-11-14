/** A part's short name: its heading if it has one, else its words, cut to fit a line. */
export function partName(el: Element): string {
  const named = el.querySelector('h1, h2, h3, h4, h5, h6, b, strong, .tt, .title, text');
  const words = (named?.textContent ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(words);
  return chars.length > 48 ? `${chars.slice(0, 47).join('').trimEnd()}…` : words;
}
