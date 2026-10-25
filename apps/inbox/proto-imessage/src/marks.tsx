/**
 * The agent as a Messages contact: Halftone's Avatar holding the agent's real
 * brand mark (Plannotator's own marks, never Halftone's icons). The person is
 * not drawn (Messages never draws "me").
 */
import { Avatar } from '@halftone/design-system/primitives/avatar/avatar';
import { ClaudeIcon, CodexIcon, CursorIcon, OpenCodeIcon, PiIcon } from '@plannotator/ui/components/icons/AgentIcons';
import { Icon, type IconName } from '@inbox/icons';
import type { InboxAuthor } from '@plannotator/core/inbox-types';

function Mark({ host, className }: { host: string | null | undefined; className: string }) {
  switch (host) {
    case 'claude-code':
    case 'claude':
      return <ClaudeIcon className={className} />;
    case 'pi':
      return <PiIcon className={className} />;
    case 'opencode':
      return <OpenCodeIcon className={className} />;
    case 'codex':
      return <CodexIcon className={className} />;
    case 'cursor':
      return <CursorIcon className={className} />;
    default:
      return <Glyph name="code" className={className} />;
  }
}

export function Glyph({ name, className, size }: { name: IconName; className?: string; size?: number }) {
  return <Icon name={name} size={size} className={`proto-ic ${className ?? ''}`} />;
}

export type AvatarSize = 'lg' | 'xl' | '2xl' | '3xl' | '4xl';

const MARK: Record<AvatarSize, string> = { lg: 'size-4', xl: 'size-[18px]', '2xl': 'size-6', '3xl': 'size-7', '4xl': 'size-11' };

export function AgentAvatar({ author, size = '2xl', ring }: { author: InboxAuthor | null | undefined; size?: AvatarSize; ring?: 'stopped' | 'holding' | 'waiting' | null }) {
  const host = author?.kind === 'agent' ? author.host : null;
  const ringClass =
    ring === 'stopped'
      ? 'ring-2 ring-danger-solid ring-offset-2 ring-offset-shell'
      : ring === 'holding'
        ? 'ring-2 ring-warning-solid ring-offset-2 ring-offset-shell'
        : ring === 'waiting'
          ? 'ring-2 ring-brand-solid ring-offset-2 ring-offset-shell'
          : '';
  return (
    <Avatar shape="circle" size={size} className={`bg-component-on-container-strong ${ringClass}`}>
      <Avatar.Fallback className="text-primary-foreground">
        <Mark host={host} className={`${MARK[size]} object-contain`} />
      </Avatar.Fallback>
    </Avatar>
  );
}
