// A page that asks for the top of the main menu (docs/extensions.md). The template to copy
// for a page that is where its owner starts. It shows where it was placed, and nothing else.
import type { StudioExtension } from '../../../src/ui/extension-api.ts';

export const extension: StudioExtension = {
  name: 'menu-top-example',
  label: 'Top of the menu example',
  description: 'Adds a page to the top of the main menu, above reading. For trying menu zones.',
  page: {
    title: 'top example',
    mainMenu: { icon: '◆', zone: 'top' },
    component: ({ context }) => (
      <p data-extension-page="menu-top-example" data-zone={context.menu.zone}>
        Asked for {context.menu.asked}; placed in {context.menu.zone}.
      </p>
    ),
  },
};
