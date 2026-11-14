import { inboxUrl } from '../inboxUrl';

export const pullAvatarUrl = (host: string, login: string) => inboxUrl('/pulls/avatar', `host=${encodeURIComponent(host)}&login=${encodeURIComponent(login)}`);

export const pullMediaUrl = (key: string, url: string) => inboxUrl('/pulls/media', `key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`);
