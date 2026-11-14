import { describe, expect, test } from 'bun:test';
import {
  contrastRatio,
  matchAuthorColor,
  parseAuthorColor,
  parseColorStyle,
  readableAuthorColor,
  stripAuthorColor,
  type Rgb,
} from './authorColor';

const css = (value: string) => parseAuthorColor(value)?.css ?? null;
const style = (value: string) => parseColorStyle(value)?.css ?? null;

describe('parseAuthorColor', () => {
  test('hex in every length, lowercased', () => {
    expect(css('#D00')).toBe('#d00');
    expect(css('#d00a')).toBe('#d00a');
    expect(css('#D00000')).toBe('#d00000');
    expect(css('#d0000080')).toBe('#d0000080');
    expect(parseAuthorColor('#d00000')!.rgba).toEqual([208, 0, 0, 1]);
    expect(css('#d0000')).toBeNull();
    expect(css('#ggg')).toBeNull();
  });

  test('rgb/rgba/hsl/hsla of plain numbers, rebuilt from the numbers', () => {
    expect(css('rgb(208,0,0)')).toBe('rgb(208, 0, 0)');
    expect(css('RGB( 208 , 0 , 0 )')).toBe('rgb(208, 0, 0)');
    expect(css('rgba(208, 0, 0, 0.5)')).toBe('rgba(208, 0, 0, 0.5)');
    expect(css('rgb(208 0 0 / 50%)')).toBe('rgba(208, 0, 0, 0.5)');
    expect(css('rgb(100%, 0%, 0%)')).toBe('rgb(255, 0, 0)');
    expect(css('rgb(999, -4, 0)')).toBe('rgb(255, 0, 0)');
    expect(css('hsl(30, 100%, 45%)')).toBe('hsl(30, 100%, 45%)');
    expect(css('hsla(390, 100%, 45%, .25)')).toBe('hsla(30, 100%, 45%, 0.25)');
    expect(parseAuthorColor('hsl(120, 100%, 25%)')!.rgba).toEqual([0, 128, 0, 1]);
  });

  test('named colours from the CSS list only', () => {
    expect(css('Crimson')).toBe('crimson');
    expect(css('rebeccapurple')).toBe('rebeccapurple');
    expect(css('transparent')).toBeNull();
    expect(css('currentcolor')).toBeNull();
    expect(css('canvastext')).toBeNull();
    expect(css('notacolour')).toBeNull();
  });

  test('refuses every other function and anything with a paren inside', () => {
    for (const bad of [
      'var(--x)',
      'url(//evil)',
      'expression(alert(1))',
      'calc(1px)',
      'rgb(calc(1),2,3)',
      'rgb(1,2,3))',
      'rgb(1,2,3',
      'rgb(1,2)',
      'rgb(1,2,3,4,5)',
      'rgb(1 2 3 4)',
      'rgb(1,2,3/0.5)',
      'rgb(1e3,0,0)',
      'hsl(30deg, 100%, 50%)',
      'hsl(30%, 100%, 50%)',
      'oklch(0.6 0.2 30)',
      'color(srgb 1 0 0)',
      'light-dark(red, blue)',
      'red !important',
      'red blue',
      '',
    ]) {
      expect([bad, css(bad)]).toEqual([bad, null]);
    }
  });

  test('a long value is refused unread', () => {
    expect(css(`#${'f'.repeat(10_000)}`)).toBeNull();
    expect(css(`${' '.repeat(100)}red`)).toBeNull();
  });
});

describe('parseColorStyle', () => {
  test('exactly one color declaration, any case and spacing, one trailing semicolon', () => {
    expect(style('color: #d00000')).toBe('#d00000');
    expect(style('color:#d00000;')).toBe('#d00000');
    expect(style('  COLOR :  RED ; ')).toBe('red');
    expect(style('color: rgb(0, 128, 0)')).toBe('rgb(0, 128, 0)');
  });

  test('refuses the style whole when anything else is in it', () => {
    for (const bad of [
      'color: red; background: url(//evil)',
      'color:red;position:fixed',
      'background: red',
      'background-color: red',
      'font-size: 40px',
      'color: red;;',
      'color: red !important',
      'color: expression(alert(1))',
      'color: var(--x)',
      'color: url(//evil)',
      'color: red /* c */',
      '/* x */ color: red',
      'c\\6f lor: red',
      'color: \\72 ed',
      'color: "red"',
      'color:',
      'color: red: blue',
      'x-color: red',
      'colorx: red',
      `color: ${'r'.repeat(10_240)}`,
      `color: red;${' '.repeat(10_240)}`,
    ]) {
      expect([bad.slice(0, 60), style(bad)]).toEqual([bad.slice(0, 60), null]);
    }
  });

  test('a trailing semicolon then spaces is still one declaration', () => {
    // `color: red; ` trims to `color: red;`
    expect(style('color: red; ')).toBe('red');
  });
});

describe('matchAuthorColor (the inline form)', () => {
  test('span with a style, font with a colour (quoted or bare), any case', () => {
    expect(matchAuthorColor('<span style="color: #d00000">73.0%</span> rest')).toMatchObject({ inner: '73.0%', length: 41 });
    expect(matchAuthorColor("<SPAN STYLE='COLOR:RED'>x</SPAN>")!.color!.css).toBe('red');
    expect(matchAuthorColor('<font color="#d00000">73.0%</font>')!.color!.css).toBe('#d00000');
    expect(matchAuthorColor('<font color=green>ok</font>')!.color!.css).toBe('green');
  });

  test('a refused colour keeps the words, uncoloured', () => {
    const run = matchAuthorColor('<span style="color: red; background: url(//evil)">x</span>');
    expect(run).toMatchObject({ color: null, inner: 'x' });
  });

  test('the closing tag balances nested runs of the same tag', () => {
    const run = matchAuthorColor('<span style="color: red">a <span style="color: blue">b</span> c</span> d');
    expect(run!.inner).toBe('a <span style="color: blue">b</span> c');
  });

  test('other attributes, no attribute, or no closing tag: not this form', () => {
    expect(matchAuthorColor('<span class="x">a</span>')).toBeNull();
    expect(matchAuthorColor('<span>a</span>')).toBeNull();
    expect(matchAuthorColor('<span style="color: red" onclick="x()">a</span>')).toBeNull();
    expect(matchAuthorColor('<span style="color: red" class="x">a</span>')).toBeNull();
    expect(matchAuthorColor('<font color="red" size="7">a</font>')).toBeNull();
    expect(matchAuthorColor('<font style="color: red">a</font>')).toBeNull();
    expect(matchAuthorColor('<div style="color: red">a</div>')).toBeNull();
    expect(matchAuthorColor('<span style="color: red">never closed')).toBeNull();
    expect(matchAuthorColor('<span style="color: red">a</font>')).toBeNull();
    expect(matchAuthorColor('<span style="color: red>">a</span>')).toBeNull();
  });
});

describe('stripAuthorColor', () => {
  test('a coloured run reads as its words; every other tag stays as written', () => {
    expect(stripAuthorColor('| <span style="color: #d00000">73.0%</span> | <font color=green>ok</font> |')).toBe('| 73.0% | ok |');
    expect(stripAuthorColor('<span style="color: red">a <font color="blue">b</font></span>')).toBe('a b');
    expect(stripAuthorColor('<span style="position: fixed">x</span>')).toBe('x');
    expect(stripAuthorColor('a <b>bold</b> <span>plain</span> `<x>`')).toBe('a <b>bold</b> <span>plain</span> `<x>`');
    expect(stripAuthorColor('<span style="color: red">open')).toBe('<span style="color: red">open');
  });
});

describe('readableAuthorColor', () => {
  const darkCard: Rgb = [30, 30, 36];
  const lightCard: Rgb = [255, 255, 255];
  const rgba = (value: string) => parseAuthorColor(value)!.rgba;

  test('a colour that is already readable is left as written', () => {
    expect(readableAuthorColor(rgba('#d00000'), lightCard)).toBeNull();
    expect(readableAuthorColor(rgba('#ff5555'), darkCard)).toBeNull();
    expect(readableAuthorColor(rgba('green'), lightCard)).toBeNull();
  });

  test('dark red on a dark card is lightened just to 3:1, hue kept', () => {
    const shifted = readableAuthorColor(rgba('#5a0000'), darkCard)!;
    expect(contrastRatio(shifted, darkCard)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(shifted, darkCard)).toBeLessThan(3.1);
    expect(shifted[0]).toBeGreaterThan(shifted[1]);
    expect(shifted[1]).toBe(shifted[2]);
  });

  test('yellow on white is darkened, hue kept', () => {
    const shifted = readableAuthorColor(rgba('yellow'), lightCard)!;
    expect(contrastRatio(shifted, lightCard)).toBeGreaterThanOrEqual(3);
    expect(shifted[0]).toBe(shifted[1]);
    expect(shifted[2]).toBe(0);
  });

  test('a faint colour comes back opaque and readable', () => {
    const shifted = readableAuthorColor(rgba('#d0000010'), lightCard)!;
    expect(shifted).toHaveLength(3);
    expect(contrastRatio(shifted, lightCard)).toBeGreaterThanOrEqual(3);
  });
});
