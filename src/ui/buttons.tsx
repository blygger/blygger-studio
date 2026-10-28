import type { ComponentProps, KeyboardEvent, ReactNode } from 'react';
import { forwardRef } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';

type BaseButtonProps = Omit<
  ComponentProps<typeof BaseButton>,
  'children' | 'className'
>;

export type ButtonVariant = 'default' | 'primary' | 'plain';
export type ButtonSize = 'standard' | 'medium' | 'small';

type ButtonProps = BaseButtonProps & {
  children: ReactNode;
  /** Default is a quiet secondary action; primary is the committed action. */
  variant?: ButtonVariant;
  /** Shows progress and prevents a second submission. */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  className?: string;
};

function SystemButton({
  size,
  children,
  variant = 'default',
  loading = false,
  leadingIcon,
  trailingIcon,
  className,
  disabled,
  ...props
}: ButtonProps & { size: ButtonSize }) {
  return (
    <BaseButton
      {...props}
      className={[
        'button',
        `button-${size}`,
        `button--${variant}`,
        loading ? 'is-loading' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="button-spinner" aria-hidden="true" /> : null}
      {leadingIcon ? <span className="button-icon" aria-hidden="true">{leadingIcon}</span> : null}
      <span className="button-label">{children}</span>
      {trailingIcon ? <span className="button-icon" aria-hidden="true">{trailingIcon}</span> : null}
    </BaseButton>
  );
}

/** Main form and sheet actions. */
export function ButtonStandard(props: ButtonProps) {
  return <SystemButton {...props} size="standard" />;
}

/** Inline actions such as Compose's save and publish controls. */
export function ButtonMedium(props: ButtonProps) {
  return <SystemButton {...props} size="medium" />;
}

/** Compact actions that sit alongside dense UI. */
export function ButtonSmall(props: ButtonProps) {
  return <SystemButton {...props} size="small" />;
}

type ToggleGroupProps = ComponentProps<'div'>;

/** A named, styled container for related selectable buttons. */
export const ToggleGroup = forwardRef<HTMLDivElement, ToggleGroupProps>(function ToggleGroup({
  children,
  className,
  role,
  onKeyDown,
  ...props
}, ref) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0 || !items.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
      (current + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
    items[next]?.click();
  };
  return (
    <div
      {...props}
      ref={ref}
      role={role ?? 'radiogroup'}
      onKeyDown={handleKeyDown}
      className={['toggle-group', className].filter(Boolean).join(' ')}
    >
      {children}
    </div>
  );
});

type ToggleGroupItemProps = BaseButtonProps & {
  children: ReactNode;
  selected: boolean;
  /** An optional count, such as the number of drafts in a filter. */
  count?: ReactNode;
  className?: string;
};

/**
 * An option inside ToggleGroup. Use role="radio" + aria-checked for mutually
 * exclusive choices (such as Fragment / Thread).
 */
export function ToggleGroupItem({
  children,
  selected,
  count,
  className,
  role,
  disabled,
  ...props
}: ToggleGroupItemProps) {
  return (
    <BaseButton
      {...props}
      role={role}
      disabled={disabled}
      aria-checked={role === 'radio' ? selected : undefined}
      tabIndex={role === 'radio' ? (selected ? 0 : -1) : undefined}
      data-selected={selected ? 'true' : 'false'}
      className={[
        'toggle-group-item',
        'toggle-group-item--standard',
        selected ? 'is-selected' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="button-label">{children}</span>
      {count !== undefined ? <span className="toggle-group-count">{count}</span> : null}
    </BaseButton>
  );
}
