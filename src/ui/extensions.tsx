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
 *  - Its failures carry its name. What an extension throws, or shows through
 *    run() and showError(), goes in the error log (error-log.ts) as its own.
 *
 * Kept free of the data layer (data.ts, components.tsx) so the UI test suite
 * can render it without a browser; reading.tsx and authoring.tsx supply the
 * enabled list.
 */
import type { ErrorInfo, ReactNode } from 'react';
import { Component, useRef, useState } from 'react';
import type { EditorRegion } from './editor-regions.ts';
import { rebaseMarks } from './editor-marks.tsx';
import type { BarPlace, BarRow, DraftCounterContext, EditorMark, ReplaceableControl, EditorBarContext, EditorRegionsContext, EntryAction, EntryContext, MenuZone, StudioContext, StudioExtension } from './extension-api.ts';
import { errorLog } from './error-log.ts';
import { Sheet, type MenuRow } from './sheets.tsx';

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

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
function report(name: string, slot: string, error: unknown) {
  console.error(`Studio extension "${name}" failed in ${slot}; it is skipped there until the page reloads.`, error);
  errorLog.record(asError(error), 'extension', { extension: name, slot });
}

/** A screen's side of a context: everything but the verbs this module adds per extension. */
export type HostContext<C extends StudioContext> = Omit<C, 'showError'>;
/**
 * What one extension's slot is handed: the screen's context, with `run` and
 * `showError` putting each failure to the extension's name before the screen shows it.
 */
export function extensionContext<C extends StudioContext>(extension: Pick<StudioExtension, 'name'>, slot: string, host: HostContext<C>): C {
  const run: StudioContext['run'] = (action) =>
    host.run(async () => {
      try {
        await action();
      } catch (failure) {
        const error = asError(failure);
        errorLog.attribute(error, { extension: extension.name, slot });
        throw error;
      }
    });
  const showError: StudioContext['showError'] = (error) => void run(() => { throw asError(error); });
  return { ...host, run, showError } as unknown as C;
}

/** Renders nothing once its extension throws; the rest of the Studio carries on. */
export class ExtensionBoundary extends Component<{ name: string; slot: string; onFail?: (name: string) => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown, _info: ErrorInfo) {
    report(this.props.name, this.props.slot, error);
    this.props.onFail?.(this.props.name);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The byline slot: each enabled extension's adornment, each in its own boundary. */
export function EntryBylineSlot({ extensions, context }: { extensions: readonly StudioExtension[]; context: (extension: StudioExtension) => HostContext<EntryContext> }) {
  const filling = extensions.filter((extension) => extension.entryByline);
  if (!filling.length) return null;
  return (
    <>
      {filling.map((extension) => {
        const Byline = extension.entryByline!;
        return (
          <ExtensionBoundary key={extension.name} name={extension.name} slot="entryByline">
            <Byline context={extensionContext(extension, 'entryByline', context(extension))} />
          </ExtensionBoundary>
        );
      })}
    </>
  );
}

/** Beside the character count: each enabled extension's addition, set as a counter, each in its own boundary. */
export function DraftCounterSlot({ extensions, context }: { extensions: readonly StudioExtension[]; context: HostContext<DraftCounterContext> }) {
  const filling = extensions.filter((extension) => extension.draftCounter);
  if (!filling.length) return null;
  return (
    <>
      {filling.map((extension) => {
        const Counter = extension.draftCounter!;
        return (
          <ExtensionBoundary key={extension.name} name={extension.name} slot="draftCounter">
            <span className="counter counter-slot">
              <Counter context={extensionContext(extension, 'draftCounter', context)} />
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
export function entryActionRows(extensions: readonly StudioExtension[], context: (extension: StudioExtension) => HostContext<EntryContext>): MenuRow[] {
  const filling = extensions.filter((extension) => extension.entryActions);
  if (!filling.length) return [];
  return filling.flatMap((extension) => {
    let actions: EntryAction[];
    try {
      actions = extension.entryActions!(extensionContext(extension, 'entryActions', context(extension)));
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

/* ---------------- EDITOR BARS ---------------- */

/** How many blocks each editor bar row holds. A block is about one labelled button. */
export const BAR_CAPACITY = { above: 4, below: 4 } as const;
/** The most blocks one bar may ask for. */
export const MAX_BAR_BLOCKS = 4;

/** The row a bar asks for. */
export const askedRow = (extension: StudioExtension): BarRow => extension.editorBar?.row ?? 'above';
/** The blocks a bar asks for: a whole number from 1 to MAX_BAR_BLOCKS. */
export const barBlocks = (extension: StudioExtension) =>
  Math.min(MAX_BAR_BLOCKS, Math.max(1, Math.round(extension.editorBar?.blocks ?? 1) || 1));

/**
 * Where each enabled editor bar goes. An extension asks; the Studio decides. Each row is
 * filled first by the bars that asked for it, in compiled order, each taking the blocks it
 * asked for while they fit. A bar that doesn't fit tries the other row, then goes to the
 * bars menu. Bars the author hid take no room. Asking for less room is the way to a row.
 */
export function barPlacement(extensions: readonly StudioExtension[], hidden: readonly string[] = []) {
  const bars = extensions.filter((extension) => extension.editorBar);
  const shown = bars.filter((extension) => !hidden.includes(extension.name));
  const room: Record<BarRow, number> = { ...BAR_CAPACITY };
  const place = new Map<string, BarPlace>();
  const fit = (extension: StudioExtension, row: BarRow) => {
    if (barBlocks(extension) > room[row]) return false;
    room[row] -= barBlocks(extension);
    place.set(extension.name, row);
    return true;
  };
  const left = shown.filter((extension) => !fit(extension, askedRow(extension)));
  for (const extension of left) if (!fit(extension, askedRow(extension) === 'above' ? 'below' : 'above')) place.set(extension.name, 'menu');
  const at = (where: BarPlace) => shown.filter((extension) => place.get(extension.name) === where);
  return {
    bars,
    above: at('above'),
    below: at('below'),
    menu: at('menu'),
    /** Where a bar is; undefined for one the author hid. */
    placeOf: (extension: StudioExtension) => place.get(extension.name),
    /**
     * The bar that owns a replaceable control: the first enabled bar in compiled order to
     * claim it, wherever it was placed and whether or not it is hidden. A fixed owner: a
     * claim that lost never takes over, and the Studio's own control stands in while the
     * owner is off screen.
     */
    ownerOf: (control: ReplaceableControl) => bars.find((extension) => extension.editorBar!.replaces?.includes(control)),
  };
}

/** The replaceable controls the editor bars know of. */
const REPLACEABLE: readonly ReplaceableControl[] = ['regionToggle', 'spellcheck'];

/**
 * Whether a bar stands in for a Studio control now: its owner is in a row and has not
 * failed. Otherwise the Studio renders its own (docs/extensions.md, "Replaceable controls").
 */
export function barReplaces(placement: ReturnType<typeof barPlacement>, control: ReplaceableControl, failed: readonly string[]) {
  const owner = placement.ownerOf(control);
  return !!owner && !failed.includes(owner.name) && [...placement.above, ...placement.below].includes(owner);
}

const HIDDEN_BARS_KEY = 'blyg.editorBars.hidden';
/** The bars the author hid, remembered on this device. */
function useHiddenBars() {
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(HIDDEN_BARS_KEY) ?? '[]');
      return Array.isArray(stored) ? stored.filter((name) => typeof name === 'string') : [];
    } catch {
      return [];
    }
  });
  const toggle = (name: string) =>
    setHidden((now) => {
      const next = now.includes(name) ? now.filter((other) => other !== name) : [...now, name];
      try {
        localStorage.setItem(HIDDEN_BARS_KEY, JSON.stringify(next));
      } catch {
        // Not remembered, still applied.
      }
      return next;
    });
  return { hidden, toggle };
}

/** A screen's side of a bar's context: everything but what the Studio works out per bar. */
export type BarHostContext = Omit<HostContext<EditorBarContext>, 'bar' | 'openSheet' | 'mark'>;

/**
 * The editor bars of one screen: the two rows and the bars menu. `above` and `below` are
 * rendered where the screen puts them; the bars menu button ends the row above.
 * `replaced(control)` says a bar stands in for that Studio control now, so the screen
 * leaves its own out. `marks` are the editor marks to draw now, from bars on screen,
 * moved to the current text; `activate(offset)` hands a click inside one to its bar.
 * Off is invisible: with no bar enabled, both rows are null.
 */
export function useEditorBars(extensions: readonly StudioExtension[], host: BarHostContext) {
  const { hidden, toggle } = useHiddenBars();
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  // Bars that threw: their boundary renders nothing, so a control they owned is the Studio's again.
  const [failed, setFailed] = useState<readonly string[]>([]);
  const fail = (name: string) => setFailed((now) => (now.includes(name) ? now : [...now, name]));
  // Each bar's marks, with the text they were made against; its activation handler by name.
  const [marked, setMarked] = useState<Readonly<Record<string, { basis: string; marks: EditorMark[] }>>>({});
  const activators = useRef(new Map<string, (mark: EditorMark) => void>());
  const placement = barPlacement(extensions, hidden);
  if (!placement.bars.length) return { above: null, below: null, replaced: () => false, marks: [] as EditorMark[], activate: () => {} };
  const owns = (extension: StudioExtension) => REPLACEABLE.filter((control) => placement.ownerOf(control) === extension);
  const close = () => setSheet(null);
  const contextFor = (extension: StudioExtension, place: BarPlace): EditorBarContext =>
    extensionContext<EditorBarContext>(extension, 'editorBar', {
      ...host,
      openSheet: (render) => setSheet({ name: extension.name, render }),
      mark: (marks, onActivate) => {
        if (onActivate) activators.current.set(extension.name, onActivate);
        else activators.current.delete(extension.name);
        const next = marks.map(({ start, end, kind, title }) => ({ start, end, kind, ...(title ? { title } : {}) }));
        setMarked((now) => (now[extension.name]?.basis === host.shown && JSON.stringify(now[extension.name].marks) === JSON.stringify(next) ? now : { ...now, [extension.name]: { basis: host.shown, marks: next } }));
      },
      bar: { asked: askedRow(extension), place, blocks: place === 'menu' ? MAX_BAR_BLOCKS : barBlocks(extension), owns: owns(extension) },
    } as HostContext<EditorBarContext>);
  const bar = (extension: StudioExtension, place: BarPlace) => {
    const Bar = extension.editorBar!.component;
    return (
      <ExtensionBoundary key={extension.name} name={extension.name} slot="editorBar" onFail={fail}>
        <div className="ext-bar" data-extension={extension.name} data-blocks={place === 'menu' ? undefined : barBlocks(extension)}>
          <Bar context={contextFor(extension, place)} />
        </div>
      </ExtensionBoundary>
    );
  };
  const openedBar = placement.menu.find((extension) => extension.name === opened);
  const menuButton = (
    <button type="button" className="act tool ext-bars-menu" aria-label="editor bars" title="Editor bars: show, hide, or open one that has no room" onClick={() => setMenuOpen(true)}>
      bars
    </button>
  );
  const above = (
    <div className="ext-bars ext-bars-above" data-row="above">
      {placement.above.map((extension) => bar(extension, 'above'))}
      <span className="spacer" />
      {menuButton}
      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="editor bars" description="Bars that extensions add to the editor. Hiding one is remembered on this device.">
        <ul className="ext-bars-list">
          {placement.bars.map((extension) => {
            const where = placement.placeOf(extension);
            return (
              <li key={extension.name} data-extension={extension.name}>
                <label>
                  <input type="checkbox" checked={!hidden.includes(extension.name)} onChange={() => toggle(extension.name)} /> {extension.editorBar!.label}
                </label>
                <span className="hint">{where === 'menu' ? 'no room in the rows' : where ? `${where} the text` : 'hidden'}</span>
                {where === 'menu' ? (
                  <button type="button" className="link-btn" onClick={() => { setMenuOpen(false); setOpened(extension.name); }}>
                    open
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Sheet>
      {openedBar ? (
        <Sheet open onClose={() => setOpened(null)} title={openedBar.editorBar!.label}>
          {bar(openedBar, 'menu')}
        </Sheet>
      ) : null}
      <EntrySheetSlot sheet={sheet} close={close} />
    </div>
  );
  const below = placement.below.length ? (
    <div className="ext-bars ext-bars-below" data-row="below">
      {placement.below.map((extension) => bar(extension, 'below'))}
    </div>
  ) : null;
  const replaced = (control: ReplaceableControl) => barReplaces(placement, control, failed);
  // Marks only from bars in a row on screen that haven't failed: hidden, in the menu or crashed, a bar marks nothing.
  const showing = [...placement.above, ...placement.below].filter((extension) => !failed.includes(extension.name));
  const owned = showing.flatMap((extension) => (marked[extension.name] ? rebaseMarks(marked[extension.name].marks, marked[extension.name].basis, host.shown).map((mark) => ({ mark, name: extension.name })) : []));
  const activate = (offset: number) => {
    const hit = owned.find(({ mark }) => mark.start <= offset && offset <= mark.end);
    const handler = hit && activators.current.get(hit.name);
    if (!hit || !handler) return;
    try {
      handler(hit.mark);
    } catch (error) {
      report(hit.name, 'editorBar', error);
    }
  };
  return { above, below, replaced, marks: owned.map(({ mark }) => mark), activate };
}
