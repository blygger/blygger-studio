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
