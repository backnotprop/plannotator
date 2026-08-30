import { describe, expect, it } from 'bun:test';
import { buildSectionRefIndex, parseSectionRefs } from './sectionRefs';

const heading = (id: string, content: string) => ({ id, type: 'heading', content });
const para = (id: string, content: string) => ({ id, type: 'paragraph', content });

const DOC = [
  heading('b1', 'API 설계 초안'),
  heading('b2', '3.1 단일 진실 원천'),
  para('b3', '본문'),
  heading('b4', '개요'),
];

describe('buildSectionRefIndex', () => {
  it('indexes headings by their exact text', () => {
    const index = buildSectionRefIndex(DOC);
    expect(index.get('3.1 단일 진실 원천')).toBe('3-1-단일-진실-원천');
    expect(index.has('본문')).toBe(false);
  });

  it('drops a title shared by two headings rather than picking one', () => {
    const index = buildSectionRefIndex([
      heading('b1', '개요'),
      heading('b2', '개요'),
      heading('b3', '결론'),
    ]);
    expect(index.has('개요')).toBe(false);
    expect(index.has('결론')).toBe(true);
  });
});

describe('parseSectionRefs', () => {
  const index = buildSectionRefIndex(DOC);

  it('links a reference and leaves the trailing particle outside it', () => {
    const parts = parseSectionRefs('#3.1 단일 진실 원천의 전제와 충돌합니다', index);
    expect(parts).toEqual([
      { label: '3.1 단일 진실 원천', anchor: '3-1-단일-진실-원천' },
      '의 전제와 충돌합니다',
    ]);
  });

  it('links several references in one comment', () => {
    const parts = parseSectionRefs('#개요 와 #3.1 단일 진실 원천 비교', index);
    expect(parts.filter((p) => typeof p !== 'string')).toHaveLength(2);
  });

  it('takes the longest matching title', () => {
    const nested = buildSectionRefIndex([heading('a', '3.1'), heading('b', '3.1 단일 진실 원천')]);
    const parts = parseSectionRefs('#3.1 단일 진실 원천 참고', nested);
    expect(parts[0]).toEqual({ label: '3.1 단일 진실 원천', anchor: '3-1-단일-진실-원천' });
  });

  it('leaves text that matches no heading alone', () => {
    expect(parseSectionRefs('#fff 색상과 #123 이슈', index)).toEqual(['#fff 색상과 #123 이슈']);
  });

  it('ignores a hash welded to a word', () => {
    const csharp = buildSectionRefIndex([heading('a', '개요')]);
    expect(parseSectionRefs('C#개요 관련', csharp)).toEqual(['C#개요 관련']);
  });

  it('ignores a hash followed by a space, which is markdown heading intent', () => {
    expect(parseSectionRefs('# 개요', index)).toEqual(['# 개요']);
  });

  it('does not resolve references inside code spans', () => {
    expect(parseSectionRefs('`#개요` 는 코드', index)).toEqual(['`#개요` 는 코드']);
  });

  it('returns the original text when the document has no headings', () => {
    expect(parseSectionRefs('#개요', new Map())).toEqual(['#개요']);
  });
});
