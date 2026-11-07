// The page slot with a main-menu entry (docs/extensions.md). The template to copy for a
// page its owner opens all the time. It does nothing that matters.
import type { StudioExtension } from '../../../src/ui/extension-api.ts';

export const extension: StudioExtension = {
  name: 'menu-example',
  label: 'Main menu example',
  description: 'Adds a page to the main menu, above compose. For trying the main-menu entry.',
  page: {
    title: 'menu example',
    mainMenu: { icon: '◇' },
    component: () => <p data-extension-page="menu-example">This page has an entry in the main menu.</p>,
  },
};
