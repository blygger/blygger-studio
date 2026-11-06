// Where an `@handle` is being typed. Same boundary rule as the publish-time
// resolver (src/contacts.ts): not after a word or URL character, so an email
// address or a `/@name` path opens nothing.
export interface HandleTrigger { start: number; end: number; query: string }

export function handleTrigger(text: string, caret: number): HandleTrigger | null {
  const m = /(^|[^\w@./:+-])@([A-Za-z0-9_-]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  const start = caret - m[2].length - 1;
  return { start, end: caret, query: m[2] };
}

export function handleInsert(text: string, trigger: HandleTrigger, handle: string): { text: string; caret: number } {
  const inserted = `@${handle} `;
  return { text: text.slice(0, trigger.start) + inserted + text.slice(trigger.end), caret: trigger.start + inserted.length };
}

/** A first guess at a handle: the name's first word, reduced to what a handle may hold. */
export function suggestHandle(name: string): string {
  const word = name.normalize('NFKD').trim().split(/\s+/)[0] ?? '';
  return word.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '').slice(0, 39);
}

/** Whether two contact URLs name the same place: case of the host and a trailing slash don't count. */
export function sameContactUrl(a: string, b: string): boolean {
  const key = (raw: string) => {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}${url.search}`;
    } catch {
      return raw;
    }
  };
  return key(a) === key(b);
}
