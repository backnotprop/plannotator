/**
 * The window's icons: Heroicons outline paths (the set Plannotator draws
 * with), as the design of record uses them, and the agent marks from
 * @plannotator/ui.
 */

import type React from 'react';
import { ClaudeIcon, CodexIcon, CursorIcon, OpenCodeIcon, PiIcon } from '@plannotator/ui/components/icons/AgentIcons';
import type { InboxAuthor } from '@plannotator/core/inbox-types';

const PATHS = {
  inbox:
    'M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z',
  settings:
    'M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75',
  diamond: 'M12 3.5 20.5 12 12 20.5 3.5 12Z',
  chevR: 'm8.25 4.5 7.5 7.5-7.5 7.5',
  chevD: 'm19.5 8.25-7.5 7.5-7.5-7.5',
  clip: 'm18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13',
  doc: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
  x: 'M6 18 18 6M6 6l12 12',
  archive:
    'm20.25 7.5-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z',
  reply: 'M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3',
  compose:
    'm16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10',
  send: 'M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5',
  code: 'M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5',
  diagram:
    'M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 0 1-1.125-1.125v-3.75ZM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-8.25ZM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 0 1-1.125-1.125v-2.25Z',
  restart:
    'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99',
  dots: 'M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM12.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM18.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z',
  book: 'M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25',
  bell: 'M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0',
  info: 'm11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z',
  check: 'm4.5 12.75 6 6 9-13.5',
  folder:
    'M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z',
  external: 'M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size, className }: { name: IconName; size?: number; className?: string }) {
  const style = size ? ({ width: size, height: size } as React.CSSProperties) : undefined;
  return (
    <svg className={`ib-ic${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" style={style} aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Monochrome tab glyphs for the harness picker (the record's, in the muted colour). */
const TAB_GLYPHS: Partial<Record<string, string>> = {
  cursor: 'M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5Z M12 12l8.5-4.75 M12 12v9.5 M12 12 3.5 7.25',
  vscode: 'M17 3.5 7.5 12l9.5 8.5 3.5-1.7V5.2Z M17 3.5v17 M7.5 12 3.5 9 M7.5 12 3.5 15',
  gemini: 'M12 2.5c.9 5 3.6 8.6 9.5 9.5-5.9.9-8.6 4.5-9.5 9.5-.9-5-3.6-8.6-9.5-9.5 5.9-.9 8.6-4.5 9.5-9.5Z',
  zed: 'M4 4h16v16H4Z M8 8.5h8l-8 7h8',
};

export function TabGlyph({ harness }: { harness: string }) {
  if (harness === 'codex') return <CodexIcon className="ib-tglyph ib-img" />;
  const d = TAB_GLYPHS[harness];
  if (!d) return null;
  return (
    <svg className="ib-tglyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

/** The mark for an agent host: the real brand marks for the hosts ui carries, a neutral glyph otherwise. */
export function HostMark({ host, big }: { host: string | null | undefined; big?: boolean }) {
  let mark: React.ReactNode;
  switch (host) {
    case 'claude-code':
    case 'claude':
      mark = <ClaudeIcon />;
      break;
    case 'pi':
      mark = <PiIcon />;
      break;
    case 'opencode':
      mark = <OpenCodeIcon />;
      break;
    case 'codex':
      mark = <CodexIcon />;
      break;
    case 'cursor':
      mark = <CursorIcon />;
      break;
    default:
      mark = <Icon name="code" />;
  }
  return <span className={`ib-mk${big ? ' ib-big' : ''}`}>{mark}</span>;
}

export function AuthorMark({ author, big }: { author: InboxAuthor | null | undefined; big?: boolean }) {
  return <HostMark host={author?.kind === 'agent' ? author.host : null} big={big} />;
}

/** The record's decision diamond (16-unit box), as the Decisions page and the card draw it. */
export function DecisionDiamond({ className }: { className?: string }) {
  return (
    <svg className={`ib-dm${className ? ` ${className}` : ''}`} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.8 14.2 8 8 14.2 1.8 8Z" />
    </svg>
  );
}
