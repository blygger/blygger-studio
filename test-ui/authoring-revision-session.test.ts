import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';
import { Draft } from '../src/ui/draft.ts';
import { createPacedDraftAction } from '../src/ui/paced-write.ts';

// Run the actual component handlers with persistent hook slots. The Node UI
// suite has no DOM renderer; unrelated preview and sheet surfaces stay inert.
const source = ts.createSourceFile('authoring.tsx', readFileSync(new URL('../src/ui/authoring.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name: string) {
  const found = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!found) throw new Error(`Missing authoring function: ${name}`);
  return found;
}
type Node = { type: unknown; props: Record<string, any>; children: unknown[] };
function find(node: unknown, match: (node: Node) => boolean): Node {
  if (node && typeof node === 'object' && 'props' in node) {
    const element = node as Node;
    if (match(element)) return element;
    for (const child of element.children.flat(Infinity)) {
      try { return find(child, match); } catch { /* Search the next child. */ }
    }
  }
  throw new Error('Element not found');
}
function harness(component: 'ItemRow' | 'Editor') {
  const slots: any[] = [];
  let cursor = 0;
  let blocker: any;
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  const calls: { type: string; expectedRevision: number }[] = [];
  let revision = 1, text = 'original', factories = 0;
  let gate: Promise<void> | undefined;
  let holdAfterCommit = false;
  let entered: (() => void) | undefined;
  const action = {
    busy: false,
    run(fn: () => Promise<unknown>) {
      const promise = fn().catch(error => { errors.push(error); });
      pending.push(promise);
      return promise;
    },
    background(fn: () => Promise<unknown>) { return this.run(fn); },
  };
  const bindings = {
    Draft,
    useState(initial: any) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: any) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial: any) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useMemo(factory: () => unknown, deps: unknown[]) {
      const i = cursor++;
      if (!slots[i] || deps.some((dep, index) => dep !== slots[i].deps[index])) slots[i] = { deps, value: factory() };
      return slots[i].value;
    },
    useEffect() {},
    useSettings: () => null,
    useSharing: () => ({}),
    useAction: () => action,
    useNoteConfirm: () => ({}),
    useBlocker(value: unknown) { blocker = value; },
    createDraftAction(_id: string, observed: number) {
      factories++;
      return createPacedDraftAction(async command => {
        calls.push({ type: command.type, expectedRevision: observed });
        if (!holdAfterCommit) { entered?.(); await gate; }
        if (observed !== revision) throw Object.assign(new Error('revision conflict'), { statusCode: 409 });
        if (command.type === 'save') text = command.text;
        if (command.type === 'restore') text = 'restored';
        observed = ++revision;
        if (holdAfterCommit) { entered?.(); await gate; }
        return { revision, content_md: text };
      });
    },
    extractDirectives: (text: string) => ({ count: 0, withoutDirectives: text }),
    previewStrip: (text: string) => ({ text }), parseScopes: () => ({ scopes: [] }),
    renderMarkdown: (text: string) => text, previewFromHtml: (text: string) => ({ title: text, body: '' }),
    linkInline: () => /\[\[never\]\]/g,
    rowDot: () => 'public', formatDateIn: () => '',
    Button: 'Button', Link: 'Link', Html: 'Html', Help: 'Help', Failure: 'Failure', mount: '',
    jsx: (type: unknown, props: Record<string, any>, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    Fragment: 'Fragment',
    useNavigate: () => async () => {}, useLiveQuery: () => ({}), hoppers: {},
    stripStaleUploads: (text: string) => text, initiallyOpen: () => false,
    useUpload: () => ({}), useTextTools: () => ({}),
    confirm: async () => true,
  };
  const node = declaration(component);
  let code = node.getText(source);
  if (component === 'Editor') {
    // Keep initialization, navigation blocking, edits, and the real replacement
    // handlers. Rendering the editor's many independent panels adds no receiver.
    const end = node.body!.statements.find(statement => statement.getText(source).startsWith('const withdraw ='));
    if (!end) throw new Error('Missing Editor replacement boundary');
    code = source.text.slice(node.getStart(source), end.getStart(source)) + 'return { edit, restore }; }';
  }
  const compiled = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'jsx', jsxFragmentFactory: 'Fragment' } }).outputText;
  const renderComponent = new Function(...Object.keys(bindings), `${compiled}\nreturn ${component};`)(...Object.values(bindings));
  let item = { id: 'a', content_md: text, revision, kind: 'fragment', authored_kind: 'fragment', status: 'public', version: 1, dirty: false, media: [], published_media: [], pins: [], created: '', updated: '' };
  return {
    calls, errors,
    render() { cursor = 0; return renderComponent({ item, onPublished() {} }); },
    poll(content: string, next: number) { text = content; revision = next; item = { ...item, content_md: content, revision: next }; },
    lag() { item = { ...item, content_md: 'original', revision: 1 }; },
    block: () => blocker.shouldBlockFn(), beforeUnload: () => blocker.enableBeforeUnload(),
    settle: () => Promise.all(pending.splice(0)),
    hold(afterCommit = false) {
      let release!: () => void;
      holdAfterCommit = afterCommit;
      gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      return { started, release: () => { gate = undefined; holdAfterCommit = false; release(); } };
    },
    get text() { return text; }, get factories() { return factories; },
  };
}
function button(tree: unknown, text: string) { return find(tree, node => node.type === 'Button' && node.children.join('') === text); }
function expand(row: ReturnType<typeof harness>) { find(row.render(), node => node.props.className === 'item-head').props.onClick(); }
function toggle(row: ReturnType<typeof harness>) { find(row.render(), node => node.props['data-action'] === 'quick-edit').props.onClick(); }
function textarea(row: ReturnType<typeof harness>) { return find(row.render(), node => node.type === 'textarea'); }

test('a clean quick editor accepts fresh polled text and its matching revision together', async () => {
  const row = harness('ItemRow');
  expand(row);
  row.poll('foreign update', 2);
  toggle(row);
  expect(textarea(row).props.value).toBe('foreign update');
  textarea(row).props.onChange({ target: { value: 'edited fresh text' } });
  button(row.render(), 'save draft').props.onClick();
  await row.settle();
  expect(row.errors).toEqual([]);
  expect(row.calls).toEqual([{ type: 'save', expectedRevision: 2 }]);
  expect(row.text).toBe('edited fresh text');
});

test('reopening dirty quick text never grants it a foreign polled revision', async () => {
  const row = harness('ItemRow');
  expand(row); toggle(row);
  textarea(row).props.onChange({ target: { value: 'local unsaved text' } });
  row.poll('foreign update', 2);
  toggle(row); toggle(row);
  expect(textarea(row).props.value).toBe('local unsaved text');
  button(row.render(), 'save draft').props.onClick();
  await row.settle();
  expect(row.errors).toMatchObject([{ statusCode: 409 }]);
  expect(row.calls).toEqual([{ type: 'save', expectedRevision: 1 }]);
  expect(row.text).toBe('foreign update');
});

test('a clean closed row accepts its fresh baseline before pinning', async () => {
  const row = harness('ItemRow');
  expand(row);
  row.poll('foreign update', 2);
  await button(row.render(), 'pin v1…').props.onClick();
  await row.settle();
  expect(row.calls).toEqual([{ type: 'pin', expectedRevision: 2 }]);
  expect(row.errors).toEqual([]);
  expect(row.text).toBe('foreign update');
});

test('quick opening cannot replace a pending command queue or regress an acknowledged revision', async () => {
  const row = harness('ItemRow');
  expand(row);
  const held = row.hold(true);
  button(row.render(), 'pin v1…').props.onClick();
  await held.started;
  const factories = row.factories;
  // A poll can finish while the command's response is still pending. The clean
  // row must not start another queue from it, even if the text is unchanged.
  row.poll('original', 2);
  toggle(row);
  expect(row.factories).toBe(factories);
  textarea(row).props.onChange({ target: { value: 'queued text' } });
  const navigation = row.block();
  expect(row.calls).toHaveLength(1);
  held.release();
  await navigation;
  await row.settle();
  expect(row.errors).toEqual([]);
  expect(row.calls).toEqual([{ type: 'pin', expectedRevision: 1 }, { type: 'save', expectedRevision: 2 }]);
  row.lag(); toggle(row); toggle(row);
  expect(textarea(row).props.value).toBe('queued text');
  textarea(row).props.onChange({ target: { value: 'next text' } });
  button(row.render(), 'save draft').props.onClick();
  await row.settle();
  expect(row.calls.at(-1)).toEqual({ type: 'save', expectedRevision: 3 });
  expect(row.text).toBe('next text');
});

test('navigation blocks without queuing old-text autosave while restore replaces the editor', async () => {
  const editor = harness('Editor');
  editor.render().edit('old local text');
  const held = editor.hold();
  const restoring = editor.render().restore(1);
  await held.started;
  // The gate also applies before React commits the replacing-state render.
  expect(editor.beforeUnload()).toBe(true);
  const navigating = editor.block();
  // Let a mistakenly scheduled save reach the paced queue before restoring.
  await Promise.resolve();
  held.release();
  expect(await navigating).toBe(true);
  await restoring;
  expect(editor.calls).toEqual([{ type: 'restore', expectedRevision: 1 }]);
  expect(editor.text).toBe('restored');
  editor.render();
  expect(await editor.block()).toBe(false);
});

test('failed restore keeps local text and releases the navigation replacement gate', async () => {
  const editor = harness('Editor');
  editor.render().edit('local text');
  editor.poll('foreign update', 2);
  await expect(editor.render().restore(1)).rejects.toMatchObject({ statusCode: 409 });
  expect(editor.beforeUnload()).toBe(true);
  // A normal navigation attempt is now allowed to try saving the retained text;
  // it still has the old revision and must fail instead of overwriting polling.
  expect(await editor.block()).toBe(true);
  expect(editor.calls).toEqual([{ type: 'restore', expectedRevision: 1 }, { type: 'save', expectedRevision: 1 }]);
  expect(editor.text).toBe('foreign update');
});
