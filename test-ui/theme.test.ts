import { expect, test } from 'vitest';
import { THEMES } from '../src/themes.ts';
import { THEME_VARS, themeAccent, themeIsDark, themeVars } from '../src/ui/theme.ts';

test('auto and unknown themes write nothing, leaving the stylesheet in charge', () => {
  expect(themeVars('auto')).toBeNull();
  expect(themeVars(undefined)).toBeNull();
  expect(themeVars('no-such-theme')).toBeNull();
});

test('every named theme fills every studio token from THEMES only', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    const vars = themeVars(name)!;
    expect(Object.keys(vars).sort()).toEqual([...THEME_VARS].sort());
    expect(vars).toMatchObject({ page: t.page, card: t.paper, ink: t.ink, 'ink-soft': t.inkSoft, rule: t.rule, pencil: t.pencil });
    expect(vars['on-pencil']).toBe(t.dark ? t.page : t.paper);
    expect(themeAccent(name, !t.dark)).toBe(t.pencil);
    expect(themeIsDark(name, !t.dark)).toBe(t.dark);
  }
});

test('Slate puts page text in the sheet colour, because its page is dark behind a light sheet', () => {
  const slate = themeVars('slate')!;
  expect(slate['page-ink']).toBe(THEMES.slate.paper);
  expect(slate.ink).toBe(THEMES.slate.ink);
  // A light page keeps ink on the page.
  expect(themeVars('cream')!['page-ink']).toBe(THEMES.cream.ink);
  // A dark theme is dark throughout: page text is its ink.
  expect(themeVars('nord')!['page-ink']).toBe(THEMES.nord.ink);
});

test('auto follows the device for its accent and scheme', () => {
  expect(themeAccent('auto', false)).toBe('#23608c');
  expect(themeAccent('auto', true)).toBe('#8cc0e4');
  expect(themeIsDark('auto', true)).toBe(true);
  expect(themeIsDark('auto', false)).toBe(false);
});

const CUSTOM = {
  dark: true,
  page: '#101418',
  paper: '#161b21',
  ink: '#e8edf2',
  inkSoft: '#a3adb8',
  rule: '#2a313a',
  pencil: '#f2a65a',
  genBg: '#1f262e',
  genRule: '#3a4450',
};

test('custom paints the studio from the author\'s palette', () => {
  const vars = themeVars('custom', CUSTOM)!;
  expect(Object.keys(vars).sort()).toEqual([...THEME_VARS].sort());
  expect(vars).toMatchObject({ page: CUSTOM.page, card: CUSTOM.paper, ink: CUSTOM.ink, pencil: CUSTOM.pencil });
  expect(vars['on-pencil']).toBe(CUSTOM.page);
  expect(themeAccent('custom', false, CUSTOM)).toBe(CUSTOM.pencil);
  expect(themeIsDark('custom', false, CUSTOM)).toBe(true);
});

test('custom without a palette behaves like auto', () => {
  expect(themeVars('custom', null)).toBeNull();
  expect(themeVars('custom')).toBeNull();
  expect(themeAccent('custom', true, null)).toBe('#8cc0e4');
});

const LIGHT = { ...CUSTOM, dark: false, page: '#eceef1', paper: '#f7f8fa', ink: '#1a1f27', pencil: '#c71585' };

test('a custom pair paints the studio from whichever palette the device prefers', () => {
  expect(themeVars('custom', LIGHT, CUSTOM, false)!.card).toBe('#f7f8fa');
  expect(themeVars('custom', LIGHT, CUSTOM, true)!.card).toBe(CUSTOM.paper);
  expect(themeIsDark('custom', false, LIGHT, CUSTOM)).toBe(false);
  expect(themeIsDark('custom', true, LIGHT, CUSTOM)).toBe(true);
  expect(themeAccent('custom', true, LIGHT, CUSTOM)).toBe(CUSTOM.pencil);
});
