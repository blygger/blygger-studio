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
  /** A page of its own at /studio/ext/<name>, linked from More. */
  page?: {
    title: string;
    component: ComponentType<{ context: StudioContext }>;
    /**
     * Link it from the main menu instead, above compose, under `title` with this icon.
     * The menu holds one such entry (see mainMenuPage); any other stays in More.
     */
    mainMenu?: { icon: string };
  };
}
