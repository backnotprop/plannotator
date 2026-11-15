import { inboxUrl } from '../inboxUrl';
import { avatarMachine, pullUrl } from './pullMachines';

/** An author's picture, read on the machine whose list names them (a linked machine's, for an author only its PRs name). */
export const pullAvatarUrl = (host: string, login: string) => inboxUrl('/pulls/avatar', `host=${encodeURIComponent(host)}&login=${encodeURIComponent(login)}`, avatarMachine(host, login));

export const pullMediaUrl = (key: string, url: string) => pullUrl('/pulls/media', key, `url=${encodeURIComponent(url)}`);
