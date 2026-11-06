import { describe, expect, it } from 'vitest';
import { handleInsert, handleTrigger } from '../src/ui/handle-trigger.ts';

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
