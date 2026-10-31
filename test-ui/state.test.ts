import { afterEach, expect, test, vi } from 'vitest';
import { scoped } from '../src/ui/scoped.ts';
import { Draft as LocalDraft } from '../src/ui/draft.ts';
import { createPacedDraftAction, draftWriteSchema, type DraftWrite } from '../src/ui/paced-write.ts';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

// Exercise the same command scheduler used by the authoring UI.
class Draft extends LocalDraft {
  readonly write;
  constructor(text: string, persist: (text: string) => Promise<unknown>, command?: (write: DraftWrite) => Promise<unknown>) {
    const writes = createPacedDraftAction(async write => {
      if (write.type === 'save') return persist(write.text);
      if (command) return command(write);
      throw new Error('Unexpected command');
    });
    super(text, text => writes({ type: 'save', text }));
    this.write = writes;
  }
}

test('draft saves remain ordered and old acknowledgements cannot mark newer text saved', async () => {
  const gate = deferred(), stored: string[] = [];
  const draft = new Draft('first', async text => { if (text === 'first') await gate.promise; stored.push(text); });
  const first = draft.save(); draft.edit('second'); const second = draft.save();
  await Promise.resolve(); expect(stored).toEqual([]);
  gate.resolve(); expect(await first).toBe(false); expect(await second).toBe(true);
  expect(stored).toEqual(['first', 'second']); expect(draft.text).toBe('second');
});

test('failed saves do not poison the queue and never clear local text', async () => {
  let fail = true, stored = '';
  const draft = new Draft('unsaved', async text => { if (fail) throw new Error('offline'); stored = text; });
  await expect(draft.save()).rejects.toThrow('offline'); expect(draft.text).toBe('unsaved');
  fail = false; expect(await draft.save()).toBe(true); expect(stored).toBe('unsaved');
});

test('repeated Save during a failed write cannot mark the optimistic text saved', async () => {
  const gate = deferred(), started = deferred();
  const draft = new Draft('unsaved', async () => {
    started.resolve(); await gate.promise; throw new Error('offline');
  });
  draft.edit('unsaved');
  const first = draft.save();
  await started.promise;
  const second = draft.save();
  const results = Promise.allSettled([first, second]);
  gate.resolve();
  expect((await results).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(draft.dirty).toBe(true);
  expect(draft.text).toBe('unsaved');
});

test('draft saves merge pending snapshots behind a held write', async () => {
  const gate = deferred(), started = deferred(), stored: string[] = [];
  let active = 0, maximum = 0;
  const draft = new Draft('first', async text => {
    active++; maximum = Math.max(maximum, active);
    if (text === 'first') { started.resolve(); await gate.promise; }
    stored.push(text); active--;
  });
  const first = draft.save();
  await started.promise;
  draft.edit('second'); const second = draft.save();
  draft.edit('third'); const third = draft.save();
  draft.edit('last'); const last = draft.save();
  expect(draft.dirty).toBe(true);
  gate.resolve();
  expect(await first).toBe(false);
  expect(await second).toBe(false);
  expect(await third).toBe(false);
  expect(await last).toBe(true);
  expect(stored).toEqual(['first', 'last']);
  expect(maximum).toBe(1);
  expect(draft.dirty).toBe(false);
});

test('composer creates once and merges pending text and kind', async () => {
  const gate = deferred(), started = deferred();
  let id: string | undefined;
  const requests: { id?: string; text: string; kind?: string }[] = [];
  const writes = createPacedDraftAction(async command => {
    if (command.type !== 'save') throw new Error('Unexpected command');
    requests.push({ id, text: command.text, kind: command.kind });
    if (!id) { started.resolve(); await gate.promise; id = 'created'; }
    return { id };
  });
  const first = writes({ type: 'save', text: 'first', kind: 'fragment' });
  await started.promise;
  const second = writes({ type: 'save', text: 'second', kind: 'fragment' });
  const last = writes({ type: 'save', text: 'last', kind: 'thread' });
  gate.resolve();
  expect((await Promise.all([first, second, last])).map(item => item.id)).toEqual(['created', 'created', 'created']);
  expect(requests).toEqual([
    { id: undefined, text: 'first', kind: 'fragment' },
    { id: 'created', text: 'last', kind: 'thread' },
  ]);
});

test('composer A to B to A during creation ends with A', async () => {
  const creating = deferred(), started = deferred();
  let creates = 0, server = '';
  const requests: string[] = [];
  const writes = createPacedDraftAction(async command => {
    if (command.type !== 'save') throw new Error('Unexpected command');
    requests.push(command.text);
    if (creates === 0) { creates++; started.resolve(); await creating.promise; }
    server = command.text;
    return { id: 'created' };
  });
  const first = writes({ type: 'save', text: 'A' });
  await started.promise;
  const second = writes({ type: 'save', text: 'B' });
  const last = writes({ type: 'save', text: 'A' });
  let saved = false;
  void last.then(() => { saved = true; });
  expect(saved).toBe(false);
  creating.resolve();
  await Promise.all([first, second, last]);
  expect(creates).toBe(1);
  expect(requests).toEqual(['A', 'A']);
  expect(server).toBe('A');
  expect(saved).toBe(true);
});

test('command schema rejects invalid input before persistence', () => {
  const persist = vi.fn(async () => {});
  const writes = createPacedDraftAction(persist);
  expect(() => writes({ type: 'generate', scope: -1 })).toThrow();
  expect(draftWriteSchema.safeParse({ type: 'restore', version: 0 }).success).toBe(false);
  expect(draftWriteSchema.safeParse({ type: 'save', text: 10 }).success).toBe(false);
  expect(draftWriteSchema.safeParse({ type: 'publish', note: '', generated: 'yes' }).success).toBe(false);
  expect(persist).not.toHaveBeenCalled();
});

test('commands cannot merge or be crossed by later saves', async () => {
  const gate = deferred(), started = deferred();
  const events: string[] = [];
  let active = 0, maximum = 0;
  const writes = createPacedDraftAction(async command => {
    active++; maximum = Math.max(maximum, active);
    const event = command.type === 'save' ? command.text : command.type;
    events.push(event);
    if (event === 'first') { started.resolve(); await gate.promise; }
    active--;
    return {};
  });
  const first = writes({ type: 'save', text: 'first' });
  await started.promise;
  const before = writes({ type: 'save', text: 'before' });
  const note = writes({ type: 'draft-note' });
  const generate1 = writes({ type: 'generate', scope: 0 });
  const generate2 = writes({ type: 'generate', scope: 0 });
  const after1 = writes({ type: 'save', text: 'intermediate' });
  const after2 = writes({ type: 'save', text: 'latest' });
  const restore = writes({ type: 'restore', version: 1 });
  const publish = writes({ type: 'publish', note: '', generated: false });
  const remove = writes({ type: 'delete' });
  gate.resolve();
  await Promise.all([first, before, note, generate1, generate2, after1, after2, restore, publish, remove]);
  expect(events).toEqual(['first', 'before', 'draft-note', 'generate', 'generate', 'latest', 'restore', 'publish', 'delete']);
  expect(maximum).toBe(1);
});

test('generation and text saves share one queue without replacing later local text', async () => {
  const gate = deferred(), writes: string[] = [];
  const draft = new Draft('first', async text => { writes.push(text); }, async () => { await gate.promise; writes.push('generated'); return { text: 'generated', contentMd: 'generated', model: 'test' }; });
  draft.edit('before generation'); await draft.save();
  const revision = draft.revision;
  const generated = draft.write({ type: 'generate', scope: 0 });
  draft.edit('typed during generation'); const saved = draft.save();
  gate.resolve(); const result = await generated;
  if (draft.revision === revision) draft.edit(result.contentMd);
  expect(await saved).toBe(true);
  expect(writes).toEqual(['before generation', 'generated', 'typed during generation']);
  expect(draft.text).toBe('typed during generation'); expect(draft.dirty).toBe(false);
});

test('generation waits for pending text and later saves remain behind generation', async () => {
  const saving = deferred(), saveStarted = deferred();
  const generating = deferred(), generationStarted = deferred();
  const writes: string[] = [];
  const draft = new Draft('first', async text => {
    if (text === 'first') { saveStarted.resolve(); await saving.promise; }
    writes.push(text);
  }, async () => {
    generationStarted.resolve(); await generating.promise; writes.push('generated');
  });
  const first = draft.save();
  await saveStarted.promise;
  draft.edit('before generation'); const before = draft.save();
  const generation = draft.write({ type: 'generate', scope: 0 });
  draft.edit('after generation'); const after = draft.save();
  saving.resolve();
  await generationStarted.promise;
  expect(writes).toEqual(['first', 'before generation']);
  generating.resolve();
  await Promise.all([first, before, generation, after]);
  expect(writes).toEqual(['first', 'before generation', 'generated', 'after generation']);
  expect(draft.dirty).toBe(false);
});

test('a failed command does not cancel a later save or command', async () => {
  const writes: string[] = [];
  const draft = new Draft('text', async text => { writes.push(text); }, async command => {
    if (command.type === 'generate') throw new Error('generation failed');
    writes.push('next operation');
  });
  const failed = draft.write({ type: 'generate', scope: 0 });
  const observed = expect(failed).rejects.toThrow('generation failed');
  draft.edit('retry text'); const saved = draft.save();
  const next = draft.write({ type: 'pin', version: 1 });
  await observed;
  expect(await saved).toBe(true);
  await next;
  expect(writes).toEqual(['retry text', 'next operation']);
});

test('resource cache evicts an old idle view without disposing the requested view', () => {
  vi.useFakeTimers();
  const created: { subscriberCount: number; status: string; cleanup: ReturnType<typeof vi.fn> }[] = [];
  const get = scoped(() => { const value = { subscriberCount: 0, status: 'ready', cleanup: vi.fn() }; created.push(value); return value; });
  for (let i = 0; i < 101; i++) get(String(i));
  expect(created[0].cleanup).toHaveBeenCalledOnce();
  expect(created[100].cleanup).not.toHaveBeenCalled();
  expect(created.filter(value => value.cleanup.mock.calls.length)).toHaveLength(1);
});
