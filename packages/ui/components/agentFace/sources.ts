export interface AgentFaceSetLook {
  pixelated?: boolean;
  size?: number;
  mono?: boolean;
  zoom?: number;
}

export interface AgentFaceSetDrawing {
  set: string;
  icon: string;
  src: string;
  look: AgentFaceSetLook | null;
}

export interface AgentFaceSources {
  ownIconSrc: (face: string, still: boolean) => string;
  setFaceDrawing: (face: string) => AgentFaceSetDrawing | null;
  setArtStyle: (look: AgentFaceSetLook | null, src: string | null) => Record<string, string>;
}

const NONE: AgentFaceSources = {
  ownIconSrc: () => '',
  setFaceDrawing: () => null,
  setArtStyle: () => ({}),
};

let sources: AgentFaceSources = NONE;

export function setAgentFaceSources(next: AgentFaceSources | null | undefined): void {
  sources = next ?? NONE;
}

export function ownIconSrc(face: string, still: boolean): string {
  return sources.ownIconSrc(face, still);
}

export function setFaceDrawing(face: string): AgentFaceSetDrawing | null {
  return sources.setFaceDrawing(face);
}

export function setArtStyle(look: AgentFaceSetLook | null, src: string | null): Record<string, string> {
  return sources.setArtStyle(look, src);
}
