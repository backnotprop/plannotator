import { describe, expect, test } from 'bun:test';
import {
  inboxAttachmentKind,
  inboxAttachmentKindLabel,
  inboxAttachmentNameRefusal,
  isInboxAnnotatableKind,
  isInboxTextBytes,
  isInboxTextKind,
  readInboxAttachmentKind,
} from './inbox-attachments';

describe('Inbox attachment names and kinds', () => {
  test('source code and scripts are accepted as kind code', () => {
    for (const name of ['app.ts', 'run.sh', 'View.swift', 'build.mjs', 'main.py', 'lib.rs', 'Makefile', 'Dockerfile']) {
      expect(inboxAttachmentNameRefusal(`/repo/${name}`), name).toBeNull();
      expect(inboxAttachmentKind(`/repo/${name}`), name).toBe('code');
    }
  });

  test('a name both sets know keeps its existing kind', () => {
    expect(inboxAttachmentKind('/repo/package.json')).toBe('text');
    expect(inboxAttachmentKind('/repo/ci.yaml')).toBe('text');
    expect(inboxAttachmentKind('/repo/notes.md')).toBe('markdown');
    expect(inboxAttachmentKind('/repo/page.html')).toBe('html');
    expect(inboxAttachmentKind('/repo/flow.mmd')).toBe('mermaid');
  });

  test('the dotenv family is the one name refused; any other name is taken', () => {
    expect(inboxAttachmentNameRefusal('/repo/.env')).toContain('.env');
    // The dotenv family under any other name is refused too; the .env.example doc is not.
    expect(inboxAttachmentNameRefusal('/repo/.env.ts')).toContain('never attached');
    expect(inboxAttachmentNameRefusal('/repo/.env.local')).toContain('never attached');
    expect(inboxAttachmentNameRefusal('/repo/.env.local.sh')).toContain('never attached');
    expect(inboxAttachmentNameRefusal('/repo/.ENV.Production.py')).toContain('never attached');
    expect(inboxAttachmentNameRefusal('/repo/.env.example')).toBeNull();
    for (const name of ['logo.png', 'spec.pdf', 'app.exe', 'fixtures.zip', 'clip.mov', 'README']) {
      expect(inboxAttachmentNameRefusal(`/repo/${name}`), name).toBeNull();
    }
  });

  test('a kind a reader does not know is a file (a download)', () => {
    expect(readInboxAttachmentKind('image')).toBe('image');
    expect(readInboxAttachmentKind('video')).toBe('file');
    expect(readInboxAttachmentKind(undefined)).toBe('file');
    expect(isInboxTextKind('code')).toBe(true);
    expect(isInboxTextKind('image')).toBe(false);
    expect(isInboxTextKind('video')).toBe(false);
    expect(isInboxAnnotatableKind('image')).toBe(true);
    expect(isInboxAnnotatableKind('code')).toBe(true);
    expect(isInboxAnnotatableKind('pdf')).toBe(false);
    expect(isInboxAnnotatableKind('video')).toBe(false);
    expect(inboxAttachmentKindLabel('video', 'clip.mov')).toBe('MOV file');
    expect(inboxAttachmentKindLabel('image', 'shot.png', 'image/png')).toBe('PNG image');
    expect(inboxAttachmentKindLabel('pdf', 'spec.pdf')).toBe('PDF');
  });

  test('the tile names a code file by its extension, or its name when it has none', () => {
    expect(inboxAttachmentKindLabel('code', 'app.TS')).toContain('.ts');
    expect(inboxAttachmentKindLabel('code', 'Makefile')).toContain('Makefile');
  });

  test('text bytes: UTF-8 without NUL passes; NUL or invalid UTF-8 does not', () => {
    expect(isInboxTextBytes(new TextEncoder().encode('echo "héllo"\n'))).toBe(true);
    expect(isInboxTextBytes(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))).toBe(false);
    expect(isInboxTextBytes(new Uint8Array([0x66, 0xff, 0xfe, 0x67]))).toBe(false);
    expect(isInboxTextBytes(new Uint8Array())).toBe(true);
  });
});
