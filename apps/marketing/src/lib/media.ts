// The site's videos are not in the repository: they live in the site's bucket
// at /assets/<name>, uploaded by hand, and the deploy's sync never deletes
// them (docs/agent-guides/project-and-development.md#marketing-site). The URL
// is absolute so `bun run dev` and `astro preview` play them too. Posters
// (small jpgs) stay in public/assets/ and keep their relative paths.
export const VIDEO_BASE_URL = 'https://plannotator.ai/assets';

export const videoUrl = (name: string): string => `${VIDEO_BASE_URL}/${name}`;
