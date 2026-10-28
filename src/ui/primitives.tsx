import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
  KeyboardEvent,
} from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';

const classes = (...names: Array<string | false | null | undefined>) =>
  names.filter(Boolean).join(' ');

/** Text-only helper that appears on hover and keyboard focus. */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={classes('tooltip', open && 'is-open')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      {children}
      <span className="tooltip-content" role="tooltip">{label}</span>
    </span>
  );
}

/** A button with no visible text. Its accessible name is always required. */
export function IconButton({
  label,
  children,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <Tooltip label={label}>
      <BaseButton
        {...props}
        aria-label={label}
        className={classes('icon-button', className)}
      >
        {children}
      </BaseButton>
    </Tooltip>
  );
}

export function Field({
  label,
  htmlFor,
  supportingText,
  error,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  supportingText?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={classes('field', 'system-field', error ? 'has-error' : false, className)}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="field-message error" role="alert">{error}</p> : null}
      {!error && supportingText ? <p className="field-message">{supportingText}</p> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={classes('system-input', props.className)} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={classes('system-input', props.className)} />;
}

/** Native select behavior, styled to share the form-field language. */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={classes('system-input', props.className)} />;
}

export function Checkbox({
  label,
  description,
  indeterminate = false,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className={classes('checkbox', className)}>
      <input {...props} ref={input} type="checkbox" />
      <span>
        {label}
        {description ? <span className="control-description">{description}</span> : null}
      </span>
    </label>
  );
}

export function RadioGroup({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={classes('radio-group', className)}>
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

export function Radio({
  label,
  description,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className={classes('radio', className)}>
      <input {...props} type="radio" />
      <span>
        {label}
        {description ? <span className="control-description">{description}</span> : null}
      </span>
    </label>
  );
}

export function Card({
  children,
  header,
  footer,
  className,
}: {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className={classes('card', 'system-card', className)}>
      {header ? <header className="card-header">{header}</header> : null}
      {children}
      {footer ? <footer className="card-footer">{footer}</footer> : null}
    </section>
  );
}

/** Multiple AccordionItems can be open together. */
export function Accordion({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={classes('accordion', className)}>{children}</div>;
}

export function AccordionItem({
  title,
  supportingText,
  children,
  defaultOpen = false,
  className,
}: {
  title: ReactNode;
  supportingText?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className={classes('card', 'accordion-item', className)}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary aria-expanded={open}>
        <span>{title}</span>
        {supportingText ? <span className="muted">{supportingText}</span> : null}
      </summary>
      {children}
    </details>
  );
}

export function InlineAlert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const urgent = tone === 'error';
  return (
    <div className={classes('inline-alert', `inline-alert--${tone}`, className)} role={urgent ? 'alert' : 'status'}>
      {title ? <strong className="inline-alert-title">{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="empty-state">
      {icon ? <span className="empty-state-icon" aria-hidden="true">{icon}</span> : null}
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </section>
  );
}

export function BackLink({ className, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} className={classes('back-link', 'system-back-link', className)}>{children}</a>;
}

export function Menu({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={classes('menu-list', 'system-menu', className)}>{children}</ul>;
}

export function MenuItem({
  icon,
  label,
  description,
  tone = 'default',
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon?: ReactNode;
  label: ReactNode;
  description?: ReactNode;
  tone?: 'default' | 'destructive';
}) {
  const descriptionId = useId();
  return (
    <li>
      <button
        {...props}
        aria-describedby={description ? descriptionId : undefined}
        className={classes(tone === 'destructive' && 'danger', className)}
      >
        <span className="mi" aria-hidden="true">{icon ?? ''}</span>
        <span className="ml">
          {label}
          {description ? <span className="md" id={descriptionId}>{description}</span> : null}
        </span>
      </button>
    </li>
  );
}

export function AppHeader({
  title,
  leading,
  actions,
}: {
  title: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="app-header">
      {leading ? <div className="app-header-leading">{leading}</div> : null}
      <h1>{title}</h1>
      {actions ? <div className="app-header-actions">{actions}</div> : null}
    </header>
  );
}

export function PrimaryNavigation({ children, label = 'primary navigation' }: { children: ReactNode; label?: string }) {
  return <nav className="primary-navigation" aria-label={label}>{children}</nav>;
}

export function NavigationItem({
  href,
  icon,
  label,
  current = false,
  badge,
}: {
  href: string;
  icon: ReactNode;
  label: ReactNode;
  current?: boolean;
  badge?: ReactNode;
}) {
  return (
    <a className={classes('navigation-item', current && 'is-current')} href={href} aria-current={current ? 'page' : undefined}>
      <span className="navigation-item-icon" aria-hidden="true">{icon}</span>
      <span>{label}</span>
      {badge ? <span className="navigation-item-badge">{badge}</span> : null}
    </a>
  );
}

/** A tab list; each Tab must be connected to its matching panel by the caller. */
export function Tabs({ children, label, className }: { children: ReactNode; label: string; className?: string }) {
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 || !tabs.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  };
  return <div className={classes('tabs', className)} role="tablist" aria-label={label} onKeyDown={moveFocus}>{children}</div>;
}

export function Tab({
  selected,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  return <button {...props} role="tab" aria-selected={selected} className={classes('tab', selected && 'is-selected', className)}>{children}</button>;
}
