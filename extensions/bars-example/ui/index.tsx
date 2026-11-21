// The editor bar slot (docs/extensions.md, "Editor bars"). The template to copy for controls
// of your own in the composer and the full editor: a button that inserts at the caret, and,
// with held-out regions on (try it with regions-example), their show/hide control, which this
// bar replaces (docs/extensions.md, "Replaceable controls"): it renders that control only when
// context.bar.owns says it won the claim. It also marks every TODO in the text ("Editor
// marks"), and a click on one says so. It says where the Studio put it.
import { useEffect } from 'react';
import { toast, type EditorBarContext, type EditorMark, type StudioExtension } from '../../../src/ui/extension-api.ts';

function ExampleBar({ context }: { context: EditorBarContext }) {
  // Marks follow the text: made again whenever it changes. The Studio moves them with each edit meanwhile.
  useEffect(() => {
    const marks: EditorMark[] = [...context.shown.matchAll(/\bTODO\b/g)].map((m) => ({ start: m.index, end: m.index + 4, kind: 'note', title: 'a TODO' }));
    context.mark(marks, (mark) => toast(`TODO at ${mark.start}`));
  }, [context.shown]);
  return (
    <span data-bar-place={context.bar.place}>
      <button type="button" className="act" data-action="bar-insert" onClick={() => context.insert('※')}>
        insert ※
      </button>
      {context.regions && context.bar.owns.includes('regionToggle') ? (
        <button type="button" className="link-btn" data-action="bar-regions" onClick={() => (context.regions!.hidden ? context.regions!.show() : context.regions!.hide())}>
          {context.regions.hidden ? `show ${context.regions.labels.join(', ')}` : `hide ${context.regions.labels.join(', ')}`}
        </button>
      ) : null}
    </span>
  );
}

export const extension: StudioExtension = {
  name: 'bars-example',
  label: 'Editor bar example',
  description: 'Adds a bar above the editor’s text box: insert a mark at the cursor, show or hide held-out text, and underline every TODO. For trying editor bars and marks.',
  editorBar: { label: 'Example bar', row: 'above', blocks: 2, replaces: ['regionToggle'], component: ExampleBar },
};
