/**
 * A routine's name in an agent's change line, as the window draws it (core `routineLineText`, written into the lines
 * by packages/server/inbox-scheduled.ts). The failures these guard: a name drawn as a picture, a tag, a link, a
 * mention or an issue ref, and a name that does not read as it was typed (character references or backslashes shown).
 */
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { routineLineText } from '@plannotator/core/inbox-scheduled';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { findBarePaths } from '../fileRefs';

const NAMES = ['Deps: weekly', "@maya's sweep", 'snake_case_name', '2 * 3 * 4', 'Scan <img src=scan.png>', 'Scan ![x](/p.png)', 'Fix #123 now', 'See https://e.co', 'a `tick` and ``two``', '`edge`'];

/** The lines a change writes with a name in them, as inbox-scheduled.ts writes them. */
const linesOf = (name: string) => [
  `Made the routine [${routineLineText(name.replace(/[[\]]/g, ''))}](#routine=sch_1), which runs only when someone runs it.`,
  `Renamed the routine [Plain](#routine=sch_1). Its name was ${routineLineText(name)}.`,
  `Deleted the routine ${routineLineText(name)}. Its thread and past runs stay.`,
];

/** The text of drawn HTML, as the person reads it. */
const textOf = (html: string) =>
  html.replace(/<[^>]*>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

describe("a routine's name in a change line, in the window", () => {
  test('reads as typed, and is no picture, tag, link, mention or issue ref (with a repository, so #123 and @maya could link)', () => {
    for (const name of NAMES) {
      for (const line of linesOf(name)) {
        const html = renderToStaticMarkup(<InlineMarkdown text={line} githubRepo="acme/api" />);
        const tags = html.match(/<(img|a|script|iframe)\b[^>]*>/g) ?? [];
        expect([name, tags.filter((tag) => !tag.includes('href="#routine=sch_1"'))]).toEqual([name, []]);
        // A link's words drop [ and ] (as on main: they would end the link), and read as typed otherwise.
        const words = line.startsWith('Made') ? name.replace(/[[\]]/g, '') : name;
        expect([name, textOf(html).includes(words)]).toEqual([name, true]);
      }
    }
  });

  test('a plain name or folder, written as it is (as on main), draws as its words only: no code, emphasis, strikethrough, link or picture', () => {
    const PLAIN = ["Maya's triage", 'Morning triage', 'Dependency check', '.,’-–—()+?', 'Weekly sync v2.1', 'follow-up (daily)', 'What changed?', '🚀 Deploy check', 'Café crème', '毎朝のトリアージ', 'हिन्दी रिपोर्ट'];
    const FOLDERS = ["~/maya's app", '~/acme-web', '~/code/my-app_v2', '~/projects/snake__case', '/srv/apps/acme web', '~/linear/ENG-42'];
    const lines = [
      ...PLAIN.flatMap((name) => linesOf(name).map((line) => ({ line, words: name }))),
      ...FOLDERS.map((folder) => ({ line: `It now works in ${routineLineText(folder, 'path')} (was ${routineLineText('~/acme-api', 'path')}).`, words: folder })),
    ];
    for (const { line, words } of lines) {
      expect([line, line.includes('`')]).toEqual([line, false]);
      // No bare path the Inbox's window opens as a file (its BarePathContext).
      expect([line, findBarePaths(line)]).toEqual([line, []]);
      const html = renderToStaticMarkup(<InlineMarkdown text={line} githubRepo="acme/api" />);
      const tags = html.match(/<(img|a|code|em|strong|del|script|iframe)\b[^>]*>/g) ?? [];
      expect([line, tags.filter((tag) => !tag.includes('href="#routine=sch_1"'))]).toEqual([line, []]);
      // The window's smart quotes draw ' as ‘ or ’, as on main: only how it looks (the line itself keeps ').
      const quotes = (text: string) => text.replace(/[‘’]/g, "'");
      expect([line, quotes(textOf(html)).includes(quotes(words))]).toEqual([line, true]);
    }
  });
});
