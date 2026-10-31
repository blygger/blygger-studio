/*
 * The example extension: one of each slot, doing nothing that matters.
 * It is the template to copy (docs/extensions.md) and what the test suites
 * enable to check the slots. It has no server half; see lineage-glyph for one.
 */
import { useEffect, useState } from 'react';
import { BlyggerApi, Button, Sheet, unwrap } from '../../../src/ui/extension-api.ts';
import type { EntryContext, StudioContext, StudioExtension } from '../../../src/ui/extension-api.ts';

function aboutSheet(context: EntryContext) {
  return (close: () => void) => (
    <Sheet open onClose={close} title="example extension">
      <p data-extension-sheet="example">
        {context.entry.kind} · {context.imported ? context.imported.subscriptionId : 'yours'} · {context.id}
      </p>
      {context.actions.linkPost ? (
        <Button
          className="btn btn-ghost btn-mini"
          onClick={() => {
            close();
            context.actions.linkPost!();
          }}
        >
          link post ↗ (the Studio's own action)
        </Button>
      ) : null}
    </Sheet>
  );
}

function ExamplePage({ context }: { context: StudioContext }) {
  const [title, setTitle] = useState<string>();
  useEffect(() => {
    void context.run(async () => setTitle((await unwrap(BlyggerApi.getSettings({ client: context.client }))).siteTitle));
  }, []);
  return <p data-extension-page="example">This page belongs to the example extension. Site title, read through the SDK: {title ?? '…'}</p>;
}

export const extension: StudioExtension = {
  name: 'example',
  label: 'Example extension',
  description: 'Adds a marker to each reading byline, an "example" row to the ⋯ sheet and a page under More. For trying the extension slots.',
  entryByline: ({ context }) => (
    <button type="button" className="ext-example" data-extension="example" aria-label="example extension" onClick={() => context.openSheet(aboutSheet(context))}>
      ◇
    </button>
  ),
  entryActions: (context) => [{ icon: '◇', label: 'example', description: 'about this entry', onSelect: () => context.openSheet(aboutSheet(context)) }],
  page: { title: 'example', component: ExamplePage },
};
