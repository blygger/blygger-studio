/*
 * /studio/ext/<name>: the page an enabled extension owns (docs/extensions.md).
 * Answers "not enabled" for an extension this build lacks or this node has
 * turned off, so a bookmark outlives the toggle without showing anything.
 */
import { createItem } from './server-mutations.ts';
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { compiledExtensions } from '../../build/extensions.ui.ts';
import { client } from './data.ts';
import { Failure, useChrome, useSettings } from './components.tsx';
import type { StudioContext } from './extension-api.ts';
import { ExtensionBoundary, enabledExtensions, mainMenuPage } from './extensions.tsx';

export function ExtensionPage({ name }: { name: string }) {
  useChrome({ framed: false });
  const settings = useSettings();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>();
  const enabled = enabledExtensions(compiledExtensions, settings?.extensions);
  const extension = enabled.find((candidate) => candidate.name === name && candidate.page);
  if (!settings) return <p className="view-sub">Loading…</p>;
  if (!extension?.page)
    return (
      <>
        <Link className="back-link" to="/more">
          ← more
        </Link>
        <p className="view-sub">This extension is not enabled here.</p>
      </>
    );
  const context: StudioContext = {
    client,
    openDraft: async (body) => {
      const created = await createItem(body);
      await navigate({ to: '/edit/$id', params: { id: created.id } });
    },
    navigate: (location) => navigate(location as never),
    run: async (action) => {
      setError(undefined);
      try {
        await action();
      } catch (failure) {
        setError(failure);
      }
    },
  };
  const Page = extension.page.component;
  return (
    <>
      {extension === mainMenuPage(enabled) ? null : (
        <Link className="back-link" to="/more">
          ← more
        </Link>
      )}
      <h2 className="view-h">{extension.page.title}</h2>
      <Failure error={error} />
      <ExtensionBoundary name={extension.name} slot="page">
        <Page context={context} />
      </ExtensionBoundary>
    </>
  );
}
