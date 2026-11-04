import { expect, test } from 'vitest';
import { studioTitle } from '../src/ui/tab.ts';
import { STUDIO_ICON_SVG, studioIconSvg } from '../src/studio-icon.ts';

test('the tab title names the blyg when it has a title', () => {
  expect(studioTitle('New Nature')).toBe('blyg studio — New Nature');
  expect(studioTitle('')).toBe('blyg studio');
  expect(studioTitle(undefined)).toBe('blyg studio');
});

test('the tab icon takes the accent behind and its own colour for the marks', () => {
  const svg = studioIconSvg('#b22222', '#fffaf0');
  expect(svg).toContain('fill="#b22222"');
  expect(svg).toContain('fill="#fffaf0"');
  // The default is the icon the PNGs were rasterised from.
  expect(studioIconSvg('#23608c', '#fafbfb')).toBe(STUDIO_ICON_SVG);
});
