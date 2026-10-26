/*
 * A registry fixture, used only by test-ui/extension-registry.test.ts: the
 * tests commit this directory to a throwaway git repository and vendor it the
 * way `npm run ext:add` vendors a third-party extension. It is never listed
 * in registry/index.json and never compiled into a build of this repository.
 */
import type { StudioExtension } from '../../../src/ui/extension-api.ts';
import { greeting } from './greeting.ts';
import './hello-registry.css';

export const extension: StudioExtension = {
  name: 'hello-registry',
  label: 'Hello registry',
  description: 'A test fixture for the extension registry.',
  entryByline: ({ context }) => <span className="hello-registry">{greeting(context.entry.kind)}</span>,
};
