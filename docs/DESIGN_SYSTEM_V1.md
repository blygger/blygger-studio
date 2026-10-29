# Blygger Studio design system — V1

This first pass turns the existing Studio visual language into reusable, accessible
primitives. It is intentionally an extraction, not a visual redesign. Foundations
(semantic colour tokens, type scale, spacing, radii, shadows, and icon rules) are
the next commit.

## Buttons

`ButtonStandard`, `ButtonMedium`, and `ButtonSmall` share these properties:

- **Variant:** `Default (Secondary)`, `Primary`, `Plain`
- **State:** `Default (Enabled)`, `Disabled`, `Loading`
- **Icon:** none, leading, trailing

Use `Primary` for the one committed action in a context; use `Default
(Secondary)` for supporting actions; and use `Plain` for quiet inline actions.
Buttons use native disabled behavior. A loading button keeps its label, prevents a
second submission, and exposes `aria-busy`.

`IconButton` is a separate Standard-size component. It requires an accessible
label and provides a short tooltip on hover and keyboard focus. Its minimum hit
target is 40px. A selected IconButton is deferred until the existing thumbs UI is
addressed.

## Selection controls

`ToggleGroup` is a single-choice, Standard-size control with label-only items.
`ToggleGroupItem` variants are `Default (Unselected)`, `Selected`, and
`Disabled`; an optional trailing count is supported. It uses radio semantics:
one item is selected, one item is in the tab sequence, and Arrow keys, Home, and
End move the selection. Use it for in-place choices such as Fragment/Thread,
Draft/Preview, item filters, reading lenses, and the picker source.

`Tabs` are for in-page views rather than settings. `Tab` variants are
`Default (Unselected)`, `Selected`, and `Disabled`. They use tab/tablist
semantics with a single selected tab and keyboard focus movement; each use must
connect tabs to its corresponding panel.

Use `Checkbox` for independent, multi-select choices. It supports Unchecked,
Checked, Indeterminate, and Disabled; indeterminate is reserved for a parent
"select all" state. `RadioGroup` and `Radio` are vertical-only in V1, with an
optional supporting-text slot on each radio, and use native fieldset/radio
semantics. Switches are intentionally deferred to a future settings/onboarding
change.

## Surfaces, feedback, and navigation

- `Card` is a static content surface with optional header and footer. Do not turn
  a generic card into a click target.
- `Accordion` permits multiple `AccordionItem`s to be open. Each item has a
  title, optional supporting text, and collapsed/expanded state. Do not hide a
  required action inside an accordion.
- `Field` is a code/documentation pattern: persistent label, one control,
  optional help text or error (the error replaces help). `TextInput`, `Textarea`,
  and native `Select` provide the standard controls. Inputs use Default, Focus,
  Error, and Disabled states; read-only is not in V1.
- `Dialog` is the umbrella pattern: V1 supports the existing Modal and Sheet
  presentations. It has a title, traps focus, closes with Escape, and returns
  focus to its trigger. `Menu`/`MenuItem` is the action-list pattern inside a
  Sheet, not an ARIA application menu.
- `InlineAlert` supports Info, Success, Warning, and Error with optional support
  text. A future site-wide message will be named `GlobalBanner` or
  `GlobalAlert`.
- `EmptyState` has an optional icon, required title, optional supporting text,
  and at most one primary action. `BackLink` is a destination link, not browser
  history. Breadcrumb is deferred.
- `AppHeader` and `PrimaryNavigation`/`NavigationItem` provide the shared shell.
  The same navigation items appear as a desktop navigation rail and mobile bottom
  navigation; current location uses `aria-current="page"`.

## Deferred to V2 or a later focused change

- Loading indicator (there is no existing standalone indicator)
- Switch for immediate settings/onboarding choices
- Global banner/alert
- Breadcrumb
- Chip/tag pattern
- TK Highlight control conversion to a checkbox
- Foundations and their Figma variables
