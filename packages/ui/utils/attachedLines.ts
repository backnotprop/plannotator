import type { ImageAttachment } from '../types';

export function attachedLines(images: readonly ImageAttachment[] | undefined): string {
  const list = images ?? [];
  const pictures = list.filter((image) => image.kind !== 'file');
  const files = list.filter((image) => image.kind === 'file');
  let output = '';
  if (pictures.length > 0) output += `**Attached images:**\n${pictures.map((image) => `- [${image.name}] \`${image.path}\`\n`).join('')}`;
  if (files.length > 0) output += `**Attached files:**\n${files.map((file) => `- [${file.name}] \`${file.path}\`\n`).join('')}`;
  return output;
}
