import { expect, test } from 'vitest';
import { parseShared } from '../src/ui/theme-editor.tsx';

const P = { page: '#eceef1', paper: '#f7f8fa', ink: '#1a1f27', inkSoft: '#536049', rule: '#c9cfc0', pencil: '#c71585', genBg: '#efe9fc', genRule: '#9850eb' };
const D = { page: '#12161c', paper: '#1a1f27', ink: '#e8eaee', inkSoft: '#a9b79c', rule: '#313b2d', pencil: '#f06bb8', genBg: '#2a2140', genRule: '#7b5cf0' };

test('imports a single palette', () => {
  const r = parseShared(JSON.stringify({ dark: false, ...P }));
  expect('light' in r && r.dark).toBeNull();
});

test('imports a light/dark pair', () => {
  const r = parseShared(JSON.stringify({ light: { dark: false, ...P }, dark: { dark: true, ...D } }));
  expect('light' in r && r.dark?.paper).toBe('#1a1f27');
});

test('refuses bad JSON, bad colours and incoherent pairs', () => {
  expect(parseShared('{nope')).toEqual({ error: 'That is not valid JSON.' });
  expect('error' in parseShared(JSON.stringify({ dark: false, ...P, ink: 'red' }))).toBe(true);
  expect('error' in parseShared(JSON.stringify({ light: { dark: true, ...P }, dark: { dark: true, ...D } }))).toBe(true);
  expect('error' in parseShared(JSON.stringify({ light: { dark: false, ...P }, extra: 1 }))).toBe(true);
});
