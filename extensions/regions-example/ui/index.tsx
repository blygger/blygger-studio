// The editor regions slot (docs/extensions.md). The template to copy for keeping generated
// lines out of the author's way: any paragraph that starts with `[held]: #` is held out of
// the full editor's text box, with the blank line before it, so text typed where it was
// cut joins the paragraph above.
import type { EditorRegion, StudioExtension } from '../../../src/ui/extension-api.ts';

export const extension: StudioExtension = {
  name: 'regions-example',
  label: 'Held-out paragraphs example',
  description: 'Hides paragraphs that start with [held]: # in the full editor, read-only when shown. For trying editor regions.',
  editorRegions: ({ text }) => {
    const regions: EditorRegion[] = [];
    for (const match of text.matchAll(/(?:^|\n\n)\[held\]: #[\s\S]*?(?=\n\n|$)/g))
      regions.push({ start: match.index, end: match.index + match[0].length, label: 'held paragraph' });
    return regions;
  },
};
