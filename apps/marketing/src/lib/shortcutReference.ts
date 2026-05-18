import { planReviewSurface, annotateSurface } from '../../../../packages/editor/shortcuts';
import { codeReviewSurface } from '../../../../packages/review-editor/shortcuts';
import { listRegistryShortcutSections } from '../../../../packages/ui/shortcuts';
import type { ShortcutSurface } from '../../../../packages/ui/shortcuts';

const slugify = (value: string) => value.toLowerCase().replace(/\s+/g, '-');

const allSurfaces: ShortcutSurface[] = [planReviewSurface, annotateSurface, codeReviewSurface];

export const shortcutReferenceSurfaces = allSurfaces.map((surface) => ({
  ...surface,
  sections: listRegistryShortcutSections(surface.registry).map((section) => ({
    ...section,
    slug: `${surface.slug}-${slugify(section.title)}`,
  })),
}));

export const shortcutReferenceHeadings = shortcutReferenceSurfaces.flatMap((surface) => [
  { depth: 2 as const, slug: surface.slug, text: surface.title },
  ...surface.sections.map((section) => ({ depth: 3 as const, slug: section.slug, text: section.title })),
]);
