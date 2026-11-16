import { FileCode, Film, Network, Workflow } from "lucide-react";
import type { ComponentType } from "react";

export type FileGlyph = ComponentType<{ className?: string }>;

interface GlyphPath {
  readonly d: string;
  readonly evenOdd?: true;
  readonly transform?: string;
  readonly stroke?: number;
}

function glyph(name: string, paths: readonly GlyphPath[]): FileGlyph {
  function Glyph({ className }: { className?: string }) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        data-file-glyph={name}
        className={className}
      >
        {paths.map((part) => (
          <path
            key={`${part.transform ?? ""}${part.d}`}
            fill={part.stroke === undefined ? "currentColor" : "none"}
            stroke={part.stroke === undefined ? undefined : "currentColor"}
            strokeWidth={part.stroke}
            fillRule={part.evenOdd === true ? "evenodd" : undefined}
            clipRule={part.evenOdd === true ? "evenodd" : undefined}
            transform={part.transform}
            d={part.d}
          />
        ))}
      </svg>
    );
  }
  Glyph.displayName = `FileGlyph(${name})`;
  return Glyph;
}

const MarkdownIcon = glyph("markdown", [
  { d: "M0 12V4h2l2.5 2.5L7 4h2v8H7V7.5l-2.5 2-2.5-2V12zm10-3.5 3 3.5 3-3.5h-2V4h-2v4.5z" },
]);

const ImageIcon = glyph("image", [
  { d: "M5.5 4a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3" },
  {
    d: "M12.5 2A2.5 2.5 0 0 1 15 4.5v7a2.5 2.5 0 0 1-2.5 2.5h-9A2.5 2.5 0 0 1 1 11.5v-7A2.5 2.5 0 0 1 3.5 2zm-9 1A1.5 1.5 0 0 0 2 4.5v6.92L4.5 8.5 7 11l3.5-4.5L14 10V4.5A1.5 1.5 0 0 0 12.5 3z",
    evenOdd: true,
  },
]);

const FileTextIcon = glyph("file-text", [
  { d: "M8.5 11a.5.5 0 0 1 0 1h-3a.5.5 0 0 1 0-1zm2-2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1z" },
  {
    d: "M9.5 1a.5.5 0 0 1 .35.15l4 4a.5.5 0 0 1 .15.35v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 12.5v-9A2.5 2.5 0 0 1 4.5 1zm-5 1A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6h-2a2 2 0 0 1-2-2V2z",
    evenOdd: true,
  },
]);

const FileTableIcon = glyph("file-table", [
  {
    d: "M9.501 1c.132 0 .26.053.353.146l4 4a.5.5 0 0 1 .147.354v7a2.5 2.5 0 0 1-2.5 2.5h-7c-1.38 0-2.5-1.12-2.501-2.5v-9C2 2.12 3.12 1 4.501 1zm-5 1a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V6h-2a2 2 0 0 1-2-2V2zM11.5 8a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-4a.5.5 0 0 1 .5-.5zM5 12h2.5v-1H5zm3.5 0H11v-1H8.5zM5 10h2.5V9H5zm3.5 0H11V9H8.5z",
  },
]);

const BracesIcon = glyph("braces", [
  {
    d: "M13.25 11.5V9.75a.5.5 0 0 1 .36-.48l.55-.15a1.16 1.16 0 0 0 0-2.24l-.55-.15a.5.5 0 0 1-.36-.48V4.5a2.5 2.5 0 0 0-2.5-2.5h-.25a.5.5 0 0 0 0 1h.25a1.5 1.5 0 0 1 1.5 1.5v1.75a1.5 1.5 0 0 0 1.09 1.44l.54.15a.16.16 0 0 1 0 .32l-.54.15a1.5 1.5 0 0 0-1.09 1.44v1.75a1.5 1.5 0 0 1-1.5 1.5h-.25a.5.5 0 0 0 0 1h.25a2.5 2.5 0 0 0 2.5-2.5m-10.5 0V9.75a.5.5 0 0 0-.36-.48l-.55-.15a1.16 1.16 0 0 1 0-2.24l.55-.15a.5.5 0 0 0 .36-.48V4.5A2.5 2.5 0 0 1 5.25 2h.25a.5.5 0 0 1 0 1h-.25a1.5 1.5 0 0 0-1.5 1.5v1.75a1.5 1.5 0 0 1-1.09 1.44l-.54.15a.16.16 0 0 0 0 .32l.54.15a1.5 1.5 0 0 1 1.09 1.45v1.74a1.5 1.5 0 0 0 1.5 1.5h.25a.5.5 0 0 1 0 1h-.25a2.5 2.5 0 0 1-2.5-2.5",
  },
]);

const FileZipIcon = glyph("file-zip", [
  {
    d: "M7 9s.5 1.017.5 1.9c0 .884-.672 1.6-1.5 1.6s-1.5-.716-1.5-1.6c0-.883.5-1.9.5-1.9h1V8h1zM6 8H5V7h1zm1-1H6V6h1zM6 6H5V5h1zm1-1H6V4h1zM6 4H5V3h1z",
  },
  {
    d: "M9.501 1c.132 0 .26.053.353.146l4 4a.5.5 0 0 1 .147.354v7a2.5 2.5 0 0 1-2.5 2.5h-7c-1.38 0-2.5-1.12-2.501-2.5v-9C2 2.12 3.12 1 4.501 1zm-5 1a1.5 1.5 0 0 0-1.5 1.5v9a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V6h-2a2 2 0 0 1-2-2V2H7v1H6V2z",
    evenOdd: true,
  },
]);

const FolderIcon = glyph("folder", [
  {
    d: "M4.59 2a2 2 0 0 1 1.02.28l1.8 1.08a1 1 0 0 0 .5.14H12a2 2 0 0 1 2 2V12a2 2 0 0 1-2 2H2a2 2 0 0 1-.4-.04A2 2 0 0 1 0 12V4a2 2 0 0 1 2-2zM2 3a1 1 0 0 0-1 1v2h12v-.5a1 1 0 0 0-1-1H7.92a2 2 0 0 1-1.03-.28l-1.8-1.08A1 1 0 0 0 4.6 3z",
    evenOdd: true,
  },
]);

const FolderOpenIcon = glyph("folder-open", [
  {
    d: "M4.59 2a2 2 0 0 1 1.02.28l1.8 1.08a1 1 0 0 0 .5.14h4.1a2 2 0 0 1 2 2V6h.25a1.5 1.5 0 0 1 1.43 1.93l-1.39 4.65A2 2 0 0 1 12.38 14H2a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM2 3a1 1 0 0 0-1 1v5.93l.81-2.84A1.5 1.5 0 0 1 3.25 6H13v-.5a1 1 0 0 0-1-1H7.92a2 2 0 0 1-1.03-.28L5.1 3.14A1 1 0 0 0 4.59 3z",
    evenOdd: true,
  },
]);

const FileIcon = glyph("file", [
  {
    d: "M9.5 1a.5.5 0 0 1 .35.15l4 4a.5.5 0 0 1 .15.35v7a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 12.5v-9A2.5 2.5 0 0 1 4.5 1zm-5 1A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6h-2a2 2 0 0 1-2-2V2z",
    evenOdd: true,
  },
]);

export { FolderIcon, FolderOpenIcon };

const VideoIcon: FileGlyph = Film;
const HtmlIcon: FileGlyph = FileCode;
const MermaidIcon: FileGlyph = Workflow;
const GraphvizIcon: FileGlyph = Network;

export type FileIconKind = "markdown" | "image" | "pdf" | "video" | "html" | "mermaid" | "graphviz" | (string & {});

const KIND_GLYPH: Partial<Record<FileIconKind, FileGlyph>> = {
  markdown: MarkdownIcon,
  image: ImageIcon,
  pdf: FileTextIcon,
  video: VideoIcon,
  html: HtmlIcon,
  mermaid: MermaidIcon,
  graphviz: GraphvizIcon,
};

const EXTENSION_GLYPH: Readonly<Record<string, FileGlyph>> = {
  md: MarkdownIcon,
  markdown: MarkdownIcon,
  png: ImageIcon,
  jpg: ImageIcon,
  jpeg: ImageIcon,
  gif: ImageIcon,
  webp: ImageIcon,
  avif: ImageIcon,
  bmp: ImageIcon,
  ico: ImageIcon,
  heic: ImageIcon,
  pdf: FileTextIcon,
  mp4: VideoIcon,
  mov: VideoIcon,
  webm: VideoIcon,
  m4v: VideoIcon,
  mkv: VideoIcon,
  csv: FileTableIcon,
  tsv: FileTableIcon,
  json: BracesIcon,
  jsonc: BracesIcon,
  json5: BracesIcon,
  zip: FileZipIcon,
  tar: FileZipIcon,
  gz: FileZipIcon,
  tgz: FileZipIcon,
  rar: FileZipIcon,
  "7z": FileZipIcon,
  html: HtmlIcon,
  htm: HtmlIcon,
  mmd: MermaidIcon,
  mermaid: MermaidIcon,
  dot: GraphvizIcon,
  gv: GraphvizIcon,
};

function extensionOf(path: string | undefined): string | null {
  if (path === undefined) return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function fileIcon(input: { kind?: FileIconKind; path?: string }): FileGlyph {
  const byKind = input.kind === undefined ? undefined : KIND_GLYPH[input.kind];
  if (byKind !== undefined) return byKind;
  const extension = extensionOf(input.path);
  if (extension === null) return FileIcon;
  return EXTENSION_GLYPH[extension] ?? FileIcon;
}
