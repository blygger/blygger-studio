import { describe, expect, it } from 'vitest';
import { handleInsert, handleTrigger, sameContactUrl, suggestHandle } from '../src/ui/handle-trigger.ts';

const at = (text: string) => handleTrigger(text, text.length);

describe('handleTrigger', () => {
  it('opens on an @ at a word start, with the query so far', () => {
    expect(at('@')).toEqual({ start: 0, end: 1, query: '' });
    expect(at('Thanks to @ky')).toEqual({ start: 10, end: 13, query: 'ky' });
    expect(at('(@ky')?.query).toBe('ky');
  });
  it('stays shut for emails, URLs and finished handles', () => {
    for (const text of ['me@ky', 'https://social.example/@ky', '@a@b', '@ky ', 'plain']) expect(at(text)).toBeNull();
  });
  it('inserts the handle and a space, with the caret after it', () => {
    const text = 'hi @ky there';
    expect(handleInsert(text, { start: 3, end: 6, query: 'ky' }, 'kyle')).toEqual({ text: 'hi @kyle  there', caret: 9 });
  });
});

describe('suggestHandle', () => {
  it('takes the first word, reduced to what a handle holds', () => {
    expect(suggestHandle('Aneesh Sathe')).toBe('aneesh');
    expect(suggestHandle('José Ruiz')).toBe('jose');
    expect(suggestHandle('🚀 Rocket')).toBe('');
    expect(suggestHandle('')).toBe('');
  });
});

describe('sameContactUrl', () => {
  it('ignores host case and a trailing slash, and nothing else', () => {
    expect(sameContactUrl('https://A.example/blyg/', 'https://a.example/blyg')).toBe(true);
    expect(sameContactUrl('https://a.example/', 'https://a.example/blyg')).toBe(false);
    expect(sameContactUrl('not a url', 'not a url')).toBe(true);
  });
});
