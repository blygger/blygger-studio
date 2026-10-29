/*
 * Sheets — the studio's replacements for window.confirm / prompt / alert, and
 * the action-menu sheet. A bottom sheet on a phone, a centred dialog at
 * ≥900px (studio.css). All are base-ui Dialogs, so each is role="dialog",
 * named by its title, focus-trapped, and closed by Escape or the backdrop.
 *
 * Two ways in:
 *  - imperative: `await confirm({...})`, `await prompt({...})`,
 *    `await menu({...})`, `toast('...')` from any handler. They render through
 *    the single <SheetHost/> that Layout mounts; calls made while one sheet is
 *    open queue behind it.
 *  - declarative: <Sheet open onClose title>…</Sheet> for a sheet with its own
 *    content (a publish flow, an inspector).
 */
import type { ReactNode } from 'react';
import { useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@base-ui/react/button';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Toast as BaseToast } from '@base-ui/react/toast';
import { Menu as SystemMenu, MenuItem } from './primitives.tsx';

export interface ConfirmOptions {
  /** The question. Also the dialog's accessible name. */
  title: string;
  /** Further explanation under the title. */
  body?: ReactNode;
  /** Label of the accepting button (default "ok"). */
  ok?: string;
  /** Label of the declining button (default "cancel"). */
  cancel?: string;
  /** Paint the accepting button as destructive. */
  danger?: boolean;
}
export interface PromptOptions {
  title: string;
  body?: ReactNode;
  /** Accessible name of the text field (defaults to the title). */
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  /** Use a multi-line textarea instead of a single-line input. */
  multiline?: boolean;
  ok?: string;
  cancel?: string;
}
export interface MenuRow {
  /** Returned by menu() when this row is chosen (defaults to the label). */
  key?: string;
  icon?: ReactNode;
  label: string;
  description?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Runs after the sheet closes. */
  onSelect?: () => void;
}
export interface MenuOptions {
  title?: string;
  /** Falsy entries are skipped, so rows can be written `cond && {...}`. */
  rows: (MenuRow | false | null | undefined)[];
}
export interface ToastOptions {
  /** ms on screen (default 2400). */
  duration?: number;
  /** "ok" for a completed action the person asked for (green); default is neutral. */
  tone?: 'ok';
}

type Request =
  | { id: number; kind: 'confirm'; options: ConfirmOptions; resolve: (v: boolean) => void }
  | { id: number; kind: 'prompt'; options: PromptOptions; resolve: (v: string | null) => void }
  | { id: number; kind: 'menu'; options: MenuOptions; resolve: (v: string | null) => void };
let queue: Request[] = [];
let nextId = 1;
// A global manager preserves Studio's imperative toast() API while Base UI
// owns announcement, timeout, dismissal, and stacking behavior.
const toastManager = BaseToast.createToastManager();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function push(request: Request) {
  queue = [...queue, request];
  emit();
}
function settle(id: number) {
  queue = queue.filter((request) => request.id !== id);
  emit();
}

/** A yes/no question. Resolves true on ok, false on cancel, Escape or backdrop. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) =>
    push({ id: nextId++, kind: 'confirm', options, resolve }),
  );
}
/** Ask for text. Resolves the text on ok (possibly ""), null on cancel. */
export function prompt(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) =>
    push({ id: nextId++, kind: 'prompt', options, resolve }),
  );
}
/** An action menu. Resolves the chosen row's key (or label), null if dismissed. */
export function menu(options: MenuOptions): Promise<string | null> {
  return new Promise((resolve) =>
    push({ id: nextId++, kind: 'menu', options, resolve }),
  );
}
/** A short, non-blocking message at the bottom of the screen (replaces alert). */
export function toast(message: string, options: ToastOptions = {}) {
  toastManager.add({
    description: message,
    timeout: options.duration ?? 2400,
    type: options.tone,
    priority: 'low',
  });
}

/**
 * A sheet with arbitrary content. `onClose` fires on Escape, backdrop or a
 * <Sheet.Close>; the title names the dialog.
 */
export function Sheet({
  open,
  onClose,
  title,
  description,
  children,
  className,
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Extra class on the popup (e.g. "dialog-popup"). */
  className?: string;
  initialFocus?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="backdrop" />
        <BaseDialog.Popup
          className={className ? `sheet ${className}` : 'sheet'}
          initialFocus={initialFocus}
        >
          <BaseDialog.Title className="sheet-title">{title}</BaseDialog.Title>
          {description ? (
            <BaseDialog.Description className="sheet-body" render={<div />}>
              {description}
            </BaseDialog.Description>
          ) : null}
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
/** A button that closes the enclosing <Sheet>. */
Sheet.Close = function SheetClose({
  children,
  className = 'btn btn-ghost',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseDialog.Close render={<Button className={className} />}>
      {children}
    </BaseDialog.Close>
  );
};
/** The design-system name; Sheet remains as the established app API. */
export const Dialog = Sheet;

function ConfirmSheet({
  request,
}: {
  request: Extract<Request, { kind: 'confirm' }>;
}) {
  const { options } = request;
  const ok = useRef<HTMLButtonElement>(null);
  const done = (value: boolean) => {
    settle(request.id);
    request.resolve(value);
  };
  return (
    <Sheet
      open
      onClose={() => done(false)}
      title={options.title}
      description={options.body}
      className="sheet-confirm"
      initialFocus={ok}
    >
      <div className="sheet-actions">
        <Button
          ref={ok}
          data-sheet="ok"
          className={`btn ${options.danger ? 'btn-danger' : 'btn-primary'}`}
          onClick={() => done(true)}
        >
          {options.ok ?? 'ok'}
        </Button>
        <Button
          data-sheet="cancel"
          className="btn btn-ghost"
          onClick={() => done(false)}
        >
          {options.cancel ?? 'cancel'}
        </Button>
      </div>
    </Sheet>
  );
}
function PromptSheet({
  request,
}: {
  request: Extract<Request, { kind: 'prompt' }>;
}) {
  const { options } = request;
  const [value, setValue] = useState(options.defaultValue ?? '');
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const done = (result: string | null) => {
    settle(request.id);
    request.resolve(result);
  };
  return (
    <Sheet
      open
      onClose={() => done(null)}
      title={options.title}
      description={options.body}
      className="sheet-prompt"
      initialFocus={field}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          done(value);
        }}
      >
        {options.multiline ? (
          <textarea
            ref={field}
            className="sheet-field"
            aria-label={options.label ?? options.title}
            placeholder={options.placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : (
          <input
            ref={field}
            type="text"
            className="sheet-field"
            aria-label={options.label ?? options.title}
            placeholder={options.placeholder}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        <div className="sheet-actions">
          <Button type="submit" data-sheet="ok" className="btn btn-primary">
            {options.ok ?? 'ok'}
          </Button>
          <Button
            type="button"
            data-sheet="cancel"
            className="btn btn-ghost"
            onClick={() => done(null)}
          >
            {options.cancel ?? 'cancel'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
function MenuSheet({
  request,
}: {
  request: Extract<Request, { kind: 'menu' }>;
}) {
  const rows = request.options.rows.filter((row): row is MenuRow => !!row);
  const done = (row: MenuRow | null) => {
    settle(request.id);
    request.resolve(row ? (row.key ?? row.label) : null);
    row?.onSelect?.();
  };
  return (
    <BaseDialog.Root
      open
      onOpenChange={(value) => {
        if (!value) done(null);
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="backdrop" />
        <BaseDialog.Popup
          className="sheet sheet-menu"
          aria-label={request.options.title ? undefined : 'actions'}
        >
          {request.options.title ? (
            <BaseDialog.Title className="sheet-title">
              {request.options.title}
            </BaseDialog.Title>
          ) : null}
          <SystemMenu>
            {rows.map((row) => (
              <MenuItem
                key={row.key ?? row.label}
                icon={row.icon}
                label={row.label}
                description={row.description}
                tone={row.danger ? 'destructive' : 'default'}
                disabled={row.disabled}
                onClick={() => done(row)}
              />
            ))}
          </SystemMenu>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
function ToastList() {
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((item) => (
    <BaseToast.Root key={item.id} toast={item} className="toast" data-tone={item.type}>
      <BaseToast.Content className="toast-content">
        <BaseToast.Description className="toast-message" />
        {/* The ✕ is drawn by CSS so the toast's text stays exactly its message. */}
        <BaseToast.Close className="toast-x" aria-label="dismiss message" />
      </BaseToast.Content>
    </BaseToast.Root>
  ));
}

function ToastHost() {
  return (
    <BaseToast.Provider timeout={2400} limit={1} toastManager={toastManager}>
      <BaseToast.Portal>
        <BaseToast.Viewport className="toast-viewport">
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  );
}

/** Mount once (Layout does). Renders the head of the sheet queue and the toast. */
export function SheetHost() {
  const head = useSyncExternalStore(subscribe, () => queue[0]);
  return (
    <>
      {head?.kind === 'confirm' ? (
        <ConfirmSheet key={head.id} request={head} />
      ) : head?.kind === 'prompt' ? (
        <PromptSheet key={head.id} request={head} />
      ) : head?.kind === 'menu' ? (
        <MenuSheet key={head.id} request={head} />
      ) : null}
      <ToastHost />
    </>
  );
}
