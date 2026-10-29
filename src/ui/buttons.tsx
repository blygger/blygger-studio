import type { ComponentProps, ReactNode } from 'react';
import { forwardRef } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { Toggle as BaseToggle } from '@base-ui/react/toggle';
import { ToggleGroup as BaseToggleGroup } from '@base-ui/react/toggle-group';

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

/**
 * Studio's styled Base UI Button. Size and variant are component properties,
 * rather than separate components, matching common design-system conventions.
 */
export function Button({ size = 'standard', ...props }: ButtonProps & { size?: ButtonSize }) {
  return <SystemButton {...props} size={size} />;
}

type ToggleGroupProps = ComponentProps<typeof BaseToggleGroup>;

/** Studio's styled Base UI ToggleGroup, for a local choice among related toggles. */
export const ToggleGroup = forwardRef<HTMLDivElement, ToggleGroupProps>(function ToggleGroup({
  children,
  className,
  ...props
}, ref) {
  return (
    <BaseToggleGroup
      {...props}
      ref={ref}
      className={['toggle-group', className].filter(Boolean).join(' ')}
    >
      {children}
    </BaseToggleGroup>
  );
});

type ToggleProps = ComponentProps<typeof BaseToggle> & {
  children: ReactNode;
  /** An optional count, such as the number of drafts in a filter. */
  count?: ReactNode;
  className?: string;
};

/** A Base UI Toggle participating in a ToggleGroup. */
export function Toggle({
  children,
  count,
  className,
  ...props
}: ToggleProps) {
  return (
    <BaseToggle
      {...props}
      className={[
        'toggle-group-item',
        'toggle-group-item--standard',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="toggle-group-label">{children}</span>
      {count !== undefined ? <span className="toggle-group-count">{count}</span> : null}
    </BaseToggle>
  );
}
