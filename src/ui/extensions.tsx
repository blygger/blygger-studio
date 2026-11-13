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
 * can render it without a browser; reading.tsx and authoring.tsx supply the
 * enabled list.
 */
import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import type { EditorRegion } from './editor-regions.ts';
import type { DraftCounterContext, EditorRegionsContext, EntryAction, EntryContext, MenuZone, StudioExtension } from './extension-api.ts';
import type { MenuRow } from './sheets.tsx';

/** The compiled-in extensions this node has enabled, in compiled order. */
export function enabledExtensions(compiled: readonly StudioExtension[], enabled: readonly string[] | undefined) {
  if (!enabled?.length) return [];
  return compiled.filter((extension) => enabled.includes(extension.name));
}

/** How many extension pages each menu zone holds. Hidden (More) holds any number. */
export const MENU_CAPACITY = { top: 1, visible: 1 } as const;

/** The zone an extension page asks for. A page that does not ask is in More. */
export function askedZone(extension: StudioExtension): MenuZone {
  const menu = extension.page?.mainMenu;
  return menu ? (menu.zone ?? 'visible') : 'hidden';
}

/**
 * Where each enabled extension page links from. An extension asks; the Studio decides.
 * A zone is filled first by the pages that asked for it, then by pages a full zone above
 * moved down, each in compiled order; whatever does not fit goes down a zone. So a page
 * gets the zone it asked for or a lower one, never a higher one, and ends at worst in More.
 */
export function menuPlacement(extensions: readonly StudioExtension[]) {
  const pages = extensions.filter((extension) => extension.page);
  const placed = { top: [] as StudioExtension[], visible: [] as StudioExtension[] };
  let moved: StudioExtension[] = [];
  for (const zone of ['top', 'visible'] as const) {
    const candidates = [...pages.filter((extension) => askedZone(extension) === zone), ...moved];
    placed[zone] = candidates.slice(0, MENU_CAPACITY[zone]);
    moved = candidates.slice(MENU_CAPACITY[zone]);
  }
  const zoneOf = (extension: StudioExtension): MenuZone =>
    placed.top.includes(extension) ? 'top' : placed.visible.includes(extension) ? 'visible' : 'hidden';
  return { ...placed, hidden: pages.filter((extension) => zoneOf(extension) === 'hidden'), zoneOf };
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

/** Beside the character count: each enabled extension's addition, set as a counter, each in its own boundary. */
export function DraftCounterSlot({ extensions, context }: { extensions: readonly StudioExtension[]; context: DraftCounterContext }) {
  const filling = extensions.filter((extension) => extension.draftCounter);
  if (!filling.length) return null;
  return (
    <>
      {filling.map((extension) => {
        const Counter = extension.draftCounter!;
        return (
          <ExtensionBoundary key={extension.name} name={extension.name} slot="draftCounter">
            <span className="counter counter-slot">
              <Counter context={context} />
            </span>
          </ExtensionBoundary>
        );
      })}
    </>
  );
}

/** Every enabled extension's held-out regions for this text. A throwing extension holds out nothing. */
export function editorRegions(extensions: readonly StudioExtension[], context: EditorRegionsContext): EditorRegion[] {
  return extensions
    .filter((extension) => extension.editorRegions)
    .flatMap((extension) => {
      try {
        return extension.editorRegions!(context);
      } catch (error) {
        report(extension.name, 'editorRegions', error);
        return [];
      }
    });
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
