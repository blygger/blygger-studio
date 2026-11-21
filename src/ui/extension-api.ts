/*
 * The Studio's extension surface (docs/extensions.md).
 *
 * This is the only Studio module an extension's UI may import (plus React, the
 * SDK in sdk/dist/browser.js, and files in its own directory);
 * test-ui/extensions.test.ts holds every extension to that. An extension sees
 * what a slot hands it — the entry, the SDK client, a few verbs — and not the
 * app: no collections, no query cache, no router internals.
 *
 * Extensions are compiled in, never loaded at run time: the Studio holds the
 * owner's session, so code that reaches it is code the operator chose to build.
 */
import type { ComponentType, ReactNode } from 'react';
import type { BlyggerClient, CreateItemData, ReadingEntry } from '../../sdk/dist/browser.js';
import type { EditorRegion } from './editor-regions.ts';

export type { EditorRegion } from './editor-regions.ts';

export { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
export { Sheet, confirm, toast } from './sheets.tsx';
export { Button } from '@base-ui/react/button';

/** Where to go in the Studio: a path under /studio, with optional search params. */
export interface StudioLocation {
  to: string;
  search?: Record<string, string>;
  params?: Record<string, string>;
}

/** The verbs every slot gets. */
export interface StudioContext {
  /** The SDK client, carrying the owner's session. Extension routes are in the SDK like any other operation. */
  client: BlyggerClient;
  /** Create an item and open it in the editor (POST /api/items, then navigate). */
  openDraft(body: CreateItemData['body']): Promise<void>;
  navigate(location: StudioLocation): Promise<void>;
  /** Run an action; a thrown error lands in the screen's own error line rather than escaping. */
  run(action: () => unknown): Promise<void>;
  /**
   * Show an error in the screen's own error line, as `run` does for a thrown one.
   * Either way it is also kept in the owner's error log (Settings → Errors) under
   * this extension's name. For news that is not a failure, use `toast`.
   */
  showError(error: unknown): void;
}

/**
 * Where an extension page links from: `top`, above the Studio's own tabs; `visible`, among
 * them, at a spot the Studio picks; `hidden`, under More.
 */
export type MenuZone = 'top' | 'visible' | 'hidden';

/** What an extension's page is handed: the verbs, and where its link ended up. */
export interface PageContext extends StudioContext {
  /** The zone the page asked for, and the one it got. A full zone moves a page down, never up. */
  menu: { asked: MenuZone; zone: MenuZone };
}

/**
 * The Studio's own handlers for one reading entry, so an extension can offer
 * them again in its own presentation without reimplementing them. A missing
 * handler is one the Studio does not offer for this entry.
 */
export interface CoreEntryActions {
  /** Open a response draft (the stub editor, where passages are chosen). */
  stub?: () => void;
  /** The fork page for this item. */
  fork?: () => void;
  /** A new fragment opening with a [[id]] link to this item. */
  linkPost?: () => void;
  /** Show this entry's version history. */
  history?: () => void;
  /** Open the item's public page in a new tab. */
  open?: () => void;
}

export interface EntryContext extends StudioContext {
  entry: ReadingEntry;
  /** Our item id, or the imported item's remote id. */
  id: string;
  /** Present for an imported entry. */
  imported?: { subscriptionId: string; remoteId: string };
  /** The item's public page, when it has one. */
  url?: string;
  actions: CoreEntryActions;
  /** Open a sheet owned by this extension, rendered under the entry. `close` dismisses it. */
  openSheet(render: (close: () => void) => ReactNode): void;
}

/** What is being written, wherever the Studio shows a character count. */
export interface DraftCounterContext extends StudioContext {
  /** The text as it stands now, saved or not. */
  text: string;
  /** The item open in the full editor. Absent in the composer, whose text may have no server copy yet. */
  item?: {
    id: string;
    kind: 'fragment' | 'thread';
    status: 'draft' | 'public' | 'withdrawn';
    version: number;
    /** Moves each time the working copy reaches the server, so autosave is what a slot re-reads on. */
    revision: number;
  };
}

/** What `editorRegions` is handed: the full text, and the item open in the editor. */
export interface EditorRegionsContext {
  text: string;
  item: NonNullable<DraftCounterContext['item']>;
}

/** The editor bar rows: above the text box, or below it. */
export type BarRow = 'above' | 'below';
/** Where a bar was put: a row, or the bars menu when neither row had room. */
export type BarPlace = BarRow | 'menu';
/**
 * The Studio's own controls an extension may replace (docs/extensions.md, "Replaceable
 * controls"). The list is short and grows one entry at a time, each with its contract.
 * `regionToggle`: the held-out notice beside the counts, which shows and hides the
 * held-out regions. `spellcheck`: the browser's own spellcheck in the text box.
 */
export type ReplaceableControl = 'regionToggle' | 'spellcheck';

/**
 * A stretch of the text box's text that a bar marks: drawn as an underline over the text,
 * never changing it. Offsets are in `shown`. `kind` picks the underline: `spelling` (a
 * wavy line), `grammar` (a wavy line in another colour) or `note` (a dotted one).
 */
export interface EditorMark {
  start: number;
  end: number;
  kind: 'spelling' | 'grammar' | 'note';
  /** Shown as a tooltip and read out on activation, such as "not in the dictionary". */
  title?: string;
}

/**
 * What an editor bar is handed, in the composer and the full editor. Offsets are in the
 * text box's text (`shown`): what the author sees, without held-out regions. Edits go
 * through the same path as the Studio's own tools, so regions, autosave and the
 * preview follow them.
 */
export interface EditorBarContext extends StudioContext {
  /** The whole text as it stands now, saved or not. */
  text: string;
  /** What the text box shows: `text` without held-out regions. */
  shown: string;
  /** The item open in the full editor. Absent in the composer. */
  item?: DraftCounterContext['item'];
  /** The text box's selection now (start = end for a caret). */
  selection(): { start: number; end: number };
  /** Put `text` in place of the selection, or at the caret, and leave the caret after it. */
  insert(text: string): void;
  /** Replace [start, end) of the shown text with `text`. */
  replace(start: number, end: number, text: string): void;
  /**
   * The held-out regions (`editorRegions`, every extension's together), in the full editor
   * while there are any. `hide` also takes the editor out of its fail-safe, where it was
   * showing the whole text after an edit it could not rejoin.
   */
  regions?: { labels: string[]; hidden: boolean; show(): void; hide(): void };
  /** Open a sheet owned by this extension. `close` dismisses it. */
  openSheet(render: (close: () => void) => ReactNode): void;
  /**
   * Underline stretches of the text (docs/extensions.md, "Editor marks"), replacing this
   * bar's earlier marks; `[]` clears them. The Studio moves them with each edit until the
   * next call. Clicking inside one calls `onActivate` with it. Drawn only while this bar is
   * in a row on screen, and never in focus view.
   */
  mark(marks: EditorMark[], onActivate?: (mark: EditorMark) => void): void;
  /**
   * The row and blocks this bar asked for, and what the Studio gave it. `owns` lists the
   * controls this bar replaces: those it claimed in `replaces` and won. Render a
   * replacement only for a control in `owns`; a claim that lost leaves the Studio's own.
   */
  bar: { asked: BarRow; place: BarPlace; blocks: number; owns: ReplaceableControl[] };
}

/** A row an extension adds to an entry's ⋯ sheet, below the Studio's own. */
export interface EntryAction {
  icon?: ReactNode;
  label: string;
  description?: ReactNode;
  onSelect: () => void;
}

export interface StudioExtension {
  /** Matches extensions/catalog.ts and the directory name. */
  name: string;
  /** Shown in Settings → extensions. */
  label: string;
  /** One sentence, shown in Settings under the label. */
  description: string;
  /** Rendered at the end of a reading entry's byline. */
  entryByline?: ComponentType<{ context: EntryContext }>;
  /** Rows for a reading entry's ⋯ sheet. Called when the sheet opens. */
  entryActions?: (context: EntryContext) => EntryAction[];
  /** Rendered beside the character count, in the composer and the full editor. */
  draftCounter?: ComponentType<{ context: DraftCounterContext }>;
  /**
   * Parts of the full editor's text to keep out of its text box: hidden each time the
   * editor opens, read-only when the author shows them. The draft, preview, counts and
   * publish still have the whole text. Called on every change, so keep it quick and pure.
   * A region should start with its own separator (a leading blank line): text typed
   * where it was cut lands before it.
   */
  editorRegions?: (context: EditorRegionsContext) => EditorRegion[];
  /**
   * A bar of controls in the composer and the full editor, in a row of its own above or
   * below the text box, apart from the Studio's tools. `row` (default `above`) and
   * `blocks` (1–4, default 1; a block holds about one labelled button) are a request: the
   * Studio shares the rows among the bars and moves what doesn't fit to the bars menu
   * (see barPlacement). The author can hide any bar from that menu.
   */
  editorBar?: {
    /** Names the bar in the bars menu. */
    label: string;
    row?: BarRow;
    blocks?: number;
    /**
     * The Studio's controls this bar replaces (docs/extensions.md, "Replaceable controls").
     * The first enabled bar in compiled order to claim a control owns it; `context.bar.owns`
     * says whether this one did. The Studio leaves its own control out only while the owner
     * is in a row on screen and has not failed: hidden, in the menu, crashed or in focus
     * view, the Studio's control is back.
     */
    replaces?: ReplaceableControl[];
    component: ComponentType<{ context: EditorBarContext }>;
  };
  /** A page of its own at /studio/ext/<name>, linked from More. */
  page?: {
    title: string;
    component: ComponentType<{ context: PageContext }>;
    /**
     * Ask for a link in the main menu, under `title` with this icon. `zone` is a request
     * (default `visible`); the Studio decides, and a full zone moves the page down
     * (see menuPlacement).
     */
    mainMenu?: { icon: string; zone?: MenuZone };
  };
}
