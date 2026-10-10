/*
 * Authoring: compose (`/`) and the editor (`/edit/$id`) — PWA redesign,
 * phase 2A (design/pwa-prototype: viewCompose, itemRow, viewEditor).
 *
 * Client-only additions on top of the existing behaviour: link from
 * clipboard and pour-over paste (links.ts), scan text (OS scanners; the
 * optional on-device reader is ocr.tsx), ⧉ copy + link and share…
 * (plain-text.ts), list filters, and the published banner.
 */
import type { ReactNode, RefObject } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from '@tanstack/react-db';
import { Link, useNavigate, useBlocker } from '@tanstack/react-router';
import { formatDateIn } from '../dates.ts';
import { renderMarkdown } from '../markdown.ts';
import { markImported, parseScopes, previewStrip } from '../tk.ts';
import { extractDirectives } from '../directives.ts';
import { previewFromHtml } from '../preview.ts';
import type { ListItemsResponses, Version } from '../../sdk/dist/browser.js';
import { BlyggerApi, unwrap } from '../../sdk/dist/browser.js';
import type { Detail } from './data.ts';
import { client, items, itemDetail, changed, refreshItems, createDraftAction } from './data.ts';
import {
  ActionBar,
  Button,
  Failure,
  Html,
  Modal,
  mount,
  useChrome,
  usePoll,
  useSettings,
  publicPath,
} from './components.tsx';
import { Sheet, confirm, menu, prompt, toast } from './sheets.tsx';
import { BracketPicker } from './picker.tsx';
import { setTextAt } from './caret.ts';
import { Draft } from './draft.ts';

import { stripStaleUploads, uploadToken } from './upload-tokens.ts';
import { FRAGMENT_MAX_CHARS as MAX } from '../client.ts';
import { insertLink, isUrl, linkToast } from './links.ts';
import type { Resolve } from './plain-text.ts';
import { itemTitle, permalink, plainText, textWithLink } from './plain-text.ts';
import { OcrScan } from './ocr.tsx';
import { addStubQuote, passageCount, stubQuoteForm, withStubQuote } from './stub-quote.ts';
import './authoring.css';

type Kind = 'fragment' | 'thread';
type Row = ListItemsResponses[200]['items'][number];
/** What the published banner, ⧉ copy + link and share… need of an item. */
interface Shareable {
  id: string;
  kind: Kind;
  /** The published text. */
  md: string;
}
interface Published extends Shareable {
  version: number;
}

function useAction() {
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string>();
  const pending = useRef(0);
  return {
    error,
    warning,
    busy,
    run: async (fn: () => Promise<unknown>) => {
      pending.current++;
      setBusy(true);
      setError(undefined);
      setWarning(undefined);
      try {
        const result = await fn();
        if (
          result &&
          typeof result === 'object' &&
          'warning' in result &&
          typeof result.warning === 'string'
        )
          setWarning(result.warning);
      } catch (error) {
        setError(error);
      } finally {
        pending.current--;
        setBusy(pending.current > 0);
      }
    },
  };
}
function Help({ thread, className = 'compose-help' }: { thread?: boolean; className?: string }) {
  return thread ? (
    <p className={className}>
      Markdown supported. <code>![[id]]</code> quotes an item.{' '}
      <code>[[id]]</code> links an item. <code>[TK]an instruction[/TK]</code>{' '}
      marks AI-drafted text. Type <code>/image</code> on its own line, or
      paste or drop an image, to insert one there. Paste a URL over selected
      text to link it. <Link to="/syntax">full syntax reference</Link>
    </p>
  ) : (
    <p className={className}>
      Markdown supported. Write <code>[[id]]</code> to link another item of
      yours or something you read (type <code>[[</code> for a picker), and{' '}
      <code>[TK]an instruction[/TK]</code> to mark a scope for AI-drafted text —
      a <em>generate</em> button appears, which saves and opens the editor.
      Type <code>/image</code> on its own line, or paste or drop an image, to
      insert one there. Paste a URL over selected text to link it.{' '}
      <Link to="/syntax">full syntax reference</Link>
    </p>
  );
}
/**
 * Put `block` on its own paragraph at [start, end) of `text`, adding only the
 * blank lines the surrounding text does not already supply.
 */
export function insertBlock(text: string, start: number, end: number, block: string) {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = !before || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = !after || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  return { text: before + lead + block + trail + after, caret: (before + lead + block).length };
}

/** A line holding only `/image`, ending at the caret: the slash command. */
export function imageCommandAt(text: string, caret: number) {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  return text.slice(lineStart, caret).trim() === '/image' &&
    (caret === text.length || text[caret] === '\n')
    ? { start: lineStart, end: caret }
    : null;
}

/* ---------------- text tools: links, brackets, TK, scan ---------------- */

/** Link `raw` over [start, end) of the textarea: the selected words, or an autolink. */
function linkInto(
  el: HTMLTextAreaElement,
  raw: string,
  at: { start: number; end: number },
  change: (text: string) => void,
) {
  const result = insertLink(el.value, at.start, at.end, raw);
  if (!result) {
    toast('That is not a URL.');
    return;
  }
  setTextAt(el, change, result.text, result.caret);
  toast(linkToast(result));
}
/**
 * Pour-over (Burrow): a lone URL pasted while text is selected links the
 * selection. Anything else — no selection, an image, prose — pastes as usual.
 */
function pourOver(
  event: React.ClipboardEvent<HTMLTextAreaElement>,
  change: (text: string) => void,
) {
  const el = event.currentTarget;
  if (el.selectionStart === el.selectionEnd || event.clipboardData.files.length) return false;
  const text = event.clipboardData.getData('text/plain');
  if (!isUrl(text)) return false;
  event.preventDefault();
  linkInto(el, text, { start: el.selectionStart, end: el.selectionEnd }, change);
  return true;
}

type Platform = 'ios' | 'android' | 'other';
function platform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}
const SCAN_HOW = {
  ios: (
    <>
      Long-press the text box and tap <b>Scan Text</b> (or AutoFill → Scan Text). iOS
      reads the camera live; nothing is uploaded.
    </>
  ),
  android: (
    <>
      If your keyboard shows a <b>scan text</b> or <b>Lens</b> button (Gboard on recent
      phones, the Samsung keyboard), tap it. Otherwise open <b>Google Lens</b>, point it
      at the text, tap <b>Copy text</b>, and paste here.
    </>
  ),
};

/**
 * The composer tool row's behaviour, shared by the composer and the editor:
 * link from clipboard, pour-over paste, `[[` / `![[` / `[TK]`, and the scan
 * sheet with its coach mark.
 */
function useTextTools(
  textarea: RefObject<HTMLTextAreaElement | null>,
  change: (text: string) => void,
) {
  const [scan, setScan] = useState<{ start: number; end: number } | null>(null);
  const [coach, setCoach] = useState<string>();
  useEffect(() => {
    if (!coach) return;
    const timer = setTimeout(() => setCoach(undefined), 4500);
    return () => clearTimeout(timer);
  }, [coach]);
  const range = () => {
    const el = textarea.current;
    const end = el?.value.length ?? 0;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : { start: end, end };
  };
  const replace = (start: number, end: number, insert: string, select?: [number, number]) => {
    const el = textarea.current;
    if (!el) return;
    const caret = start + insert.length;
    setTextAt(el, change, el.value.slice(0, start) + insert + el.value.slice(end), ...(select ?? [caret, caret]));
  };
  const focusAt = (at: { start: number; end: number }) => {
    const el = textarea.current;
    if (!el) return;
    // After the sheet has handed focus back to its trigger.
    const focus = () => {
      el.focus();
      el.setSelectionRange(at.start, at.end);
    };
    requestAnimationFrame(focus);
    setTimeout(focus, 300);
  };
  return {
    pourOver: (event: React.ClipboardEvent<HTMLTextAreaElement>) => pourOver(event, change),
    async linkFromClipboard() {
      const el = textarea.current;
      if (!el) return;
      const at = range();
      let clip = '';
      let blocked = false;
      try {
        clip = (await navigator.clipboard.readText()).trim();
      } catch {
        blocked = true;
      }
      if (!isUrl(clip)) {
        // Some browsers will not let a page read the clipboard: typing or
        // pasting the URL is always the other way in.
        const typed = await prompt({
          title: 'link from clipboard',
          body: `${
            blocked
              ? 'This browser would not let the studio read the clipboard.'
              : 'The clipboard does not hold a URL.'
          } Paste or type one — trackers are stripped.`,
          label: 'URL',
          placeholder: 'https://…',
          ok: 'insert link',
        });
        if (typed === null) return;
        clip = typed;
      }
      linkInto(el, clip, at, change);
    },
    bracket(form: '[[' | '![[') {
      const el = textarea.current;
      if (!el) return;
      const { start, end } = range();
      if (form === '[[') return replace(start, end, '[[');
      // The directive owns its line.
      const text = el.value;
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const lead = text.slice(lineStart, start).trim() ? '\n' : '';
      const after = text.slice(end);
      const trail = after && !after.startsWith('\n') ? '\n' : '';
      const caret = start + lead.length + 3;
      replace(start, end, `${lead}![[${trail}`, [caret, caret]);
    },
    tk() {
      const el = textarea.current;
      if (!el) return;
      const { start, end } = range();
      const selection = el.value.slice(start, end);
      if (selection) return replace(start, end, `[TK]${selection}[/TK]`);
      const placeholder = 'an instruction';
      replace(start, end, `[TK]${placeholder}[/TK]`, [start + 4, start + 4 + placeholder.length]);
    },
    openScan: () => setScan(range()),
    sheet: (
      <Sheet open={!!scan} onClose={() => setScan(null)} title="scan text" className="scan-sheet">
        <div className="banner banner-info">
          <span className="mark" aria-hidden="true">
            i
          </span>
          <div className="body">
            {platform() === 'other' ? (
              <>
                <p data-platform="ios">
                  <b>iPhone:</b> {SCAN_HOW.ios}
                </p>
                <p data-platform="android">
                  <b>Android:</b> {SCAN_HOW.android}
                </p>
              </>
            ) : (
              <p data-platform={platform()}>{SCAN_HOW[platform() as 'ios' | 'android']}</p>
            )}
            <div className="scan-where">
              <Button
                className="btn btn-primary btn-mini"
                data-action="show-me-where"
                onClick={() => {
                  const at = scan ?? range();
                  setScan(null);
                  focusAt(at);
                  setCoach(
                    platform() === 'ios'
                      ? 'Long-press here, then tap Scan Text'
                      : 'Look for scan text / Lens on your keyboard',
                  );
                }}
              >
                show me where
              </Button>
            </div>
          </div>
        </div>
        <OcrScan
          insert={(scanned, asQuote) => {
            const el = textarea.current;
            const at = scan ?? range();
            setScan(null);
            if (!el) return;
            const words = scanned.split(/\s+/).filter(Boolean).length;
            if (asQuote) {
              const quote = scanned
                .split('\n\n')
                .map((p) => `> ${p}`)
                .join('\n>\n');
              const placed = insertBlock(el.value, at.start, at.end, quote);
              setTextAt(el, change, placed.text, placed.caret);
            } else replace(at.start, at.end, scanned);
            toast(`scanned ${words} word${words === 1 ? '' : 's'}`);
          }}
        />
        <div className="sheet-actions">
          <Sheet.Close>close</Sheet.Close>
        </div>
      </Sheet>
    ),
    coach: coach ? (
      <div className="coach" role="status">
        {coach}
      </div>
    ) : null,
  };
}
type TextTools = ReturnType<typeof useTextTools>;
/** The tool row: attach image, link, scan, the bracket forms and TK, plus a screen's own. */
function ToolRow({
  tools,
  thread,
  attach,
  attachId,
  disabled,
  children,
  className = 'tools',
}: {
  tools: TextTools;
  thread: boolean;
  attach: () => void;
  attachId: string;
  disabled?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Button id={attachId} className="tool sans" disabled={disabled} onClick={attach}>
        attach image
      </Button>
      <Button
        className="tool sans"
        data-action="link-clipboard"
        disabled={disabled}
        title="Read a URL from the clipboard, strip its trackers, and insert it at the cursor — or over the selected text"
        onClick={() => void tools.linkFromClipboard()}
      >
        🔗 link from clipboard
      </Button>
      <Button
        className="tool sans"
        data-action="scan"
        disabled={disabled}
        title="Scan printed text into the text box with your phone's camera"
        onClick={tools.openScan}
      >
        ⌸ scan text
      </Button>
      <Button
        className="tool"
        data-action="bracket-link"
        disabled={disabled}
        aria-label="[[ link an item"
        onClick={() => tools.bracket('[[')}
      >
        [[
      </Button>
      {thread ? (
        <Button
          className="tool"
          data-action="bracket-quote"
          disabled={disabled}
          aria-label="![[ quote an item"
          onClick={() => tools.bracket('![[')}
        >
          ![[
        </Button>
      ) : null}
      <Button
        className="tool"
        data-action="tk"
        disabled={disabled}
        aria-label="[TK] instruction"
        onClick={tools.tk}
      >
        [TK]
      </Button>
      {children}
    </div>
  );
}

/* ---------------- ⧉ copy + link, share… ---------------- */

/** What the studio knows of another item, for plain text. Own items only. */
const resolveOwn: Resolve = (id, form) => {
  const row = items.get(id);
  if (!row || row.status !== 'public') return undefined;
  return form === 'link' ? itemTitle(row.content_md) : plainText(row.content_md);
};
async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(done);
}
function useSharing() {
  const settings = useSettings();
  const base = settings?.site_url || new URL(`${mount}/`, location.origin).href;
  const url = (item: Shareable) => permalink(base, item.kind, item.id);
  return {
    copy: (item: Shareable) =>
      copyText(textWithLink(plainText(item.md, resolveOwn), url(item)), 'copied text + link'),
    async share(item: Shareable) {
      const text = plainText(item.md, resolveOwn);
      if (navigator.share) {
        try {
          await navigator.share({ title: itemTitle(item.md), text, url: url(item) });
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
        }
      }
      await copyText(textWithLink(text, url(item)), 'no share sheet here — copied text + link instead');
    },
  };
}
/** A row's published words: the working copy when it has no unpublished changes. */
async function publishedOf(item: Row): Promise<Shareable> {
  const kind = item.kind === 'thread' ? 'thread' : 'fragment';
  if (!item.dirty) return { id: item.id, kind, md: item.content_md };
  const detail = await unwrap(BlyggerApi.getItem({ client, path: { id: item.id } }));
  return { id: item.id, kind, md: detail.published?.content_md ?? detail.content_md };
}

/** "published vN" with the permalink, copy + link and share… (Thicket's publish-success). */
function PublishedBanner({
  published,
  dismiss,
}: {
  published: Published | undefined;
  dismiss: () => void;
}) {
  const sharing = useSharing();
  if (!published) return null;
  return (
    <div className="published" role="status" id="published-banner">
      <span className="mark" aria-hidden="true">
        ✓
      </span>
      <span className="txt">published v{published.version}</span>
      <Button className="x" aria-label="dismiss" onClick={dismiss}>
        ×
      </Button>
      <div className="acts">
        <a
          className="btn btn-ghost btn-mini"
          href={publicPath(published)}
          target="_blank"
          rel="noreferrer"
        >
          public permalink ↗
        </a>
        <Button
          className="btn btn-ghost btn-mini"
          data-action="copy-link"
          title="This item's text plus its permalink, ready to paste into another app"
          onClick={() => void sharing.copy(published)}
        >
          ⧉ copy + link
        </Button>
        <Button
          className="btn btn-ghost btn-mini"
          data-action="share"
          onClick={() => void sharing.share(published)}
        >
          share…
        </Button>
      </div>
    </div>
  );
}

/**
 * Image uploads for both composers. An image goes where the author is
 * writing, not at the end (session 30, Venkat): at the caret when the attach
 * button is pressed, in place of a `/image` line, or where an image is pasted
 * or dropped. A placeholder holds the spot while the upload runs, so text
 * typed meanwhile cannot shift where the image lands; it is replaced by the
 * real markdown on success and removed on failure.
 */
function useUpload(
  id: string | undefined | (() => Promise<string | undefined>),
  textarea: React.RefObject<HTMLTextAreaElement | null>,
  setText: (text: string) => void,
) {
  const input = useRef<HTMLInputElement>(null);
  const action = useAction();
  const [attached, setAttached] = useState('');
  // Where the next picked file goes; captured when the picker opens, because
  // the textarea loses its selection while the file dialog has focus.
  const target = useRef<{ start: number; end: number } | null>(null);
  const current = () => textarea.current?.value ?? '';
  const caret = () => {
    const el = textarea.current;
    return el ? { start: el.selectionStart, end: el.selectionEnd } : { start: current().length, end: current().length };
  };
  const upload = async (file: File, at: { start: number; end: number }) => {
    const itemId = typeof id === 'function' ? await id() : id;
    const token = uploadToken(file.name || 'image');
    const placed = insertBlock(current(), at.start, at.end, token);
    setText(placed.text);
    try {
      const media = await unwrap(
        BlyggerApi.uploadMedia({
          client,
          // inline: placed in the text, so shown only where its line is (studio#24).
          body: { file, inline: 'true', ...(itemId ? { item_id: itemId } : {}) },
        }),
      );
      setText(current().replace(token, `![](${mount}/${media.url})`));
      setAttached(media.url);
      if (itemId) await changed('item');
    } catch (error) {
      const now = current();
      const i = now.indexOf(token);
      if (i >= 0) setText(now.slice(0, i) + now.slice(i + token.length));
      throw error;
    }
  };
  const uploadFiles = (files: Iterable<File>, at: { start: number; end: number }) => {
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return false;
    void action.run(async () => {
      for (const file of images) await upload(file, at);
    });
    return true;
  };
  const pick = (at = caret()) => {
    target.current = at;
    input.current?.click();
  };
  // Leaving mid-upload strands the placeholder in the saved draft and the
  // image at the bottom of the page (studio#24), so it asks first.
  useBlocker({
    enableBeforeUnload: () => action.busy,
    shouldBlockFn: async () =>
      action.busy &&
      !(await confirm({
        title: 'An image is still uploading. Leave anyway? It will not be placed in the text.',
        ok: 'leave',
        danger: true,
      })),
  });
  return {
    input,
    action,
    attached,
    pick,
    /**
     * Call from the textarea's onChange with the new value. Returns the value
     * to keep: a completed `/image` line is removed and opens the picker.
     */
    command(value: string): string {
      const el = textarea.current;
      const at = el ? el.selectionStart : value.length;
      const hit = imageCommandAt(value, at);
      if (!hit) return value;
      const rest = value.slice(0, hit.start) + value.slice(hit.end);
      pick({ start: hit.start, end: hit.start });
      return rest;
    },
    textareaProps: {
      onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (uploadFiles(event.clipboardData.files, caret())) event.preventDefault();
      },
      onDragOver: (event: React.DragEvent<HTMLTextAreaElement>) => {
        if ([...event.dataTransfer.items].some((i) => i.kind === 'file')) event.preventDefault();
      },
      onDrop: (event: React.DragEvent<HTMLTextAreaElement>) => {
        if (uploadFiles(event.dataTransfer.files, caret())) event.preventDefault();
      },
    },
    element: (
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) uploadFiles([file], target.current ?? caret());
          event.target.value = '';
        }}
      />
    ),
  };
}
/** The upload's textarea handlers with pour-over in front of its paste. */
function textareaProps(upload: ReturnType<typeof useUpload>, tools: TextTools) {
  return {
    ...upload.textareaProps,
    onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!tools.pourOver(event)) upload.textareaProps.onPaste(event);
    },
  };
}
/**
 * The changelog note, confirmed before a new version publishes (#40, session
 * 33). Version 1 has nothing to describe and never asks. For a later version
 * the dialog opens whenever there is a note to confirm: one typed by hand, one
 * from *draft note*, or — when Settings' auto_change_notes is on and the field
 * was left empty — one drafted now. An empty note with the setting off
 * publishes straight away, as before. `generated` is true only when the
 * confirmed text is exactly what the model drafted.
 */
type NoteChoice = { note: string; generated: boolean };
function useNoteConfirm(write: ReturnType<typeof createDraftAction>) {
  const settings = useSettings();
  const [state, setState] = useState<{
    version: number;
    text: string;
    drafted?: string;
    loading: boolean;
    error?: unknown;
    resolve: (choice: NoteChoice | null) => void;
  }>();
  const request = (
    item: { id: string; version: number },
    note: string,
    drafted?: string,
  ): Promise<NoteChoice | null> => {
    const typed = note.trim();
    if (item.version === 0) return Promise.resolve({ note: typed, generated: false });
    const auto = !typed && !!settings?.auto_change_notes;
    if (!typed && !auto) return Promise.resolve({ note: '', generated: false });
    return new Promise((resolve) => {
      setState({ version: item.version + 1, text: typed, drafted, loading: auto, resolve });
      if (!auto) return;
      write({ type: 'draft-note' })
        .then((r) => setState((s) => s && { ...s, text: r.note, drafted: r.note, loading: false }))
        .catch((error) => setState((s) => s && { ...s, loading: false, error }));
    });
  };
  const finish = (choice: NoteChoice | null) => {
    state?.resolve(choice);
    setState(undefined);
  };
  const element = (
    <Modal
      open={!!state}
      close={() => finish(null)}
      title={state ? `Version ${state.version}` : ''}
      closeButton={false}
    >
      {state ? (
        <div className="note-confirm" id="note-confirm">
          <label htmlFor="note-confirm-text">Change</label>
          <textarea
            id="note-confirm-text"
            value={state.text}
            disabled={state.loading}
            placeholder={state.loading ? 'Drafting a note…' : 'what changed? (optional)'}
            onChange={(e) => setState({ ...state, text: e.target.value })}
          />
          {state.drafted !== undefined && state.text.trim() === state.drafted ? (
            <p className="h-hint" id="note-confirm-generated">
              Drafted by the model; it will be marked as generated unless you
              edit it.
            </p>
          ) : null}
          {state.error ? (
            <p className="h-hint">
              No note could be drafted:{' '}
              {state.error instanceof Error ? state.error.message : String(state.error)}.
              Write one, or confirm without.
            </p>
          ) : null}
          <div className="sheet-actions">
            <Button
              id="note-confirm-ok"
              className="btn btn-primary"
              disabled={state.loading}
              onClick={() =>
                finish({
                  note: state.text.trim(),
                  generated: state.drafted !== undefined && state.text.trim() === state.drafted,
                })
              }
            >
              Confirm
            </Button>
            <Button id="note-confirm-cancel" className="btn btn-ghost" onClick={() => finish(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
  return { request, element };
}

/* ---------------- COMPOSE ---------------- */

const FILTERS = {
  all: { label: 'all', test: () => true },
  drafts: { label: 'drafts', test: (i: Row) => i.version === 0 },
  changes: { label: 'unpublished changes', test: (i: Row) => i.dirty && i.status === 'public' },
  public: { label: 'public', test: (i: Row) => i.status === 'public' },
  withdrawn: { label: 'withdrawn', test: (i: Row) => i.status === 'withdrawn' },
} satisfies Record<string, { label: string; test: (i: Row) => boolean }>;
type Filter = keyof typeof FILTERS;

export function Compose() {
  useChrome({ framed: false });
  const navigate = useNavigate();
  const action = useAction();
  const [text, setText] = useState('');
  const [kind, setKind] = useState<Kind>('fragment');
  const [id, setId] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [published, setPublished] = useState<Published>();
  const [filter, setFilter] = useState<Filter>('all');
  const input = useRef<HTMLTextAreaElement>(null);
  const result = useLiveQuery({
    query: (q) =>
      q.from({ item: items }).orderBy(({ item }) => item.updated, 'desc'),
  });
  usePoll('items', refreshItems);
  const current = useRef({ text, kind, id });
  current.current = { text, kind, id };
  const [draftKey, setDraftKey] = useState(0);
  const write = useMemo(() => createDraftAction(), [draftKey]);
  const save = async () => {
    const snapshot = { text: current.current.text, kind: current.current.kind };
    const result = await write({ type: 'save', text: snapshot.text, kind: snapshot.kind });
    const savedId = result.id;
    setId(savedId);
    current.current.id = savedId;
    if (current.current.text !== snapshot.text || current.current.kind !== snapshot.kind)
      return undefined;
    setSaved(true);
    return savedId;
  };
  useBlocker({
    enableBeforeUnload: () => !!current.current.text && !saved,
    shouldBlockFn: async () => {
      if (!current.current.text || saved) return false;
      try {
        return !(await save());
      } catch (error) {
        await action.run(async () => {
          throw error;
        });
        return true;
      }
    },
  });
  // Autosave (studio#23): text in the composer used to reach the server only
  // through save, publish, the editor button or an in-app navigation, so a
  // crashed tab or a closed laptop lost it. The first save creates the draft,
  // so it waits for a pause and a few real characters — a stray keystroke
  // should not leave an item behind; after that, edits save like the editor's.
  useEffect(() => {
    if (saved || !text.trim()) return;
    if (!id && (text.replace(/\s/g, '').length < 8)) return;
    const timer = setTimeout(() => void action.run(save), id ? 400 : 3000);
    return () => clearTimeout(timer);
  }, [text, kind, id, saved]);
  const change = (next: string) => {
    setText(next);
    setSaved(false);
  };
  const upload = useUpload(save, input, change);
  const tools = useTextTools(input, change);
  const setKindTo = (value: Kind) => {
    setKind(value);
    setSaved(false);
  };
  const openEditor = async () => {
    const savedId = await save();
    if (savedId) await navigate({ to: '/edit/$id', params: { id: savedId } });
  };
  const publish = async () => {
    const savedId = await save();
    if (!savedId) return;
    const result = await write({ type: 'publish', note: '', generated: false });
    setPublished({ id: savedId, kind, md: text, version: result.version });
    if (current.current.text === text) {
      setText('');
      setId(undefined);
      current.current.id = undefined;
      setDraftKey(key => key + 1);
      setSaved(false);
    }
    return result;
  };
  const rows = result.data ?? [];
  const shown = rows.filter(FILTERS[filter].test);
  const over = text.length > MAX && kind === 'fragment';
  return (
    <>
      <h2 className="view-h">compose</h2>
      <Help className="view-sub" />
      <PublishedBanner published={published} dismiss={() => setPublished(undefined)} />
      <div className="card composer">
        <div className="segmented" role="radiogroup" aria-label="kind">
          {(['fragment', 'thread'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              data-kind={value}
              className={kind === value ? 'seg is-active' : 'seg'}
              onClick={() => setKindTo(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="ta-wrap">
          <textarea
            ref={input}
            id="composer-text"
            aria-label="compose"
            placeholder={`compose a ${kind}…`}
            value={text}
            {...textareaProps(upload, tools)}
            onChange={(e) => change(upload.command(e.target.value))}
          />
          <BracketPicker
            input={input}
            text={text}
            change={change}
            allowTransclude={kind === 'thread'}
          />
          {tools.coach}
        </div>
        <ToolRow
          tools={tools}
          thread={kind === 'thread'}
          attach={() => upload.pick()}
          attachId="composer-attach"
          className="composer-tools"
        >
          <Button
            id="composer-full"
            className="tool sans"
            disabled={action.busy}
            onClick={() => void action.run(openEditor)}
          >
            Full Editor →
          </Button>
          <span className={over ? 'counter over' : 'counter'} id="composer-count">
            {/* Only fragments have a length limit; a thread shows its count alone. */}
            {kind === 'thread' ? `${text.length} chars` : `${text.length} / ${MAX}`}
          </span>
        </ToolRow>
        {over ? (
          <p className="hint over-hint">
            Too long for a fragment ·{' '}
            <button type="button" className="link" onClick={() => setKindTo('thread')}>
              make this a thread
            </button>
          </p>
        ) : null}
        <div className="composer-actions">
          <span className="save-state" id="composer-state" hidden={!saved}>
            {saved ? 'saved' : ''}
          </span>
          <span className="spacer" />
          {text.includes('[TK]') ? (
            <Button
              className="btn btn-ghost btn-mini"
              onClick={() => void action.run(openEditor)}
            >
              generate in editor →
            </Button>
          ) : null}
          <Button
            id="save-draft-btn"
            className="btn btn-ghost"
            disabled={action.busy}
            onClick={() => void action.run(save)}
          >
            save draft
          </Button>
          <Button
            id="publish-btn"
            className="btn btn-primary"
            disabled={action.busy}
            onClick={() => void action.run(publish)}
          >
            publish
          </Button>
        </div>
        {upload.element}
        <Failure error={action.error || upload.action.error} />
        {action.warning ? (
          <p role="status" className="publish-warning">
            {action.warning}
          </p>
        ) : null}
      </div>
      {tools.sheet}
      {rows.length ? (
        <div className="segmented filters" role="group" aria-label="show">
          {(Object.keys(FILTERS) as Filter[]).map((key) => (
            <button
              key={key}
              type="button"
              data-filter={key}
              aria-pressed={filter === key}
              className={filter === key ? 'seg is-active' : 'seg'}
              onClick={() => setFilter(key)}
            >
              {FILTERS[key].label}
              <span className="n">{rows.filter(FILTERS[key].test).length}</span>
            </button>
          ))}
        </div>
      ) : null}
      {!result.isLoading && !rows.length ? (
        <p className="empty">
          <span className="em" aria-hidden="true">
            ✎
          </span>
          Nothing yet — compose your first fragment above.
        </p>
      ) : rows.length && !shown.length ? (
        <p className="empty">Nothing here.</p>
      ) : null}
      <ol className="list items">
        {shown.map((item) => (
          <ItemRow key={item.id} item={item} onPublished={setPublished} />
        ))}
      </ol>
    </>
  );
}
function rowDot(item: Row) {
  if (item.status === 'withdrawn') return 'withdrawn';
  if (item.version === 0) return 'draft';
  return item.dirty ? 'dirty' : 'public';
}
function ItemRow({
  item,
  onPublished,
}: {
  item: Row;
  onPublished: (published: Published) => void;
}) {
  const settings = useSettings();
  const sharing = useSharing();
  const action = useAction();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(item.content_md);
  const [saved, setSaved] = useState(false);
  const write = useMemo(() => createDraftAction(item.id), [item.id]);
  const confirmNote = useNoteConfirm(write);
  const draft = useRef<Draft | null>(null);
  if (!draft.current)
    draft.current = new Draft(item.content_md, async (content) => {
      await write({ type: 'save', text: content });
    });
  const kind: Kind = item.kind === 'thread' ? 'thread' : 'fragment';
  const publishRow = async () => {
    const choice = await confirmNote.request(item, '');
    if (!choice) return;
    const md = draft.current!.text;
    const result = await write({ type: 'publish', note: choice.note, generated: choice.generated });
    onPublished({ id: item.id, kind, md, version: result.version });
    return result;
  };
  const save = async () => {
    const current = await draft.current!.save();
    if (current) setSaved(true);
    return current;
  };
  useBlocker({
    enableBeforeUnload: () => draft.current!.dirty,
    shouldBlockFn: async () => {
      if (!draft.current!.dirty) return false;
      try {
        return !(await save());
      } catch (error) {
        await action.run(async () => {
          throw error;
        });
        return true;
      }
    },
  });
  const quickEdit = (value: string) => {
    draft.current!.edit(value);
    setText(value);
    setSaved(false);
  };
  const { count, withoutDirectives } = extractDirectives(item.content_md);
  const stripped = previewStrip(
    withoutDirectives,
    parseScopes(withoutDirectives).scopes,
  );
  const html = renderMarkdown(stripped.text);
  const own = previewFromHtml(html);
  // An item that only quotes or links has no prose of its own, and read
  // "(empty draft)" here. Ask the preview endpoint once for what the reader
  // and public pages show (quotes baked, links resolved); until it answers,
  // say what the item does.
  const LINK = /(?<!!)\[\[[^\]\n]+\]\]/g;
  const links = (item.content_md.match(LINK) ?? []).length;
  // Bare [[id]] tokens are not prose: without them, is anything left?
  const prose = links ? previewFromHtml(renderMarkdown(stripped.text.replace(LINK, ''))) : own;
  const ownEmpty = !prose.title && !prose.body;
  const [resolved, setResolved] = useState<ReturnType<typeof previewFromHtml> | null>(null);
  useEffect(() => {
    if (!ownEmpty || !(count || links)) return;
    let live = true;
    unwrap(BlyggerApi.preview({ client, body: { content_md: item.content_md, item_id: item.id, kind: item.kind === 'thread' ? 'thread' : 'fragment' } }))
      .then((r) => live && setResolved(previewFromHtml(r.html)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ownEmpty, item.content_md]);
  const preview = ownEmpty && resolved && (resolved.title || resolved.body) ? resolved : own;
  const doesOnly = count ? `Only quotes ${count} item${count === 1 ? '' : 's'}` : links ? `Only links ${links} item${links === 1 ? '' : 's'}` : null;
  const mutate = (fn: () => Promise<unknown>) =>
    void action.run(async () => {
      if (draft.current!.dirty && !(await save())) return;
      return fn();
    });
  const dot = rowDot(item);
  const pin = async () => {
    if (
      await confirm({
        title: `Pin v${item.version}? It will stay fetchable forever.`,
        ok: `pin v${item.version}`,
      })
    )
      mutate(() => write({ type: 'pin', version: item.version }));
  };
  return (
    <li
      className={`item-row${expanded ? ' is-open' : ''}${item.dirty && item.status === 'public' ? ' dirty' : ''}`}
      data-id={item.id}
    >
      <button
        type="button"
        className="item-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={`dot ${dot}`} title={item.status} />
        <span className="item-main">
          <span className={preview.title || preview.body ? 'item-title' : 'item-title empty'}>
            {preview.title || preview.body || doesOnly || '(empty draft)'}
          </span>
          {preview.title && preview.body ? (
            <span className="item-excerpt">{preview.body}</span>
          ) : null}
          <span className="item-meta">
            {item.kind === 'thread' ? <span className="badge">thread</span> : null}
            {count ? <span className="badge">⧉{count}</span> : null}
            {item.stub_of ? <span className="badge">stub</span> : null}
            {item.forked_from ? <span className="badge">fork</span> : null}
            <span>
              {item.status} · v{item.version}
              {item.dirty && item.status === 'public' ? (
                <>
                  {' · '}
                  <b className="unpublished">unpublished changes</b>
                </>
              ) : null}
            </span>
          </span>
        </span>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </button>
      {expanded ? (
        <div className="item-detail">
          {open ? (
            <div className="quick-edit" id={`qe-${item.id}`}>
              <textarea
                aria-label="quick edit"
                value={text}
                onPaste={(event) => void pourOver(event, quickEdit)}
                onChange={(event) => quickEdit(event.target.value)}
              />
              <div className="row qe-bar">
                {saved ? <span className="save-state">saved</span> : null}
                <span className="spacer" />
                <Button className="btn btn-ghost btn-mini" onClick={() => setOpen(false)}>
                  done
                </Button>
                <Button
                  className="btn btn-ghost btn-mini"
                  disabled={action.busy}
                  onClick={() => void action.run(save)}
                >
                  save draft
                </Button>
                <Button
                  className="btn btn-primary btn-mini"
                  disabled={action.busy}
                  onClick={() => mutate(publishRow)}
                >
                  publish
                </Button>
              </div>
              <Help className="hint" />
            </div>
          ) : (
            <Html html={html} />
          )}
          <div className="facts">
            <span>
              Created: {formatDateIn(item.created, settings?.timezone || 'UTC')}
            </span>
            {item.version > 0 ? (
              <span className="version-summary">
                <Link to="/edit/$id" params={{ id: item.id }} hash="history">
                  {item.version} version{item.version === 1 ? '' : 's'}
                </Link>
                {item.pins?.length ? (
                  <span className="pin-chips">
                    {' · '}
                    {item.pins.map((pin) => (
                      <a
                        key={pin.version}
                        href={`${mount}/${pin.kind === 'thread' ? 't' : 'f'}/${
                          item.id
                        }/v${pin.version}/`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        📌 v{pin.version}
                      </a>
                    ))}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          {confirmNote.element}
          <Failure error={action.error} />
          {action.warning ? (
            <p role="status" className="publish-warning">
              {action.warning}
            </p>
          ) : null}
          <div className="actions">
            {item.kind === 'fragment' && item.status !== 'withdrawn' ? (
              <Button
                data-action="quick-edit"
                className={open ? 'btn btn-ghost btn-mini is-on' : 'btn btn-ghost btn-mini'}
                onClick={() => {
                  if (!draft.current!.dirty) {
                    draft.current!.accept(item.content_md);
                    setText(item.content_md);
                  }
                  setOpen((value) => !value);
                }}
              >
                quick edit
              </Button>
            ) : null}
            <Link className="btn btn-ghost btn-mini" to="/edit/$id" params={{ id: item.id }}>
              full editor
            </Link>
            {item.version === 0 || item.dirty || item.status === 'withdrawn' ? (
              <Button
                className="btn btn-primary btn-mini"
                disabled={action.busy}
                onClick={() => mutate(publishRow)}
              >
                {item.status === 'withdrawn' ? 'republish' : 'publish'}
              </Button>
            ) : null}
            {item.version === 0 ? (
              <Button
                className="btn btn-danger btn-mini"
                disabled={action.busy}
                onClick={async () => {
                  if (
                    await confirm({
                      title: 'Discard this unpublished draft?',
                      ok: 'discard',
                      danger: true,
                    })
                  )
                    void action.run(async () => {
                      await write({ type: 'delete' });
                      await changed('items', 'reading');
                      toast('Draft discarded', { tone: 'ok' });
                    });
                }}
              >
                discard
              </Button>
            ) : item.status === 'public' ? (
              <>
                <Button
                  className="btn btn-ghost btn-mini"
                  data-action="copy-link"
                  title="This item's text plus its permalink, ready to paste into another app"
                  onClick={() => void action.run(async () => sharing.copy(await publishedOf(item)))}
                >
                  ⧉ copy + link
                </Button>
                <Button
                  className="btn btn-ghost btn-mini"
                  data-action="share"
                  onClick={() => void action.run(async () => sharing.share(await publishedOf(item)))}
                >
                  share…
                </Button>
                <Button
                  className="btn btn-ghost btn-mini"
                  disabled={action.busy}
                  onClick={() => void pin()}
                >
                  pin v{item.version}…
                </Button>
                <Button
                  className="btn btn-danger btn-mini"
                  disabled={action.busy}
                  onClick={async () => {
                    if (
                      await confirm({
                        title:
                          'Withdraw this item? This publishes a permanent endcap.',
                        ok: 'withdraw',
                        danger: true,
                      })
                    )
                      mutate(() => write({ type: 'withdraw' }));
                  }}
                >
                  withdraw
                </Button>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        confirmNote.element
      )}
    </li>
  );
}

/* ---------------- EDITOR ---------------- */

export function EditorPage({ id }: { id: string }) {
  useChrome({ tabs: false, framed: false });
  const collection = useMemo(() => itemDetail(id), [id]);
  usePoll('items', refreshItems);
  const result = useLiveQuery({
    query: (q) => q.from({ item: collection }),
  });
  return result.data?.[0] ? (
    <Editor key={id} item={result.data[0]} />
  ) : (
    <p role={result.isReady ? 'alert' : undefined}>
      {result.isReady ? 'Item not found.' : 'Loading editor…'}
    </p>
  );
}
/** A collapsible card whose open state the screen can also set. */
function Card({
  id,
  open,
  setOpen,
  summary,
  hint,
  children,
}: {
  id?: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  summary: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details
      className="card"
      id={id}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {summary}
        {hint !== undefined ? <span className="muted">{hint}</span> : null}
      </summary>
      {children}
    </details>
  );
}
const initiallyOpen = (hash: string) => location.hash === `#${hash}`;
function Editor({ item }: { item: Detail }) {
  const navigate = useNavigate();
  const settings = useSettings();
  const sharing = useSharing();
  const action = useAction();
  const write = useMemo(() => createDraftAction(item.id), [item.id]);
  const draft = useRef<Draft | null>(null);
  if (!draft.current) {
    draft.current = new Draft(item.content_md, async (text) => {
      await write({ type: 'save', text });
    });
    const cleaned = stripStaleUploads(item.content_md);
    if (cleaned !== item.content_md) draft.current.edit(cleaned);
  }
  const [text, setText] = useState(draft.current.text);
  const [note, setNote] = useState('');
  // The note the studio drafted (#40); `generated` is sent only while the
  // field still holds exactly that text — an edit makes the words the author's.
  const [drafted, setDrafted] = useState<string>();
  const confirmNote = useNoteConfirm(write);
  const [preview, setPreview] =
    useState<Awaited<ReturnType<typeof getPreview>>>();
  const [version, setVersion] = useState<Version>();
  const [saved, setSaved] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [published, setPublished] = useState<Published>();
  // Phones show one pane at a time; ≥900px shows both (authoring.css).
  const [pane, setPane] = useState<'draft' | 'preview'>('draft');
  const [noteOpen, setNoteOpen] = useState(false);
  const [tkOpen, setTkOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(() => initiallyOpen('history'));
  const leaving = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const save = async () => {
    clearTimeout(saveTimer.current);
    const current = await draft.current!.save();
    if (current) setSaved(true);
    return current;
  };
  useBlocker({
    enableBeforeUnload: () => !leaving.current && draft.current!.dirty,
    shouldBlockFn: async () => {
      if (leaving.current || !draft.current!.dirty) return false;
      try {
        return !(await save());
      } catch (error) {
        await action.run(async () => {
          throw error;
        });
        return true;
      }
    },
  });
  const edit = (text: string) => {
    draft.current!.edit(text);
    setText(text);
    setSaved(false);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void action.run(save), 400);
  };
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void getPreview(text, item.id, item.authored_kind, controller.signal)
        .then(setPreview)
        .catch((error) => {
          if (!controller.signal.aborted)
            setPreview({
              html: '',
              scopes: [],
              errors: [
                {
                  reason:
                    error instanceof Error ? error.message : String(error),
                },
              ],
            });
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, item.id, item.authored_kind]);
  const upload = useUpload(item.id, input, edit);
  const tools = useTextTools(input, edit);
  const operation = (fn: () => Promise<unknown>) =>
    void action.run(async () => {
      if (!(await save())) return;
      return fn();
    });
  const switchKind = () => write({ type: 'update', changes: {
    kind: item.authored_kind === 'fragment' ? 'thread' : 'fragment',
  } });
  const restore = async (version: number, discardChanges = false) => {
    const question = discardChanges
      ? {
          title: `Discard unpublished changes and go back to the published v${version}?`,
          body: `The public item is not affected — it is already v${version}.`,
          ok: 'discard changes',
          danger: true,
        }
      : {
          title: `Restore v${version} into the working copy?`,
          body: `Nothing is published yet and no version is rewound — this replaces your current draft, which you would then publish as v${
            item.version + 1
          }.`,
          ok: `restore → v${item.version + 1}`,
        };
    if (!(await confirm(question))) return;
    clearTimeout(saveTimer.current);
    setReplacing(true);
    try {
      const restored = await write({ type: 'restore', version });
      draft.current!.accept(restored.content_md);
      setText(restored.content_md);
      setSaved(true);
    } finally {
      setReplacing(false);
    }
  };
  const discardDraft = async () => {
    if (
      !(await confirm({
        title: 'Discard this draft? It was never published.',
        ok: 'discard draft',
        danger: true,
      }))
    )
      return;
    clearTimeout(saveTimer.current);
    setReplacing(true);
    try {
      await write({ type: 'delete' });
      leaving.current = true;
      await navigate({ to: '/' });
      await changed('items', 'reading');
      toast('Draft discarded', { tone: 'ok' });
    } finally {
      setReplacing(false);
    }
  };
  const withdraw = async () => {
    if (
      !(await confirm({
        title:
          "Withdraw this item? This publishes a permanent endcap — reversible by republishing, but the withdrawal itself can't be undone.",
        ok: 'withdraw',
        danger: true,
      }))
    )
      return;
    operation(() => write({ type: 'withdraw' }));
  };
  const generate = async (scope: number) => {
    const revision = draft.current!.revision;
    const result = await write({ type: 'generate', scope });
    // `text` is the scope's output alone; the draft is the whole document with
    // it spliced in, which the server has already saved. Replacing the draft
    // with `text` threw away everything around the scope (0.10.0–0.27.1).
    if (draft.current!.revision === revision) edit(result.content_md);
  };
  const pin = async (version: number) => {
    if (
      !(await confirm({
        title: `Pin v${version}? This is irrevocable — it stays fetchable forever, even past withdrawal.`,
        ok: 'pin',
      }))
    )
      return;
    await write({ type: 'pin', version });
  };
  const publish = () =>
    operation(async () => {
      const choice = await confirmNote.request(item, note, drafted);
      if (!choice) return;
      const md = draft.current!.text;
      const result = await write({ type: 'publish', note: choice.note, generated: choice.generated });
      // A note describes one change; it must not ride along on the next.
      setNote('');
      setDrafted(undefined);
      setPublished({ id: item.id, kind: item.authored_kind, md, version: result.version });
      return result;
    });
  const isThread = item.authored_kind === 'thread';
  const isPublic = item.status === 'public';
  const edited = !saved && text !== item.content_md;
  // Unpublished changes, discounting a working copy that already holds the
  // published words again (discard changes leaves `dirty` set on purpose).
  const unpublished =
    edited ||
    (item.dirty &&
      !(
        text === item.published?.content_md &&
        !item.published?.generated.length
      ));
  const scopes = preview?.scopes ?? [];
  // A card opens when it has something to say; the author can close it again.
  useEffect(() => {
    if (item.version > 0 && unpublished) setNoteOpen(true);
  }, [item.version > 0 && unpublished]);
  useEffect(() => {
    if (scopes.length) setTkOpen(true);
  }, [scopes.length > 0]);
  useEffect(() => {
    if (upload.attached) setMediaOpen(true);
  }, [upload.attached]);
  const shareable: Shareable = {
    id: item.id,
    kind: item.authored_kind,
    md: item.published?.content_md ?? item.content_md,
  };
  const more = () =>
    void menu({
      rows: [
        item.status === 'draft' && {
          icon: '⇄',
          label: `make this a ${isThread ? 'fragment' : 'thread'}`,
          onSelect: () => operation(switchKind),
        },
        isPublic && {
          icon: '↗',
          label: 'public permalink ↗',
          onSelect: () => void window.open(publicPath(shareable), '_blank', 'noreferrer'),
        },
        isPublic && {
          icon: '⧉',
          label: 'copy + link',
          description: "this item's text plus its permalink, for pasting into another app",
          onSelect: () => void sharing.copy(shareable),
        },
        isPublic && {
          icon: '⇪',
          label: 'share…',
          onSelect: () => void sharing.share(shareable),
        },
        isPublic && {
          icon: '📌',
          label: `pin v${item.version}…`,
          onSelect: () => void action.run(() => pin(item.version)),
        },
        item.version === 0 && {
          icon: '✕',
          label: 'discard draft',
          danger: true,
          disabled: action.busy || upload.action.busy,
          onSelect: () => void action.run(discardDraft),
        },
        isPublic &&
          (item.dirty || edited) && {
            icon: '↺',
            label: 'discard changes',
            danger: true,
            disabled: action.busy || upload.action.busy,
            onSelect: () => void action.run(() => restore(item.version, true)),
          },
        isPublic && {
          icon: '⊘',
          label: 'withdraw',
          danger: true,
          disabled: action.busy,
          onSelect: () => void withdraw(),
        },
      ],
    });
  const over = text.length > MAX && !isThread;
  return (
    <div className="editor">
      <p className="ed-head">
        <Link to="/">← compose</Link> · {item.authored_kind} · {item.status} · v
        {item.version}
        {item.version > 0 && unpublished ? (
          <>
            {' '}
            <span className="badge badge-warn" id="unpublished-badge">
              unpublished changes
            </span>
          </>
        ) : null}
      </p>
      <PublishedBanner published={published} dismiss={() => setPublished(undefined)} />
      <div id="error-banner-slot">
        <Failure error={action.error || upload.action.error} />
        {action.warning ? (
          <p role="status" className="publish-warning">
            {action.warning}
          </p>
        ) : null}
        {preview?.link_errors?.map((e, i) => (
          <Failure key={`link:${i}`} error={e.reason} />
        ))}
        {preview?.errors?.map((e, i) => <Failure key={i} error={e.reason} />)}
      </div>
      {item.stub_of ? (
        <p className="stub-head">
          stub of {'url' in item.stub_of ? item.stub_of.url : item.stub_of.id}{' '}
          <Button
            className="btn btn-ghost btn-mini"
            onClick={() =>
              operation(async () => {
                await write({ type: 'update', changes: { stub_of: null } });
              })
            }
          >
            clear stub
          </Button>
        </p>
      ) : null}
      {item.stub_of && 'id' in item.stub_of && isThread ? (
        <StubQuote
          itemId={item.id}
          target={item.stub_of.id}
          text={text}
          edit={edit}
          input={input}
          fresh={item.version === 0}
        />
      ) : null}
      {item.forked_from ? (
        <p className="stub-head">
          fork of {item.forked_from.id} v{item.forked_from.version}
        </p>
      ) : null}
      <div className="segmented pane-toggle" role="group" aria-label="pane">
        {(['draft', 'preview'] as const).map((value) => (
          <button
            key={value}
            type="button"
            data-pane={value}
            aria-pressed={pane === value}
            className={pane === value ? 'seg is-active' : 'seg'}
            onClick={() => setPane(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="editor-grid" data-pane={pane}>
        <div className="editor-pane">
          <ToolRow
            tools={tools}
            thread={isThread}
            attach={() => upload.pick()}
            attachId="attach-btn"
            disabled={replacing}
            className="ed-tools"
          >
            {item.status === 'draft' ? (
              <Button
                className="tool sans"
                data-action="switch-kind"
                onClick={() => operation(switchKind)}
              >
                make this a {isThread ? 'fragment' : 'thread'}
              </Button>
            ) : null}
            <Button
              id="tk-impyrt-btn"
              className="tool sans"
              disabled={replacing}
              title="Wrap the selected text as machine-generated text from another tool"
              onClick={() => {
                const el = input.current;
                if (!el) return;
                const value = draft.current!.text;
                const [from, to] = [el.selectionStart, el.selectionEnd];
                if (from === to) {
                  toast('Select the pasted generated text first, then mark it.');
                  return;
                }
                edit(markImported(value, from, to));
              }}
            >
              mark selection as generated
            </Button>
          </ToolRow>
          <div className="ta-wrap">
            <textarea
              id="md-input"
              className="md"
              aria-label="draft"
              readOnly={replacing}
              ref={input}
              value={text}
              {...textareaProps(upload, tools)}
              onChange={(event) => edit(upload.command(event.target.value))}
            />
            {!replacing ? (
              <BracketPicker
                input={input}
                text={text}
                change={edit}
                allowTransclude={isThread}
              />
            ) : null}
            {tools.coach}
          </div>
          <div className="row ed-foot">
            <span className={over ? 'counter over' : 'counter'}>
              {isThread ? `${text.length} chars` : `${text.length} / ${MAX}`}
            </span>
            <span className="spacer" />
            {isPublic ? (
              <a href={publicPath(shareable)} target="_blank" rel="noreferrer">
                public permalink ↗
              </a>
            ) : null}
          </div>
          <Help thread={isThread} className="hint" />
        </div>
        <div className="preview-pane preview" id="preview-pane" aria-label="preview">
          <Html id="preview-body" html={preview?.html ?? ''} />
        </div>
      </div>
      <div className="ed-cards">
        <Card
          id="note-card"
          open={noteOpen}
          setOpen={setNoteOpen}
          summary="edit note"
          hint={settings?.auto_change_notes && item.version > 0 ? 'drafted for you if empty' : 'optional'}
        >
          <div className="row">
            <input
              id="note-input"
              className="note"
              aria-label="edit note"
              placeholder="what changed? (optional edit note)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {item.version > 0 && isPublic ? (
              <Button
                id="draft-note-btn"
                className="btn btn-ghost btn-mini"
                disabled={action.busy}
                title="Describe the change from the published version; you can edit it before publishing"
                onClick={() =>
                  operation(async () => {
                    const result = await write({ type: 'draft-note' });
                    setNote(result.note);
                    setDrafted(result.note);
                  })
                }
              >
                draft note
              </Button>
            ) : null}
          </div>
          {drafted !== undefined && note.trim() === drafted ? (
            <p className="hint" id="note-generated-hint">
              drafted — published as generated unless you edit it
            </p>
          ) : null}
        </Card>
        <Card id="tk" open={tkOpen} setOpen={setTkOpen} summary="TK scopes" hint={String(scopes.length)}>
          {scopes.length ? (
            <ul className="tk-list">
              {scopes.map((scope) => (
                <li key={scope.index} className="tk-scope-row">
                  {scope.imported ? (
                    <span className="tk-instruction tk-imported">
                      generated elsewhere — disclosed, not regenerated
                    </span>
                  ) : (
                    <>
                      <span className="tk-instruction">{scope.instruction}</span>
                      <Button
                        className="btn btn-primary btn-mini"
                        disabled={action.busy}
                        onClick={() => operation(() => generate(scope.index))}
                      >
                        {scope.hasOutput ? 'regenerate' : 'generate'}
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">
              No TK scopes. Wrap an instruction in <code>[TK]…[/TK]</code>.
            </p>
          )}
          {!isThread ? (
            <div className="row tk-more">
              <Button
                id="tk-generate-whole-btn"
                className="btn btn-ghost btn-mini"
                disabled={replacing}
                onClick={async () => {
                  const instruction = await prompt({
                    title: 'Instruction for the whole fragment:',
                  });
                  if (!instruction) return;
                  const existing = draft.current!.text.trim();
                  edit(
                    `[TK]${instruction}${existing ? `[=]${existing}` : ''}[/TK]`,
                  );
                }}
              >
                generate whole fragment…
              </Button>
            </div>
          ) : null}
          <div className="field tk-highlight">
            <span id="tk-highlight-label">
              Highlight generated portions on the public page:
            </span>
            <div
              className="segmented"
              role="group"
              aria-labelledby="tk-highlight-label"
            >
              {(
                [
                  [
                    'default',
                    `default (${settings?.highlight_generated_default ? 'on' : 'off'})`,
                  ],
                  ['show', 'on'],
                  ['hide', 'off'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  className={item.highlight === value ? 'seg is-active' : 'seg'}
                  aria-pressed={item.highlight === value}
                  disabled={action.busy}
                  onClick={() =>
                    item.highlight === value
                      ? undefined
                      : operation(() =>
                          write({ type: 'update', changes: { highlight: value } }),
                        )
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        </Card>
        <Card
          id="attachments"
          open={mediaOpen}
          setOpen={setMediaOpen}
          summary="attachments"
          hint={String(item.media.length)}
        >
          {upload.attached ? <p className="hint">attached: {upload.attached}</p> : null}
          {item.media.length ? (
            <section className="media">
              {item.media.map((media) => {
                const inText = text.includes(media.url);
                return (
                  <p key={media.id} className="attachment kv" data-media={media.id}>
                    <a
                      href={`${mount}/${media.url}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {media.alt || media.url}
                    </a>{' '}
                    <span className="muted">· {media.mime} ·</span>{' '}
                    <span className="h-hint">
                      {inText
                        ? 'in the text — delete its line to remove it'
                        : media.inline
                          ? 'not in the text, so not shown'
                          : 'shown below the post'}
                    </span>
                    {!inText ? (
                      <>
                        {' '}
                        <Button
                          className="btn btn-danger btn-mini"
                          data-action="remove-media"
                          disabled={action.busy}
                          onClick={() =>
                            void action.run(async () => {
                              await unwrap(
                                BlyggerApi.deleteMedia({
                                  client,
                                  path: { id: media.id },
                                }),
                              );
                              await changed('item');
                            })
                          }
                        >
                          remove
                        </Button>
                      </>
                    ) : null}
                  </p>
                );
              })}
            </section>
          ) : !upload.attached ? (
            <p className="hint">None.</p>
          ) : null}
        </Card>
        {isPublic && isThread ? (
          <QuotedSnapshots id={item.id} version={item.version} unpublished={unpublished} />
        ) : null}
        <Card
          id="history"
          open={historyOpen}
          setOpen={setHistoryOpen}
          summary="history"
          hint={
            item.versions.length
              ? `${item.versions.length} version${item.versions.length === 1 ? '' : 's'}`
              : ''
          }
        >
          {!item.versions.length ? (
            <p className="hint">Not yet published.</p>
          ) : (
            <ul className="h-list">
              {[...item.versions].reverse().map((v) => (
                <li className="h-row" key={v.version}>
                  <strong className="vnum">v{v.version}</strong>{' '}
                  <span className="h-note">{v.note}</span>
                  {v.note_generated ? (
                    <span className="badge" title="note drafted by the studio">generated</span>
                  ) : null}{' '}
                  <span className="h-actions">
                    <Button
                      data-action="view-version"
                      className="btn btn-ghost btn-mini"
                      onClick={() => setVersion(v)}
                    >
                      view
                    </Button>
                    {v.pinned ? (
                      <>
                        <a
                          className="badge badge-pencil"
                          href={`${mount}/${v.kind === 'thread' ? 't' : 'f'}/${
                            item.id
                          }/v${v.version}/`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          📌 pinned
                        </a>
                        <Link className="btn btn-ghost btn-mini" to="/fork" search={{ id: item.id }}>
                          fork
                        </Link>
                      </>
                    ) : v.content_md ? (
                      <Button
                        data-action="pin"
                        className="btn btn-ghost btn-mini"
                        disabled={action.busy}
                        onClick={() => void action.run(() => pin(v.version))}
                      >
                        pin
                      </Button>
                    ) : null}
                    {v.content_md ? (
                      <Button
                        className="btn btn-ghost btn-mini"
                        disabled={action.busy || upload.action.busy}
                        onClick={() => void action.run(() => restore(v.version))}
                      >
                        restore → v{item.version + 1}
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {confirmNote.element}
      {upload.element}
      {tools.sheet}
      <Modal
        open={!!version}
        close={() => setVersion(undefined)}
        title={`version ${version?.version}`}
      >
        <Html id="h-viewer-body" html={version?.content_html ?? ''} />
      </Modal>
      <ActionBar>
        <span className="state">
          {saved ? <b className="save-state">saved</b> : null}
        </span>
        <Button
          className="icon-btn more-btn"
          aria-label="more actions"
          data-action="editor-more"
          onClick={more}
        >
          ⋯
        </Button>
        <Button
          id="save-draft-btn"
          className="btn btn-ghost"
          disabled={action.busy}
          onClick={() => void action.run(save)}
        >
          save draft
        </Button>
        <Button
          id="publish-btn"
          className="btn btn-primary"
          disabled={action.busy}
          onClick={publish}
        >
          {item.status === 'withdrawn' ? 'republish' : 'publish'}
        </Button>
      </ActionBar>
    </div>
  );
}
type Freshness = Awaited<ReturnType<typeof loadFreshness>>;
const loadFreshness = (id: string) =>
  unwrap(BlyggerApi.getItemFreshness({ client, path: { id } }));
const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};
function quoteState(q: Freshness['quotes'][number]): string {
  switch (q.status) {
    case 'current':
      return `current · v${q.baked}`;
    case 'refreshable':
      return `v${q.baked} → v${q.held} available`;
    case 'behind':
      return `v${q.baked} → v${q.live} at its origin (imported on refresh)`;
    case 'retained':
    case 'passage-missing':
      return q.reason ?? q.status;
    case 'unresolvable':
      return `no longer resolves: ${q.reason ?? 'unknown'}`;
  }
}
/**
 * Quoted snapshots (decision #33's direct check; #38: detect always, refresh
 * only on a decision, never silently). A refresh is a republish of the
 * published words, so it waits for unpublished edits to be dealt with, and it
 * says so rather than folding them in.
 */
function QuotedSnapshots({
  id,
  version,
  unpublished,
}: {
  id: string;
  version: number;
  unpublished: boolean;
}) {
  const action = useAction();
  const [report, setReport] = useState<Freshness>();
  const [failed, setFailed] = useState<unknown>();
  const [note, setNote] = useState('refreshed quoted snapshots');
  const [open, setOpen] = useState(() => initiallyOpen('snapshots'));
  useEffect(() => {
    let live = true;
    setFailed(undefined);
    loadFreshness(id)
      .then((r) => live && setReport(r))
      .catch((e) => live && setFailed(e));
    return () => {
      live = false;
    };
  }, [id, version]);
  const stale = !!report?.stale;
  useEffect(() => {
    if (stale) setOpen(true);
  }, [stale]);
  if (failed) return <Failure error={failed} />;
  if (!report || !report.quotes.length) return null;
  const refresh = async () => {
    const result = await unwrap(
      BlyggerApi.refreshItem({ client, path: { id }, body: { note } }),
    );
    await changed('item', 'items', 'reading');
    setReport(await loadFreshness(id));
    return result;
  };
  return (
    <Card
      id="snapshots"
      open={open}
      setOpen={setOpen}
      summary="quoted snapshots"
      hint={
        report.stale
          ? `${report.stale} of ${report.quotes.length} quote an older version`
          : 'all current'
      }
    >
      <ul className="h-list">
        {report.quotes.map((q, i) => (
          <li className={`h-row kv q-${q.status}`} key={`${q.id}-${i}`} data-status={q.status}>
            <code>{q.id.slice(0, 8)}</code>{' '}
            <span className="q-source">{q.origin ? host(q.origin) : 'own'}</span>
            {q.partial ? <span className="badge">excerpt</span> : null}{' '}
            <span className="q-state">{quoteState(q)}</span>
          </li>
        ))}
      </ul>
      {report.stale && !report.blocking ? (
        unpublished ? (
          <div className="banner banner-warn" role="status">
            <span className="mark" aria-hidden="true">
              !
            </span>
            <div className="body">
              This thread has unpublished edits. A refresh republishes the
              published words with new quotes, so publish or discard the edits
              first.
            </div>
          </div>
        ) : (
          <div className="row refresh-row">
            <input
              className="note"
              aria-label="refresh note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              data-action="refresh-quotes"
              className="btn btn-primary btn-mini"
              disabled={action.busy}
              onClick={() => void action.run(refresh)}
            >
              refresh {report.stale} {report.stale === 1 ? 'quote' : 'quotes'} → v
              {version + 1}
            </Button>
          </div>
        )
      ) : null}
      {report.blocking ? (
        <p className="hint" role="status">
          A republish would fail until the quotes marked above are edited or
          removed in the working copy.
        </p>
      ) : null}
      <Failure error={action.error} />
    </Card>
  );
}
/** Per device, like the picker's choices: a dismissed explanation stays dismissed here. */
const STUB_HELP_KEY = 'blygger.stub-help.dismissed';
function stubHelpDismissed() {
  try {
    return localStorage.getItem(STUB_HELP_KEY) === '1';
  } catch {
    return false;
  }
}
function dismissStubHelp() {
  try {
    localStorage.setItem(STUB_HELP_KEY, '1');
  } catch {
    // Storage blocked: the explanation just shows again next time.
  }
}
/**
 * The stub's quote, chosen in the editor (session 37). A stub opens quoting
 * the whole post; selecting text in the quoted post below writes that passage
 * under the directive (§10.1's partial grammar), and "quote whole post" takes
 * it out again. Replaces select-to-quote in the reading view, where the
 * passage had to be chosen before there was a draft to choose it for.
 *
 * The post is shown as publish would bake it whole — the preview of a lone
 * directive — so a passage chosen from it is checked against the same text.
 */
function StubQuote({
  itemId,
  target,
  text,
  edit,
  input,
  fresh,
}: {
  itemId: string;
  target: string;
  text: string;
  edit: (text: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
  fresh: boolean;
}) {
  const form = stubQuoteForm(text, target);
  // More than one passage is a running commentary; the chooser then adds
  // rather than replaces, and "quote whole post" would destroy it, so it goes.
  const passages = passageCount(text, target);
  const [open, setOpen] = useState(false);
  const [post, setPost] = useState<{ html: string; error?: string }>();
  const [chosen, setChosen] = useState<string | null>(null);
  const [help, setHelp] = useState(() => fresh && !stubHelpDismissed());
  const [never, setNever] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const helpTop = useRef<HTMLParagraphElement>(null);
  const latest = useRef({ text, chosen });
  latest.current = { text, chosen };
  useEffect(() => {
    if (!open || post) return;
    getPreview(`![[${target}]]`, itemId, 'thread')
      .then((result) =>
        setPost(
          result.errors?.length
            ? { html: '', error: result.errors[0].reason }
            : { html: result.html },
        ),
      )
      .catch((error) =>
        setPost({ html: '', error: error instanceof Error ? error.message : String(error) }),
      );
  }, [open, post, target, itemId]);
  useEffect(() => {
    if (!open) return;
    const inside = (node: Node | null) => !!node && !!panel.current?.contains(node);
    const check = () => {
      const selection = window.getSelection();
      setChosen(
        selection &&
          !selection.isCollapsed &&
          inside(selection.anchorNode) &&
          inside(selection.focusNode) &&
          selection.toString().trim()
          ? selection.toString()
          : null,
      );
    };
    document.addEventListener('selectionchange', check);
    return () => document.removeEventListener('selectionchange', check);
  }, [open]);
  const quotePassage = (how: 'replace' | 'add') => {
    const { text, chosen } = latest.current;
    if (!chosen) return;
    const caret = input.current?.selectionStart ?? text.length;
    edit(how === 'add' ? addStubQuote(text, target, chosen, caret) : withStubQuote(text, target, chosen));
    window.getSelection()?.removeAllRanges();
    setChosen(null);
    setOpen(false);
    toast(how === 'add' ? 'added another quote' : 'quoting the passage');
  };
  useEffect(() => {
    // Pressing a button must not collapse the selection it quotes. React's
    // touch listeners are passive, so these are native (as the old pill's were).
    const cleanups = (
      [
        [addButton.current, 'add'],
        [replaceButton.current, 'replace'],
      ] as const
    ).map(([element, how]) => {
      if (!element) return () => {};
      const touch = (event: TouchEvent) => {
        event.preventDefault();
        quotePassage(how);
      };
      const mouse = (event: MouseEvent) => event.preventDefault();
      element.addEventListener('touchstart', touch, { passive: false });
      element.addEventListener('mousedown', mouse);
      return () => {
        element.removeEventListener('touchstart', touch);
        element.removeEventListener('mousedown', mouse);
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  });
  const closeHelp = () => {
    if (never) dismissStubHelp();
    setHelp(false);
  };
  return (
    <div className="stub-quote" data-form={form ?? 'none'}>
      <p className="hint stub-hint">
        {form === 'whole'
          ? 'Quoting the whole post. Write above the quote for a quote post, below it for a reply, or nothing for a repost.'
          : passages > 1
            ? `Quoting ${passages} passages: a running commentary. Choose another to add it after the cursor.`
            : form === 'passage'
              ? 'Quoting a passage: the > lines under the quote. Write above it, below it, or both.'
              : 'Not quoting the post: this is a response by link.'}{' '}
        {passages <= 1 && form !== 'whole' ? (
          <button
            type="button"
            className="link-btn"
            data-action="quote-whole"
            onClick={() => edit(withStubQuote(text, target, null))}
          >
            quote whole post
          </button>
        ) : null}{' '}
        <button
          type="button"
          className="link-btn"
          data-action="choose-passage"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'done choosing' : form === 'passage' ? 'quote another passage' : 'quote a passage instead'}
        </button>{' '}
        ·{' '}
        <button
          type="button"
          className="link-btn"
          data-action="stub-help"
          onClick={() => setHelp(true)}
        >
          how stubs work
        </button>
      </p>
      {open ? (
        <div className="stub-chooser">
          <p className="hint">
            Select the passage to quote in the post below. It must be one
            unbroken stretch of the original.
          </p>
          {post?.error ? (
            <Failure error={post.error} />
          ) : post ? (
            <div ref={panel} className="stub-post preview">
              <Html html={post.html} />
            </div>
          ) : (
            <p className="hint">loading the post…</p>
          )}
          {chosen !== null ? (
            <div className="quote-pills">
              {passages > 0 ? (
                <button
                  ref={addButton}
                  type="button"
                  className="quote-pill"
                  data-action="add-passage"
                  onClick={() => quotePassage('add')}
                >
                  ❝ add as another quote
                </button>
              ) : null}
              <button
                ref={replaceButton}
                type="button"
                className={passages > 0 ? 'quote-pill quote-pill-alt' : 'quote-pill'}
                data-action="quote-passage"
                onClick={() => quotePassage('replace')}
              >
                {passages > 0 ? 'replace the first quote' : '❝ quote only this'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <Sheet
        open={help}
        onClose={closeHelp}
        title="How stubs work"
        className="stub-help"
        initialFocus={helpTop}
      >
        <div className="sheet-body prose">
          <p ref={helpTop} tabIndex={-1}>
            A stub is your post in response to one other post, and its author
            is notified. One action covers what other platforms split into
            four:
          </p>
          <table className="stub-grid">
            <thead>
              <tr>
                <th />
                <th>whole post</th>
                <th>a passage</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>your words above</th>
                <td>quote post</td>
                <td>commentary on an excerpt</td>
              </tr>
              <tr>
                <th>your words below</th>
                <td>reply</td>
                <td>inline reply</td>
              </tr>
            </tbody>
          </table>
          <p>Leave out your own words and a whole-post stub is a repost.</p>
          <p>
            <strong>Quoting part of a post.</strong> Put the passage right
            under <code>![[id]]</code>, with <code>&gt;</code> at the start of
            every line, blank ones included:
          </p>
          <pre><code>{'![[id]]\n> First paragraph you are quoting.\n>\n> Second paragraph.\n\nYour reply.'}</code></pre>
          <p>
            Or choose <em>quote a passage instead</em> and select it in the
            post. A passage must be one unbroken stretch of the original, and
            is published as plain text. Quote several passages, each under its
            own <code>![[id]]</code>, for a running commentary.
          </p>
          <p>
            Stubs are for responding: stubbing everything a source posts with
            nothing to say about it is a misuse (§10.6).
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={never}
              onChange={(event) => setNever(event.target.checked)}
            />{' '}
            don&rsquo;t show this again
          </label>
        </div>
        <div className="sheet-actions">
          <Sheet.Close className="btn btn-primary">got it</Sheet.Close>
        </div>
      </Sheet>
    </div>
  );
}
const getPreview = (
  text: string,
  id: string,
  kind: 'fragment' | 'thread',
  signal?: AbortSignal,
) =>
  unwrap(
    BlyggerApi.preview({
      client,
      body: { content_md: text, item_id: id, kind },
      signal,
    }),
  );
