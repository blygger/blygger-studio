import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, test } from 'vitest';

// Render the real attachment rows, including their remove handler. Other editor
// panels are irrelevant to whether referenced draft bytes can be removed.
const source = ts.createSourceFile('authoring.tsx', readFileSync(new URL('../src/ui/authoring.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let rows: ts.CallExpression | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'item.media.map') rows = node;
  ts.forEachChild(node, visit);
}
visit(source);
if (!rows) throw new Error('Missing editor attachment rows');
const compiled = ts.transpileModule(`function attachments(item, text, action, write, mount) { return ${rows.getText(source)}; }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'jsx', jsxFragmentFactory: 'Fragment' },
}).outputText;
type Element = { type: unknown; props: Record<string, any>; children: unknown[] };
const jsx = (type: unknown, props: Record<string, any>, ...children: unknown[]): Element => ({ type, props: props ?? {}, children });
const attachments = new Function('jsx', 'Button', 'Fragment', `${compiled}; return attachments;`)(jsx, 'Button', 'Fragment');
function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!value || typeof value !== 'object' || !('children' in value)) return [];
  const element = value as Element;
  return [element, ...elements(element.children)];
}
function render(mount: string, text: string) {
  const calls: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const media = { id: 'draft-image', url: `https://example.test${mount}/media/draft-image.png`, mime: 'image/png', inline: true, alt: null };
  const result = attachments({ media: [media], publishedMedia: [] }, text,
    { busy: false, run(fn: () => Promise<unknown>) { const task = fn(); pending.push(task); return task; } },
    async (command: unknown) => { calls.push(command); }, mount);
  return { nodes: elements(result), calls, settle: () => Promise.all(pending) };
}
for (const mount of ['', '/notes/blyg']) {
  test.each([
    ['legacy relative', 'media/draft-image.png'],
    ['mounted path', `${mount}/media/draft-image.png`],
    ['canonical URL', `https://example.test${mount}/media/draft-image.png`],
  ])(`referenced %s attachment at ${mount || '/'} cannot be removed`, (_form, destination) => {
    const row = render(mount, `![draft](${destination})`);
    expect(row.nodes.filter(node => node.props['data-action'] === 'remove-media')).toEqual([]);
    expect(row.nodes.some(node => node.children.includes('in the text — delete its line to remove it'))).toBe(true);
    expect(row.calls).toEqual([]);
  });
  test(`unreferenced attachment at ${mount || '/'} can still be removed`, async () => {
    const row = render(mount, 'Draft without an image');
    const remove = row.nodes.filter(node => node.props['data-action'] === 'remove-media');
    expect(remove).toHaveLength(1);
    remove[0].props.onClick();
    await row.settle();
    expect(row.calls).toEqual([{ type: 'delete-media', mediaId: 'draft-image' }]);
  });
}
