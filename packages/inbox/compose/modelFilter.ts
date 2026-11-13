// Matching and ranking adapted from pi-tui's fuzzy.js and pi-coding-agent's model-search.js (MIT, https://github.com/earendil-works/pi).

const BOUNDARY = /[\s\-_./:]/;

function scorePositions(text: string, positions: readonly number[]): number {
  let score = 0;
  let last = -1;
  let run = 0;
  for (const i of positions) {
    if (last === i - 1) {
      run++;
      score -= run * 5;
    } else {
      run = 0;
      if (last >= 0) score += (i - last - 1) * 2;
    }
    if (i === 0 || BOUNDARY.test(text[i - 1]!)) score -= 10;
    score += i * 0.1;
    last = i;
  }
  return score;
}

function matchQuery(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  if (query.length > text.length) return null;
  const positions: number[] = [];
  let last = -1;
  for (const char of query) {
    const i = text.indexOf(char, last + 1);
    if (i === -1) return null;
    positions.push(i);
    last = i;
  }
  let score = scorePositions(text, positions);
  for (let start = text.indexOf(query); start !== -1; start = text.indexOf(query, start + 1)) {
    score = Math.min(score, scorePositions(text, positions.map((_, k) => start + k)));
  }
  return query === text ? score - 100 : score;
}

export function fuzzyModelScore(token: string, text: string): number | null {
  const query = token.toLowerCase();
  const lower = text.toLowerCase();
  const direct = matchQuery(query, lower);
  if (direct !== null) return direct;
  const swapped = /^([a-z]+)([0-9]+)$/.exec(query) ?? /^([0-9]+)([a-z]+)$/.exec(query);
  if (!swapped) return null;
  const other = matchQuery(`${swapped[2]}${swapped[1]}`, lower);
  return other === null ? null : other + 5;
}

export function modelSearchText(model: string): string {
  const at = model.indexOf('/');
  if (at <= 0) return model;
  const provider = model.slice(0, at);
  const id = model.slice(at + 1);
  return `${provider} ${provider}/${id} ${provider} ${id}`;
}

export function filterLaunchModels(models: readonly string[], query: string): string[] {
  const tokens = query.trim().split(/[\s/]+/).filter(Boolean);
  if (tokens.length === 0) return [...models];
  const found: { model: string; score: number }[] = [];
  for (const model of models) {
    const text = modelSearchText(model);
    let score = 0;
    let all = true;
    for (const token of tokens) {
      const one = fuzzyModelScore(token, text);
      if (one === null) {
        all = false;
        break;
      }
      score += one;
    }
    if (all) found.push({ model, score });
  }
  return found.sort((a, b) => a.score - b.score).map((entry) => entry.model);
}

export const LAUNCH_MODEL_FILTER_FROM = 9;
