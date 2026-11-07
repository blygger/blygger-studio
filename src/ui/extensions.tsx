/*
 * Where Studio extensions render (docs/extensions.md). The host side of
 * extension-api.ts: which extensions are on, and the slots they fill.
 *
 * Two promises this module keeps:
 *  - Off is invisible. With no extension enabled, every slot renders nothing
 *    and adds no ⋯ row, so the Studio is the reference Studio exactly
 *    (test-ui/extensions.test.ts, e2e/extensions.spec.ts).
 *  - A broken extension breaks only itself. Each slot is an error boundary
 *    that renders nothing once its extension throws, and a throwing
 *    entryActions() or onSelect() is caught and logged.
 *
 * Kept free of the data layer (data.ts, components.tsx) so the UI test suite
 * can render it without a browser; reading.tsx supplies the enabled list.
 */
import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import type { EntryAction, EntryContext, StudioExtension } from './extension-api.ts';
import type { MenuRow } from './sheets.tsx';

/** The compiled-in extensions this node has enabled, in compiled order. */
export function enabledExtensions(compiled: readonly StudioExtension[], enabled: readonly string[] | undefined) {
  if (!enabled?.length) return [];
  return compiled.filter((extension) => enabled.includes(extension.name));
}

/**
 * The one enabled extension page in the main menu: the first in compiled order that asks.
 * One, because a phone's tab bar has room for one more tab and no more.
 */
export function mainMenuPage(extensions: readonly StudioExtension[]) {
  return extensions.find((extension) => extension.page?.mainMenu);
}

function report(name: string, slot: string, error: unknown) {
  console.error(`Studio extension "${name}" failed in ${slot}; it is skipped there until the page reloads.`, error);
}

/** Renders nothing once its extension throws; the rest of the Studio carries on. */
export class ExtensionBoundary extends Component<{ name: string; slot: string; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, _info: ErrorInfo) {
    report(this.props.name, this.props.slot, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The byline slot: each enabled extension's adornment, each in its own boundary. */
export function EntryBylineSlot({ extensions, context }: { extensions: readonly StudioExtension[]; context: (extension: StudioExtension) => EntryContext }) {
  const filling = extensions.filter((extension) => extension.entryByline);
  if (!filling.length) return null;
  return (
    <>
      {filling.map((extension) => {
        const Byline = extension.entryByline!;
        return (
          <ExtensionBoundary key={extension.name} name={extension.name} slot="entryByline">
            <Byline context={context(extension)} />
          </ExtensionBoundary>
        );
      })}
    </>
  );
}

/** The ⋯ sheet's extension rows, after the Studio's own. A throwing extension contributes none. */
export function entryActionRows(extensions: readonly StudioExtension[], context: (extension: StudioExtension) => EntryContext): MenuRow[] {
  const filling = extensions.filter((extension) => extension.entryActions);
  if (!filling.length) return [];
  return filling.flatMap((extension) => {
    let actions: EntryAction[];
    try {
      actions = extension.entryActions!(context(extension));
    } catch (error) {
      report(extension.name, 'entryActions', error);
      return [];
    }
    return actions.map((action) => ({
      key: `ext:${extension.name}:${action.label}`,
      icon: action.icon,
      label: action.label,
      description: action.description,
      onSelect: () => {
        try {
          action.onSelect();
        } catch (error) {
          report(extension.name, 'entryActions', error);
        }
      },
    }));
  });
}

/** A sheet an extension opened from an entry, rendered under that entry. */
export interface OpenSheet {
  name: string;
  render: (close: () => void) => ReactNode;
}
export function EntrySheetSlot({ sheet, close }: { sheet: OpenSheet | null; close: () => void }) {
  if (!sheet) return null;
  return (
    <ExtensionBoundary key={sheet.name} name={sheet.name} slot="sheet">
      <SheetBody sheet={sheet} close={close} />
    </ExtensionBoundary>
  );
}
// A component, so a render() that throws is caught by the boundary above it.
function SheetBody({ sheet, close }: { sheet: OpenSheet; close: () => void }) {
  return <>{sheet.render(close)}</>;
}
